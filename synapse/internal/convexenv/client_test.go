package convexenv

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUpdate_EmptyChanges_Noop(t *testing.T) {
	called := false
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer tsrv.Close()
	if err := NewClient().Update(context.Background(), tsrv.URL, "k", nil); err != nil {
		t.Fatalf("empty changes should return nil, got %v", err)
	}
	if called {
		t.Fatalf("empty changes should NOT trigger an HTTP call")
	}
}

func TestUpdate_HappyPath_BatchAndHeaders(t *testing.T) {
	var gotPath, gotAuth, gotCT string
	var gotBody []byte
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer tsrv.Close()

	changes := []Change{Set("A", "1"), Set("B", "2"), Unset("OLD")}
	if err := NewClient().Update(context.Background(), tsrv.URL, "key-xyz", changes); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotPath != "/api/update_environment_variables" {
		t.Errorf("path: got %q", gotPath)
	}
	if gotAuth != "Convex key-xyz" {
		t.Errorf("auth: got %q", gotAuth)
	}
	if gotCT != "application/json" {
		t.Errorf("content-type: got %q", gotCT)
	}

	// Verify the wire shape: { "changes": [{name, value | null}, ...] }
	var parsed struct {
		Changes []struct {
			Name  string  `json:"name"`
			Value *string `json:"value"`
		} `json:"changes"`
	}
	if err := json.Unmarshal(gotBody, &parsed); err != nil {
		t.Fatalf("unmarshal body: %v (body=%s)", err, gotBody)
	}
	if len(parsed.Changes) != 3 {
		t.Fatalf("want 3 changes, got %d", len(parsed.Changes))
	}
	if parsed.Changes[0].Name != "A" || parsed.Changes[0].Value == nil || *parsed.Changes[0].Value != "1" {
		t.Errorf("changes[0]: got %+v", parsed.Changes[0])
	}
	if parsed.Changes[2].Name != "OLD" || parsed.Changes[2].Value != nil {
		t.Errorf("unset must serialize as null: got %+v", parsed.Changes[2])
	}
}

func TestUpdate_401_ReturnsUnauthorizedError(t *testing.T) {
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"code":"unauthorized","message":"bad key"}`, http.StatusUnauthorized)
	}))
	defer tsrv.Close()
	err := NewClient().Update(context.Background(), tsrv.URL, "bad", []Change{Set("A", "1")})
	var ce *Error
	if !errors.As(err, &ce) {
		t.Fatalf("expected *convexenv.Error, got %T %v", err, err)
	}
	if !ce.Unauthorized() {
		t.Errorf("Unauthorized() should be true on 401")
	}
}

func TestUpdate_500_WrapsBody(t *testing.T) {
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer tsrv.Close()
	err := NewClient().Update(context.Background(), tsrv.URL, "k", []Change{Set("A", "1")})
	if err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("expected wrapped 500 error, got %v", err)
	}
}

func TestList_HappyPath_DecodesEnvelope(t *testing.T) {
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/list_environment_variables" {
			t.Errorf("path: got %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Convex k" {
			t.Errorf("auth missing")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"environment_variables":{"A":"1","B":"two"}}`))
	}))
	defer tsrv.Close()
	got, err := NewClient().List(context.Background(), tsrv.URL, "k")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got["A"] != "1" || got["B"] != "two" {
		t.Errorf("decoded wrong: %+v", got)
	}
}

func TestFilterManaged_DropsCanonicalNames(t *testing.T) {
	in := []Change{
		Set("BETTER_AUTH_SECRET", "x"),
		Set("CONVEX_SELF_HOSTED_URL", "https://..."),
		Set("NEXT_PUBLIC_CONVEX_URL", "https://..."),
		Set("NEXT_PUBLIC_CONVEX_SITE_URL", "https://..."),
		Set("CONVEX_DEPLOY_KEY", "..."),
		Set("CONVEX_DEPLOYMENT", "..."),
		Set("CONVEX_DEPLOYMENT_TOKEN", "..."),
		Set("CONVEX_SELF_HOSTED_ADMIN_KEY", "..."),
		Set("DATABASE_URL", "y"),
	}
	keep, dropped := FilterManaged(in)
	if len(keep) != 2 || keep[0].Name != "BETTER_AUTH_SECRET" || keep[1].Name != "DATABASE_URL" {
		t.Errorf("keep: %+v", keep)
	}
	if len(dropped) != 7 {
		t.Errorf("dropped count: got %d want 7 (full managed-name set)", len(dropped))
	}
}
