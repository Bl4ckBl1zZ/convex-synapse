package synapsetest

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// headscaleAdminResp mirrors the GET /v1/admin/headscale shape so the
// strict decoder catches any drift between handler + test fixture.
// Field names match the json tags 1:1.
type headscaleAdminResp struct {
	Enabled                 bool   `json:"enabled"`
	Configured              bool   `json:"configured"`
	RemoteProvisioningReady bool   `json:"remoteProvisioningReady"`
	NeedsAPIRestart         bool   `json:"needsApiRestart"`
	UpdaterAvailable        bool   `json:"updaterAvailable"`
	UpdaterReason           string `json:"updaterReason,omitempty"`
	Domain                  string `json:"domain,omitempty"`
	ServerURL               string `json:"serverUrl,omitempty"`
	InternalURL             string `json:"internalUrl,omitempty"`
	BaseDomain              string `json:"baseDomain,omitempty"`
	HostDomain              string `json:"hostDomain,omitempty"`
	PublicURL               string `json:"publicUrl,omitempty"`
	PublicIP                string `json:"publicIp,omitempty"`
	DefaultDomain           string `json:"defaultDomain,omitempty"`
	DNSCredentialAvailable  bool   `json:"dnsCredentialAvailable"`
}

type headscaleConfigureResp struct {
	JobID     string `json:"jobId"`
	StatusURL string `json:"statusUrl"`
	State     string `json:"state"`
	Domain    string `json:"domain,omitempty"`
	ServerURL string `json:"serverUrl,omitempty"`
}

func TestHeadscaleAdmin_Get_DisabledDefault(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{})
	owner := makeAdminUser(t, h)

	var got headscaleAdminResp
	h.DoJSON(http.MethodGet, "/v1/admin/headscale",
		owner.AccessToken, nil, http.StatusOK, &got)

	if got.Enabled {
		t.Errorf("expected enabled=false on a fresh install")
	}
	if got.Configured {
		t.Errorf("expected configured=false on a fresh install")
	}
	if got.RemoteProvisioningReady {
		t.Errorf("expected remoteProvisioningReady=false on a fresh install")
	}
	if got.DefaultDomain != "" {
		t.Errorf("defaultDomain: got %q want empty when no host/base domain", got.DefaultDomain)
	}
}

func TestHeadscaleAdmin_Get_BaseDomainDefault(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		BaseDomain: "app.example.com",
	})
	owner := makeAdminUser(t, h)

	var got headscaleAdminResp
	h.DoJSON(http.MethodGet, "/v1/admin/headscale",
		owner.AccessToken, nil, http.StatusOK, &got)

	if got.DefaultDomain != "headscale.app.example.com" {
		t.Errorf("defaultDomain: got %q want headscale.app.example.com", got.DefaultDomain)
	}
	if got.BaseDomain != "app.example.com" {
		t.Errorf("baseDomain echo: got %q", got.BaseDomain)
	}
}

// TestHeadscaleAdmin_Get_DashboardDomainPrefersOverBaseDomain encodes the
// v1.19 correctness fix: when the operator has both
// SYNAPSE_DOMAIN=synapsepanel.com and
// SYNAPSE_BASE_DOMAIN=app.synapsepanel.com configured, the Headscale
// default MUST be headscale.synapsepanel.com — NOT
// headscale.app.synapsepanel.com (which would fall inside the
// deployments wildcard on-demand-TLS policy and never get a cert).
func TestHeadscaleAdmin_Get_DashboardDomainPrefersOverBaseDomain(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		BaseDomain: "app.synapsepanel.com",
		HostDomain: "synapsepanel.com",
	})
	owner := makeAdminUser(t, h)

	var got headscaleAdminResp
	h.DoJSON(http.MethodGet, "/v1/admin/headscale",
		owner.AccessToken, nil, http.StatusOK, &got)

	if got.DefaultDomain != "headscale.synapsepanel.com" {
		t.Errorf("defaultDomain: got %q want headscale.synapsepanel.com (must prefer SYNAPSE_DOMAIN)",
			got.DefaultDomain)
	}
	if got.HostDomain != "synapsepanel.com" {
		t.Errorf("hostDomain echo: got %q", got.HostDomain)
	}
}

func TestHeadscaleAdmin_Get_ExplicitOverrideWins(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		BaseDomain:      "app.synapsepanel.com",
		HostDomain:      "synapsepanel.com",
		HeadscaleDomain: "tailscale-control.example.org",
	})
	owner := makeAdminUser(t, h)

	var got headscaleAdminResp
	h.DoJSON(http.MethodGet, "/v1/admin/headscale",
		owner.AccessToken, nil, http.StatusOK, &got)

	if got.DefaultDomain != "tailscale-control.example.org" {
		t.Errorf("defaultDomain: got %q want explicit override tailscale-control.example.org",
			got.DefaultDomain)
	}
	if got.Domain != "tailscale-control.example.org" {
		t.Errorf("domain echo: got %q", got.Domain)
	}
}

func TestHeadscaleAdmin_Get_ConfiguredButNotEnabled_NeedsRestart(t *testing.T) {
	// Simulate the state right after setup.sh --configure-headscale
	// stamped .env but synapse-api hasn't restarted yet: env stamps
	// are present, runtime Headscale client is nil.
	h := SetupWithOpts(t, SetupOpts{
		HeadscaleURL:       "http://synapse-headscale:8080",
		HeadscaleServerURL: "https://headscale.example.com",
		HeadscaleAPIKey:    "headscale-api-key-not-real",
	})
	owner := makeAdminUser(t, h)

	var got headscaleAdminResp
	h.DoJSON(http.MethodGet, "/v1/admin/headscale",
		owner.AccessToken, nil, http.StatusOK, &got)

	if !got.Configured {
		t.Errorf("expected configured=true when intent fields are present")
	}
	if got.Enabled {
		t.Errorf("expected enabled=false when no Headscale client was wired into the api")
	}
	if !got.NeedsAPIRestart {
		t.Errorf("expected needsApiRestart=true (configured && !enabled)")
	}
}

func TestHeadscaleAdmin_Get_NotAdmin_403(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{})
	_ = makeAdminUser(t, h)
	stranger := makeNonAdminUser(t, h)

	h.AssertStatus(http.MethodGet, "/v1/admin/headscale",
		stranger.AccessToken, nil, http.StatusForbidden)
}

func TestHeadscaleAdmin_Post_NotAdmin_403(t *testing.T) {
	url, tok := stubUpdater(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Errorf("daemon should NEVER be hit when caller is not admin")
		w.WriteHeader(http.StatusInternalServerError)
	})
	h := SetupWithOpts(t, SetupOpts{UpdaterURL: url, UpdaterToken: tok})
	_ = makeAdminUser(t, h)
	stranger := makeNonAdminUser(t, h)

	h.AssertStatus(http.MethodPost, "/v1/admin/headscale/configure",
		stranger.AccessToken, map[string]any{"headscaleDomain": "headscale.example.com"},
		http.StatusForbidden)
}

func TestHeadscaleAdmin_Post_NoUpdater_503(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		BaseDomain: "example.com",
	})
	owner := makeAdminUser(t, h)

	env := h.AssertStatus(http.MethodPost, "/v1/admin/headscale/configure",
		owner.AccessToken,
		map[string]any{"headscaleDomain": "headscale.example.com"},
		http.StatusServiceUnavailable)
	if env.Code != "updater_unreachable" && env.Code != "updater_unavailable" {
		t.Errorf("expected updater_unreachable, got %q", env.Code)
	}
}

func TestHeadscaleAdmin_Post_NoHostDomain_400(t *testing.T) {
	url, tok := stubUpdater(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Errorf("daemon should NEVER be hit when host domain is unconfigured")
		w.WriteHeader(http.StatusInternalServerError)
	})
	// No HostDomain, no BaseDomain, no HeadscaleDomain — the configure
	// path has nothing to derive a default from and must refuse.
	h := SetupWithOpts(t, SetupOpts{UpdaterURL: url, UpdaterToken: tok})
	owner := makeAdminUser(t, h)

	env := h.AssertStatus(http.MethodPost, "/v1/admin/headscale/configure",
		owner.AccessToken,
		map[string]any{},
		http.StatusBadRequest)
	if env.Code != "host_domain_required" {
		t.Errorf("expected host_domain_required, got %q", env.Code)
	}
}

func TestHeadscaleAdmin_Post_InvalidDomain_400(t *testing.T) {
	url, tok := stubUpdater(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Errorf("daemon should NEVER be hit on a malformed domain")
		w.WriteHeader(http.StatusInternalServerError)
	})
	h := SetupWithOpts(t, SetupOpts{
		UpdaterURL:   url,
		UpdaterToken: tok,
		BaseDomain:   "example.com",
	})
	owner := makeAdminUser(t, h)

	env := h.AssertStatus(http.MethodPost, "/v1/admin/headscale/configure",
		owner.AccessToken,
		map[string]any{"headscaleDomain": "not a hostname"},
		http.StatusBadRequest)
	if env.Code == "" {
		t.Errorf("expected an error code on malformed domain")
	}
}

func TestHeadscaleAdmin_Post_ValidConfigure_202(t *testing.T) {
	var hits int64
	var seenBody []byte
	url, tok := stubUpdater(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		if r.Method != http.MethodPost || r.URL.Path != "/configure_headscale" {
			http.Error(w, "wrong route", http.StatusNotFound)
			return
		}
		buf, _ := io.ReadAll(r.Body)
		seenBody = buf
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"started":true,"jobId":"placeholder"}`))
	})
	h := SetupWithOpts(t, SetupOpts{
		UpdaterURL:   url,
		UpdaterToken: tok,
		BaseDomain:   "app.synapsepanel.com",
		HostDomain:   "synapsepanel.com",
	})
	owner := makeAdminUser(t, h)

	var got headscaleConfigureResp
	h.DoJSON(http.MethodPost, "/v1/admin/headscale/configure",
		owner.AccessToken,
		map[string]any{}, // omit domain → derive from env
		http.StatusAccepted, &got)

	if got.JobID == "" {
		t.Fatalf("expected jobId, got %+v", got)
	}
	if got.StatusURL != "/v1/admin/headscale/status/"+got.JobID {
		t.Errorf("statusUrl: got %q", got.StatusURL)
	}
	if got.State != "queued" {
		t.Errorf("state: got %q want queued", got.State)
	}
	// Expect the derived default headscale.synapsepanel.com (NOT app.…).
	if got.Domain != "headscale.synapsepanel.com" {
		t.Errorf("derived domain: got %q want headscale.synapsepanel.com", got.Domain)
	}
	if got.ServerURL != "https://headscale.synapsepanel.com" {
		t.Errorf("serverUrl: got %q", got.ServerURL)
	}
	if atomic.LoadInt64(&hits) != 1 {
		t.Errorf("daemon hits: got %d want 1", atomic.LoadInt64(&hits))
	}

	// Daemon got the validated payload + jobId.
	var dispatched map[string]any
	if err := json.Unmarshal(seenBody, &dispatched); err != nil {
		t.Fatalf("unmarshal daemon body: %v", err)
	}
	if dispatched["jobId"] != got.JobID {
		t.Errorf("daemon jobId: got %v want %s", dispatched["jobId"], got.JobID)
	}
	if dispatched["headscaleDomain"] != "headscale.synapsepanel.com" {
		t.Errorf("daemon domain: got %v", dispatched["headscaleDomain"])
	}

	// admin_jobs row exists with kind = configure_headscale.
	var kind, state string
	if err := h.DB.QueryRow(h.rootCtx, `
		SELECT kind, state FROM admin_jobs WHERE id = $1
	`, got.JobID).Scan(&kind, &state); err != nil {
		t.Fatalf("load admin_jobs row: %v", err)
	}
	if kind != "configure_headscale" {
		t.Errorf("kind: got %q", kind)
	}
	if state != "queued" {
		t.Errorf("state: got %q want queued (mock daemon does not write back)", state)
	}

	// Audit row.
	var count int
	if err := h.DB.QueryRow(h.rootCtx, `
		SELECT count(*) FROM audit_events
		 WHERE actor_id = $1
		   AND action = 'headscale.configure_initiated'
		   AND target_type = 'synapse'
		   AND target_id = $2
	`, owner.ID, got.JobID).Scan(&count); err != nil {
		t.Fatalf("query audit: %v", err)
	}
	if count != 1 {
		t.Errorf("expected 1 audit row, got %d", count)
	}
}

func TestHeadscaleAdmin_Post_ExplicitDomainHonoured(t *testing.T) {
	url, tok := stubUpdater(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"started":true}`))
	})
	h := SetupWithOpts(t, SetupOpts{
		UpdaterURL:   url,
		UpdaterToken: tok,
		BaseDomain:   "app.synapsepanel.com",
		HostDomain:   "synapsepanel.com",
	})
	owner := makeAdminUser(t, h)

	var got headscaleConfigureResp
	h.DoJSON(http.MethodPost, "/v1/admin/headscale/configure",
		owner.AccessToken,
		map[string]any{"headscaleDomain": "custom-control.example.org"},
		http.StatusAccepted, &got)

	if got.Domain != "custom-control.example.org" {
		t.Errorf("explicit domain should win: got %q", got.Domain)
	}
}

func TestHeadscaleAdmin_Post_DaemonReturns409_PassThrough(t *testing.T) {
	url, tok := stubUpdater(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"configure_in_progress"}`))
	})
	h := SetupWithOpts(t, SetupOpts{
		UpdaterURL:   url,
		UpdaterToken: tok,
		BaseDomain:   "example.com",
	})
	owner := makeAdminUser(t, h)

	env := h.AssertStatus(http.MethodPost, "/v1/admin/headscale/configure",
		owner.AccessToken,
		map[string]any{"headscaleDomain": "headscale.example.com"},
		http.StatusConflict)
	if env.Code != "configure_in_progress" {
		t.Errorf("code: got %q want configure_in_progress", env.Code)
	}

	// The row should be marked failed when the daemon refused.
	var state string
	if err := h.DB.QueryRow(h.rootCtx, `
		SELECT state FROM admin_jobs WHERE kind = 'configure_headscale'
		 ORDER BY created_at DESC LIMIT 1
	`).Scan(&state); err != nil {
		t.Fatalf("query admin_jobs: %v", err)
	}
	if state != "failed" {
		t.Errorf("expected row flipped to failed, got %q", state)
	}
}

func TestHeadscaleAdmin_Status_ExistingJob(t *testing.T) {
	url, tok := stubUpdater(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"started":true}`))
	})
	h := SetupWithOpts(t, SetupOpts{UpdaterURL: url, UpdaterToken: tok})
	owner := makeAdminUser(t, h)

	var jobID string
	if err := h.DB.QueryRow(h.rootCtx, `
		INSERT INTO admin_jobs (kind, payload, state, log, started_at)
		VALUES ('configure_headscale', '{"headscaleDomain":"headscale.test"}'::jsonb,
		        'running', 'starting setup.sh\nrendering headscale config\n', now())
		RETURNING id
	`).Scan(&jobID); err != nil {
		t.Fatalf("insert admin_jobs: %v", err)
	}

	// Same shape as hostDomainStatusResp; handler reuses the type.
	var got hostDomainStatusResp
	h.DoJSON(http.MethodGet, "/v1/admin/headscale/status/"+jobID,
		owner.AccessToken, nil, http.StatusOK, &got)
	if got.ID != jobID {
		t.Errorf("id: got %q want %q", got.ID, jobID)
	}
	if got.State != "running" {
		t.Errorf("state: got %q", got.State)
	}
	if !strings.Contains(got.Log, "headscale config") {
		t.Errorf("log not surfaced: %q", got.Log)
	}
}

func TestHeadscaleAdmin_Status_NotFound_404(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{})
	owner := makeAdminUser(t, h)
	env := h.AssertStatus(http.MethodGet,
		"/v1/admin/headscale/status/00000000-0000-0000-0000-000000000000",
		owner.AccessToken, nil, http.StatusNotFound)
	if env.Code != "job_not_found" {
		t.Errorf("code: got %q want job_not_found", env.Code)
	}
}

// TestHeadscaleAdmin_Status_RefusesHostDomainJobID ensures the status
// endpoint only resolves rows of the matching kind. Without the WHERE
// kind = 'configure_headscale' clause the dashboard's polling dialog
// could accidentally surface a host-domain reconfigure run.
func TestHeadscaleAdmin_Status_RefusesHostDomainJobID(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{})
	owner := makeAdminUser(t, h)

	var hostDomainJobID string
	if err := h.DB.QueryRow(h.rootCtx, `
		INSERT INTO admin_jobs (kind, payload, state)
		VALUES ('reconfigure_host_domain', '{"domain":"x.test"}'::jsonb, 'queued')
		RETURNING id
	`).Scan(&hostDomainJobID); err != nil {
		t.Fatalf("insert admin_jobs: %v", err)
	}

	env := h.AssertStatus(http.MethodGet, "/v1/admin/headscale/status/"+hostDomainJobID,
		owner.AccessToken, nil, http.StatusNotFound)
	if env.Code != "job_not_found" {
		t.Errorf("code: got %q want job_not_found (kind mismatch)", env.Code)
	}
}

// TestHeadscaleAdmin_Get_PublicURLFallback_NoSynapseDomain reproduces the
// v1.19.0 bug: SYNAPSE_DOMAIN wasn't wired into the synapse-api container
// in docker-compose.yml, so a TLS install with a perfectly good
// PublicURL=https://synapsepanel.com still rendered "Host domain
// required" because cfg.HostDomain was empty. v1.19.1 added a
// PublicURL→Domain fallback (mirroring host_domain.go since v1.4).
func TestHeadscaleAdmin_Get_PublicURLFallback_NoSynapseDomain(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL: "https://synapsepanel.com",
		// HostDomain deliberately empty — simulates the missing
		// docker-compose passthrough.
	})
	owner := makeAdminUser(t, h)

	var got headscaleAdminResp
	h.DoJSON(http.MethodGet, "/v1/admin/headscale",
		owner.AccessToken, nil, http.StatusOK, &got)

	if got.DefaultDomain != "headscale.synapsepanel.com" {
		t.Errorf("defaultDomain: got %q want headscale.synapsepanel.com (PublicURL fallback)",
			got.DefaultDomain)
	}
}

// TestHeadscaleAdmin_Get_PublicURLFallback_IgnoresIP confirms the
// fallback skips when PublicURL points at a bare IP (no-tls install) —
// we must not pretend an IP is a routable domain.
func TestHeadscaleAdmin_Get_PublicURLFallback_IgnoresIP(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL: "http://203.0.113.10:8080",
	})
	owner := makeAdminUser(t, h)

	var got headscaleAdminResp
	h.DoJSON(http.MethodGet, "/v1/admin/headscale",
		owner.AccessToken, nil, http.StatusOK, &got)

	if got.DefaultDomain != "" {
		t.Errorf("defaultDomain: got %q want empty (must not derive from an IP)", got.DefaultDomain)
	}
}

// TestHeadscaleAdmin_Post_PublicURLFallback_AllowsConfigure confirms the
// POST path also honors the fallback — a configure request must NOT be
// refused with host_domain_required when PublicURL carries a real domain.
func TestHeadscaleAdmin_Post_PublicURLFallback_AllowsConfigure(t *testing.T) {
	url, tok := stubUpdater(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"started":true}`))
	})
	h := SetupWithOpts(t, SetupOpts{
		UpdaterURL:   url,
		UpdaterToken: tok,
		PublicURL:    "https://synapsepanel.com",
		// HostDomain empty — the v1.19.0 bug state.
	})
	owner := makeAdminUser(t, h)

	var got headscaleConfigureResp
	h.DoJSON(http.MethodPost, "/v1/admin/headscale/configure",
		owner.AccessToken,
		map[string]any{}, // derive from fallback
		http.StatusAccepted, &got)

	if got.Domain != "headscale.synapsepanel.com" {
		t.Errorf("derived domain: got %q want headscale.synapsepanel.com", got.Domain)
	}
}
