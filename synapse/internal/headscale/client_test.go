package headscale

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreatePreAuthKey_HappyPath(t *testing.T) {
	var gotAuth, gotPath, gotCT string
	var gotBody map[string]any
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		gotCT = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"preAuthKey":{"id":"42","key":"plaintext-key","user":{"id":"1","name":"synapse"},"reusable":false,"ephemeral":false}}`))
	}))
	defer tsrv.Close()

	key, err := New(tsrv.URL, "api-key-abc").CreatePreAuthKey(context.Background(), CreatePreAuthKeyOpts{
		User:     "synapse",
		Reusable: false,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key.Key != "plaintext-key" {
		t.Errorf("key: got %q", key.Key)
	}
	if gotAuth != "Bearer api-key-abc" {
		t.Errorf("auth: got %q", gotAuth)
	}
	if gotPath != "/api/v1/preauthkey" {
		t.Errorf("path: got %q", gotPath)
	}
	if gotCT != "application/json" {
		t.Errorf("content-type: got %q", gotCT)
	}
	if gotBody["user"] != "synapse" {
		t.Errorf("body.user: got %v", gotBody["user"])
	}
	if _, ok := gotBody["expiration"]; !ok {
		t.Errorf("body.expiration should be set (default 1h)")
	}
}

func TestCreatePreAuthKey_EmptyKey_Errors(t *testing.T) {
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"preAuthKey":{"id":"42","key":""}}`))
	}))
	defer tsrv.Close()
	_, err := New(tsrv.URL, "k").CreatePreAuthKey(context.Background(), CreatePreAuthKeyOpts{User: "synapse"})
	if err == nil || !strings.Contains(err.Error(), "empty key") {
		t.Fatalf("expected empty-key error, got %v", err)
	}
}

func TestCreatePreAuthKey_401(t *testing.T) {
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"code":"unauthorized"}`, http.StatusUnauthorized)
	}))
	defer tsrv.Close()
	_, err := New(tsrv.URL, "bad").CreatePreAuthKey(context.Background(), CreatePreAuthKeyOpts{User: "synapse"})
	var he *Error
	if !errors.As(err, &he) {
		t.Fatalf("expected *headscale.Error, got %T", err)
	}
	if !he.Unauthorized() {
		t.Errorf("Unauthorized() should be true on 401")
	}
}

func TestListNodes_FiltersByUser(t *testing.T) {
	var gotQuery string
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"nodes":[{"id":"1","name":"vps-eu-1","ipAddresses":["100.64.0.5"]}]}`))
	}))
	defer tsrv.Close()

	nodes, err := New(tsrv.URL, "k").ListNodes(context.Background(), "synapse")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(gotQuery, "user=synapse") {
		t.Errorf("query: got %q", gotQuery)
	}
	if len(nodes) != 1 || nodes[0].IPAddresses[0] != "100.64.0.5" {
		t.Errorf("nodes: got %+v", nodes)
	}
}

func TestDeleteNode_RoundTrip(t *testing.T) {
	var gotMethod, gotPath string
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer tsrv.Close()
	if err := New(tsrv.URL, "k").DeleteNode(context.Background(), "42"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/api/v1/node/42" {
		t.Errorf("got %s %s", gotMethod, gotPath)
	}
}

func TestExpireNode_404(t *testing.T) {
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"code":"not_found"}`, http.StatusNotFound)
	}))
	defer tsrv.Close()
	err := New(tsrv.URL, "k").ExpireNode(context.Background(), "999")
	var he *Error
	if !errors.As(err, &he) {
		t.Fatalf("expected *headscale.Error, got %T", err)
	}
	if !he.NotFound() {
		t.Errorf("NotFound() should be true on 404")
	}
}

func TestCreateUser_RoundTrip(t *testing.T) {
	tsrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "synapse" {
			t.Errorf("body.name: got %v", body["name"])
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"user":{"id":"1","name":"synapse"}}`))
	}))
	defer tsrv.Close()
	u, err := New(tsrv.URL, "k").CreateUser(context.Background(), "synapse")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if u.Name != "synapse" {
		t.Errorf("name: got %q", u.Name)
	}
}

func TestClient_NoBaseURL_ReturnsError(t *testing.T) {
	_, err := New("", "k").CreatePreAuthKey(context.Background(), CreatePreAuthKeyOpts{User: "u"})
	if err == nil || !strings.Contains(err.Error(), "baseURL") {
		t.Fatalf("expected baseURL error, got %v", err)
	}
}

func TestClient_NoAPIKey_ReturnsError(t *testing.T) {
	_, err := New("http://x", "").CreatePreAuthKey(context.Background(), CreatePreAuthKeyOpts{User: "u"})
	if err == nil || !strings.Contains(err.Error(), "apiKey") {
		t.Fatalf("expected apiKey error, got %v", err)
	}
}
