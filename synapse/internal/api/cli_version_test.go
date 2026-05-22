package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Per-test stub of the npm registry. Returns a fixed version and counts
// how many real fetches landed — that's how we verify the 15-minute
// cache short-circuits subsequent requests.
type fakeRegistry struct {
	version string
	calls   int64
	status  int
}

func (f *fakeRegistry) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&f.calls, 1)
		if f.status != 0 && f.status != http.StatusOK {
			http.Error(w, "boom", f.status)
			return
		}
		// Path must look like /<pkg>/latest where the scoped slash is
		// %-encoded. Spot-check the contract to catch URL-building
		// regressions in fetchLatest.
		if !strings.HasSuffix(r.URL.Path, "/latest") {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		fmt.Fprintf(w, `{"version":"%s","name":"@iann29/synapse"}`, f.version)
	}
}

func TestCLIVersion_HappyPath(t *testing.T) {
	fake := &fakeRegistry{version: "1.8.6"}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	h := &CLIVersionHandler{
		PackageName:  "@iann29/synapse",
		RegistryBase: srv.URL,
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/cli_latest_version", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", rec.Code)
	}
	var resp cliVersionResp
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Latest != "1.8.6" {
		t.Errorf("latest: got %q want 1.8.6", resp.Latest)
	}
	if resp.InstallCommand != "npm install -g @iann29/synapse@1.8.6" {
		t.Errorf("installCommand: got %q", resp.InstallCommand)
	}
	if resp.FromCache {
		t.Errorf("first call should not be fromCache")
	}
	if resp.PackageName != "@iann29/synapse" {
		t.Errorf("packageName: got %q", resp.PackageName)
	}
}

func TestCLIVersion_CacheShortCircuits(t *testing.T) {
	fake := &fakeRegistry{version: "1.8.6"}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	h := &CLIVersionHandler{RegistryBase: srv.URL}

	// Two back-to-back GETs — registry should only see one.
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/cli_latest_version", nil)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("iter %d: status %d", i, rec.Code)
		}
	}
	if got := atomic.LoadInt64(&fake.calls); got != 1 {
		t.Errorf("registry calls: got %d want 1 (cache should have hit on 2nd)", got)
	}

	// Second call's payload must carry fromCache=true.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/cli_latest_version", nil))
	var resp cliVersionResp
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if !resp.FromCache {
		t.Errorf("expected fromCache=true on cached read")
	}
}

func TestCLIVersion_RegistryDown_NoCache_ReturnsError(t *testing.T) {
	fake := &fakeRegistry{status: http.StatusServiceUnavailable}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	h := &CLIVersionHandler{RegistryBase: srv.URL}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/cli_latest_version", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200 (soft-failure semantic)", rec.Code)
	}
	var resp cliVersionResp
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Error == "" {
		t.Errorf("expected non-empty error on registry failure")
	}
	if resp.Latest != "" {
		t.Errorf("expected empty latest on registry failure")
	}
}

func TestCLIVersion_RegistryDown_StaleCacheServed(t *testing.T) {
	fake := &fakeRegistry{version: "1.8.6"}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	h := &CLIVersionHandler{RegistryBase: srv.URL}

	// First call populates the cache.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/cli_latest_version", nil))

	// Flip registry to failure; bust the cache; second call must
	// serve the stale data AND include a soft error.
	fake.status = http.StatusInternalServerError
	h.mu.Lock()
	h.cachedAt = h.cachedAt.Add(-30 * cliVersionCacheTTL)
	h.mu.Unlock()

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/cli_latest_version", nil))

	var resp cliVersionResp
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Latest != "1.8.6" {
		t.Errorf("expected stale cache to surface 1.8.6, got %q", resp.Latest)
	}
	if resp.Error == "" {
		t.Errorf("expected error annotation alongside stale cache")
	}
}

func TestCLIVersion_RefreshRespects30sFloor(t *testing.T) {
	fake := &fakeRegistry{version: "1.8.6"}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	h := &CLIVersionHandler{RegistryBase: srv.URL}

	// Prime cache.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/cli_latest_version", nil))
	if got := atomic.LoadInt64(&fake.calls); got != 1 {
		t.Fatalf("warmup: calls %d", got)
	}

	// Immediate refresh — within the 30s floor, must serve the cached
	// payload without hitting the registry.
	rec = httptest.NewRecorder()
	h.RefreshHandler(rec, httptest.NewRequest(http.MethodPost, "/v1/cli_latest_version/refresh", nil))
	if got := atomic.LoadInt64(&fake.calls); got != 1 {
		t.Errorf("refresh within floor should not hit registry, got %d calls", got)
	}

	// Move cachedAt 1min into the past — refresh must hit the registry.
	h.mu.Lock()
	h.cachedAt = h.cachedAt.Add(-time.Minute)
	h.mu.Unlock()
	rec = httptest.NewRecorder()
	h.RefreshHandler(rec, httptest.NewRequest(http.MethodPost, "/v1/cli_latest_version/refresh", nil))
	if got := atomic.LoadInt64(&fake.calls); got != 2 {
		t.Errorf("refresh past floor should hit registry, got %d calls", got)
	}
}
