package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// CLIVersionHandler exposes a public probe that returns the latest
// published version of @iann29/synapse on the npm registry. Used by
// the dashboard to show "Latest CLI: vX.Y.Z" with a copy-friendly
// install command — operators discover the CLI from the panel without
// needing to know the package name a priori.
//
// Public + unauthenticated: the same operator who's logged in to use
// the dashboard is the operator who'd run the CLI; no benefit to
// gating + would block install discoverability behind admin role.
// Cached server-side so npm registry never sees more than one fetch
// per cacheTTL across all connected dashboards.
//
// Mirrors AdminHandler.versionCheck's caching pattern (15-min TTL,
// lastKnown fallback on registry errors, 30-second floor on
// /refresh bursts) so behaviour is consistent across "host version"
// and "CLI version" surfaces.
type CLIVersionHandler struct {
	// PackageName is the npm package to track. Defaults to
	// "@iann29/synapse"; tests inject a fake.
	PackageName string

	// RegistryBase is the npm registry root. Defaults to
	// "https://registry.npmjs.org"; tests inject a stub server URL.
	RegistryBase string

	// HTTPClient lets tests intercept the registry fetch. nil ⇒
	// http.DefaultClient. Production has no reason to override.
	HTTPClient *http.Client

	// Cache state — shared across all in-flight requests so npm sees
	// at most one fetch per cliVersionCacheTTL.
	mu       sync.Mutex
	cached   *cliVersionPayload
	cachedAt time.Time
	fromAPI  bool
}

const (
	cliVersionCacheTTL     = 15 * time.Minute
	cliRegistryTimeout     = 6 * time.Second
	cliVersionRefreshFloor = 30 * time.Second
)

// cliVersionPayload is the slice of the npm "latest" tag manifest we
// care about. The registry returns a much larger object; we only need
// the version string. Decoded directly into our response shape so
// there's no second mapping layer.
type cliVersionPayload struct {
	Version string `json:"version"`
}

type cliVersionResp struct {
	PackageName    string `json:"packageName"`
	Latest         string `json:"latest,omitempty"`
	InstallCommand string `json:"installCommand,omitempty"`
	FetchedAt      string `json:"fetchedAt,omitempty"`
	CacheExpiresAt string `json:"cacheExpiresAt,omitempty"`
	FromCache      bool   `json:"fromCache,omitempty"`
	Error          string `json:"error,omitempty"`
}

func (h *CLIVersionHandler) packageName() string {
	if h.PackageName == "" {
		return "@iann29/synapse"
	}
	return h.PackageName
}

func (h *CLIVersionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	resp := cliVersionResp{PackageName: h.packageName()}
	payload, fetchedAt, fromCache, err := h.fetchLatest(r.Context())
	if err != nil && payload == nil {
		// Never fetched and now offline. Still 200 so the dashboard can
		// render a "best-effort" panel; the error string lets the UI
		// surface the cause.
		resp.Error = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.FromCache = fromCache
	if payload != nil {
		resp.Latest = payload.Version
		resp.InstallCommand = fmt.Sprintf("npm install -g %s@%s", h.packageName(), payload.Version)
		resp.FetchedAt = fetchedAt.UTC().Format(time.RFC3339)
		resp.CacheExpiresAt = fetchedAt.Add(cliVersionCacheTTL).UTC().Format(time.RFC3339)
	}
	if err != nil {
		// Soft error — cache hit but registry was unreachable on
		// last refresh attempt. Don't return the stale-cache lie as
		// gospel; let the UI know.
		resp.Error = err.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

// RefreshHandler bypasses the cache (subject to a 30s floor so a
// stuck operator clicking "Check now" can't DOS npm). Exposed on a
// separate route the same way admin/version_check_refresh works.
func (h *CLIVersionHandler) RefreshHandler(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	// Floor: any cache fresher than 30s wins; we return whatever the
	// existing cache has and skip the registry hit.
	if h.cached != nil && time.Since(h.cachedAt) < cliVersionRefreshFloor {
		h.mu.Unlock()
		h.ServeHTTP(w, r)
		return
	}
	h.cached = nil
	h.cachedAt = time.Time{}
	h.mu.Unlock()
	h.ServeHTTP(w, r)
}

func (h *CLIVersionHandler) fetchLatest(ctx context.Context) (*cliVersionPayload, time.Time, bool, error) {
	h.mu.Lock()
	if h.cached != nil && time.Since(h.cachedAt) < cliVersionCacheTTL {
		p := h.cached
		at := h.cachedAt
		h.mu.Unlock()
		return p, at, true, nil
	}
	h.mu.Unlock()

	base := h.RegistryBase
	if base == "" {
		base = "https://registry.npmjs.org"
	}
	// /-/package/.../dist-tags is cheaper than the full manifest but
	// not available for scoped packages on the public registry. The
	// `<pkg>/latest` endpoint returns the package.json of the latest
	// tag — small enough to parse the .version field cheaply.
	apiURL := strings.TrimRight(base, "/") + "/" + strings.Replace(h.packageName(), "/", "%2F", 1) + "/latest"

	cctx, cancel := context.WithTimeout(ctx, cliRegistryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return h.lastKnown(), time.Time{}, false, err
	}
	req.Header.Set("Accept", "application/json")

	client := h.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return h.lastKnown(), time.Time{}, false, fmt.Errorf("npm fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		// Package not published yet (or wrong name in config). Treat
		// as a real error so the UI shows it; don't poison the cache
		// with a "no version" entry.
		return h.lastKnown(), time.Time{}, false, errors.New("npm returned 404 — package not found")
	}
	if resp.StatusCode != http.StatusOK {
		return h.lastKnown(), time.Time{}, false, fmt.Errorf("npm HTTP %d", resp.StatusCode)
	}

	var payload cliVersionPayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return h.lastKnown(), time.Time{}, false, fmt.Errorf("decode npm response: %w", err)
	}
	if payload.Version == "" {
		return h.lastKnown(), time.Time{}, false, errors.New("npm returned no version")
	}

	now := time.Now()
	h.mu.Lock()
	h.cached = &payload
	h.cachedAt = now
	h.fromAPI = true
	h.mu.Unlock()
	return &payload, now, false, nil
}

func (h *CLIVersionHandler) lastKnown() *cliVersionPayload {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.cached
}
