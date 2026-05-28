package synapsetest

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Iann29/synapse/internal/headscale"
)

// Phase 5 (Remote Hosts v1.18+): the one-click bundle endpoint that
// powers the dashboard's "Setup remote install" button. Exercises the
// happy path + the three documented failure modes (Headscale disabled,
// non-admin caller, host not found).

type remoteSetupBundleResp struct {
	AdoptionToken      string `json:"adoptionToken"`
	HeadscaleAuthKey   string `json:"headscaleAuthKey"`
	ControlURL         string `json:"controlUrl"`
	HeadscaleServerURL string `json:"headscaleServerUrl"`
	OneLiner           string `json:"oneLiner"`
	ExpiresAt          string `json:"expiresAt"`
}

// stubHeadscale spins up an httptest.Server that answers
// CreatePreAuthKey with a deterministic plaintext key. Returns the
// server + a *headscale.Client pointed at it; both are released via
// t.Cleanup. callsPtr (when non-nil) is incremented once per
// CreatePreAuthKey hit so tests can assert exact call counts.
func stubHeadscale(t *testing.T, callsPtr *int) (*httptest.Server, *headscale.Client) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/preauthkey" {
			if callsPtr != nil {
				*callsPtr++
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"preAuthKey":{"id":"1","key":"hs-key-xyz","user":{"id":"1","name":"synapse","createdAt":"2024-01-01T00:00:00Z"},"reusable":false,"ephemeral":false,"used":false,"expiration":"2099-01-01T00:00:00Z","createdAt":"2024-01-01T00:00:00Z"}}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, headscale.New(srv.URL, "test-api-key")
}

// seedRemoteHostRow inserts a remote (agent-adopted style) host directly
// and returns its id. Bypasses /v1/hosts because the dashboard never
// pre-registers via that flow for the remote-setup bundle — the host row
// is what the operator clicks "Setup remote install" on.
func seedRemoteHostRow(t *testing.T, h *Harness, name string) string {
	t.Helper()
	var id string
	if err := h.DB.QueryRow(h.rootCtx, `
		INSERT INTO hosts (name, provider, region, status, is_remote, is_synapse_host)
		VALUES ($1, 'remote-test', '', 'unknown', TRUE, FALSE)
		RETURNING id
	`, name).Scan(&id); err != nil {
		t.Fatalf("seed host %q: %v", name, err)
	}
	return id
}

func TestRemoteSetup_HappyPath(t *testing.T) {
	var hsCalls int
	_, hsClient := stubHeadscale(t, &hsCalls)

	h := SetupWithOpts(t, SetupOpts{
		HeadscaleServerURL: "https://headscale.example.com",
		Headscale:          hsClient,
		PublicURL:          "https://synapsepanel.example.com",
	})
	admin := h.RegisterRandomUser()

	hostID := seedRemoteHostRow(t, h, "vps-eu-1")

	var resp remoteSetupBundleResp
	h.DoJSON(http.MethodPost, "/v1/hosts/"+hostID+"/remote_setup",
		admin.AccessToken, map[string]any{}, http.StatusCreated, &resp)

	if !strings.HasPrefix(resp.AdoptionToken, "syn_adopt_") {
		t.Errorf("adoptionToken prefix: got %q", resp.AdoptionToken)
	}
	if resp.HeadscaleAuthKey != "hs-key-xyz" {
		t.Errorf("headscaleAuthKey: got %q want hs-key-xyz", resp.HeadscaleAuthKey)
	}
	if resp.ControlURL != "https://synapsepanel.example.com" {
		t.Errorf("controlUrl: got %q", resp.ControlURL)
	}
	if resp.HeadscaleServerURL != "https://headscale.example.com" {
		t.Errorf("headscaleServerUrl: got %q", resp.HeadscaleServerURL)
	}
	if !strings.Contains(resp.OneLiner, "install-agent.sh") ||
		!strings.Contains(resp.OneLiner, "--headscale-auth=hs-key-xyz") ||
		!strings.Contains(resp.OneLiner, "--adoption-token="+resp.AdoptionToken) ||
		!strings.Contains(resp.OneLiner, "--control-url=https://synapsepanel.example.com") {
		t.Errorf("oneLiner shape unexpected: %q", resp.OneLiner)
	}
	if resp.ExpiresAt == "" {
		t.Errorf("expiresAt should be set")
	}
	if hsCalls != 1 {
		t.Errorf("expected exactly 1 Headscale call, got %d", hsCalls)
	}

	// The adoption token must be persisted (hashed) and unused.
	var count int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM host_adoption_tokens
		  WHERE host_id::text = $1 AND used_at IS NULL`,
		hostID).Scan(&count); err != nil {
		t.Fatalf("count adoption tokens: %v", err)
	}
	if count != 1 {
		t.Errorf("adoption token not persisted: count=%d", count)
	}

	// The plaintext token MUST NOT have been stored as-is — only the hash.
	var plaintextRows int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM host_adoption_tokens WHERE token_hash = $1`,
		resp.AdoptionToken).Scan(&plaintextRows); err != nil {
		t.Fatalf("probe plaintext in token_hash: %v", err)
	}
	if plaintextRows != 0 {
		t.Errorf("token_hash column contains plaintext — must be hashed at rest")
	}
}

func TestRemoteSetup_HeadscaleDisabled_503(t *testing.T) {
	// Default harness leaves Headscale wiring nil → 503 remote_hosts_disabled.
	h := Setup(t)
	admin := h.RegisterRandomUser()
	hostID := seedRemoteHostRow(t, h, "vps-eu-1")

	env := h.AssertStatus(http.MethodPost,
		"/v1/hosts/"+hostID+"/remote_setup",
		admin.AccessToken, map[string]any{}, http.StatusServiceUnavailable)
	if env.Code != "remote_hosts_disabled" {
		t.Errorf("code: got %q want remote_hosts_disabled", env.Code)
	}
}

func TestRemoteSetup_NonAdmin_403(t *testing.T) {
	_, hsClient := stubHeadscale(t, nil)
	h := SetupWithOpts(t, SetupOpts{
		HeadscaleServerURL: "https://headscale.example.com",
		Headscale:          hsClient,
		PublicURL:          "https://synapsepanel.example.com",
	})
	_ = h.RegisterRandomUser()         // first user = instance admin
	stranger := h.RegisterRandomUser() // second user = not admin
	hostID := seedRemoteHostRow(t, h, "vps-eu-1")

	env := h.AssertStatus(http.MethodPost,
		"/v1/hosts/"+hostID+"/remote_setup",
		stranger.AccessToken, map[string]any{}, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("code: got %q want forbidden", env.Code)
	}
}

func TestRemoteSetup_HostNotFound_404(t *testing.T) {
	_, hsClient := stubHeadscale(t, nil)
	h := SetupWithOpts(t, SetupOpts{
		HeadscaleServerURL: "https://headscale.example.com",
		Headscale:          hsClient,
		PublicURL:          "https://synapsepanel.example.com",
	})
	admin := h.RegisterRandomUser()

	// A well-formed UUID that doesn't match any row.
	missing := "00000000-0000-0000-0000-000000000000"
	env := h.AssertStatus(http.MethodPost,
		"/v1/hosts/"+missing+"/remote_setup",
		admin.AccessToken, map[string]any{}, http.StatusNotFound)
	if env.Code != "host_not_found" {
		t.Errorf("code: got %q want host_not_found", env.Code)
	}
}
