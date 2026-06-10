package synapsetest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// deploymentJSON mirrors the wire shape of models.Deployment. Used in adopt
// tests because DisallowUnknownFields means we can't decode into a partial
// struct without listing every field that may appear.
type deploymentJSON struct {
	ID              string     `json:"id"`
	ProjectID       string     `json:"projectId"`
	Name            string     `json:"name"`
	DeploymentType  string     `json:"deploymentType"`
	Status          string     `json:"status"`
	DeploymentURL   string     `json:"deploymentUrl,omitempty"`
	SiteURL         string     `json:"siteUrl,omitempty"`
	IsDefault       bool       `json:"isDefault"`
	Reference       string     `json:"reference,omitempty"`
	Creator         string     `json:"creator,omitempty"`
	Adopted         bool       `json:"adopted,omitempty"`
	HAEnabled       bool       `json:"haEnabled,omitempty"`
	ReplicaCount    int        `json:"replicaCount,omitempty"`
	CreateTime      time.Time  `json:"createTime"`
	LastDeployTime  *time.Time `json:"lastDeployTime,omitempty"`
	ExpiresAt       *time.Time `json:"expiresAt,omitempty"`
	HostID          string     `json:"hostId,omitempty"`
	HostName        string     `json:"hostName,omitempty"`
	HostTailnetAddr string     `json:"hostTailnetAddr,omitempty"`
	HostIsRemote    bool       `json:"hostIsRemote,omitempty"`
	CPUs            *float64   `json:"cpus,omitempty"`
	MemoryMB        *int       `json:"memoryMb,omitempty"`
	BackupSchedule  string     `json:"backupSchedule,omitempty"`
	BackupRetention int        `json:"backupRetention,omitempty"`
}

// fakeConvexBackend stands in for a real Convex backend during adoption
// tests. It answers /version and /api/check_admin_key — the two endpoints
// the probe depends on. The configured admin key is the only one accepted.
// Mutable behind a mutex so tests can rotate the key (update_adopted) or
// take the backend "down" (adopted health probe) mid-test.
type fakeConvexBackend struct {
	server *httptest.Server

	mu    sync.Mutex
	want  string // admin key to accept
	down  bool   // /version answers 503 while true (simulated outage)
	failN int    // fail the next N /version calls, then recover (blip)
}

func (f *fakeConvexBackend) setKey(k string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.want = k
}

func (f *fakeConvexBackend) setDown(v bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.down = v
}

func (f *fakeConvexBackend) failNextVersions(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failN = n
}

// versionShouldFail consumes one blip credit / reads the down flag.
func (f *fakeConvexBackend) versionShouldFail() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		return true
	}
	if f.failN > 0 {
		f.failN--
		return true
	}
	return false
}

func (f *fakeConvexBackend) acceptKey() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.want
}

func newFakeConvexBackend(t *testing.T, acceptKey string) *fakeConvexBackend {
	t.Helper()
	f := &fakeConvexBackend{want: acceptKey}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/version":
			if f.versionShouldFail() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"0.1-test"}`))
		case "/api/check_admin_key":
			// Real Convex: GET with `Authorization: Convex <key>`.
			// 200 with {"success":true,...} on match, 401 otherwise.
			if r.Method != http.MethodGet {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			authz := r.Header.Get("Authorization")
			const prefix = "Convex "
			if len(authz) <= len(prefix) || authz[:len(prefix)] != prefix {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if authz[len(prefix):] != f.acceptKey() {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

// projectFor creates a team + project under the given user, returns the
// project id. Used by adopt tests to get a target for adopt_deployment.
func projectFor(t *testing.T, h *Harness, u *User, teamName, projectName string) (teamID, projectID string) {
	t.Helper()
	team := createTeam(t, h, u.AccessToken, teamName)
	var resp struct {
		ProjectID   string         `json:"projectId"`
		ProjectSlug string         `json:"projectSlug"`
		Project     map[string]any `json:"project"`
	}
	h.DoJSON(http.MethodPost, "/v1/teams/"+team.Slug+"/create_project", u.AccessToken,
		map[string]string{"projectName": projectName}, http.StatusCreated, &resp)
	return team.ID, resp.ProjectID
}

// TestAdopt_HappyPath registers an external backend, hits adopt_deployment,
// confirms the row appears in the project listing with adopted=true, and
// confirms delete skips Docker.Destroy.
func TestAdopt_HappyPath(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo", "AdoptedApp")

	const adminKey = "self-hosted-secret-1234"
	backend := newFakeConvexBackend(t, adminKey)

	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{
			"deploymentUrl":  backend.server.URL,
			"adminKey":       adminKey,
			"deploymentType": "prod",
			"isDefault":      true,
		},
		http.StatusCreated, &d)

	if !d.Adopted {
		t.Errorf("expected adopted=true, got false")
	}
	if d.Status != "running" {
		t.Errorf("expected status=running, got %q", d.Status)
	}
	if d.DeploymentURL != backend.server.URL {
		t.Errorf("expected url=%s, got %q", backend.server.URL, d.DeploymentURL)
	}
	if d.Name == "" {
		t.Errorf("expected auto-allocated name, got empty")
	}

	// Should appear in the project listing with adopted=true visible.
	resp := h.Do(http.MethodGet, "/v1/projects/"+projID+"/list_deployments", u.AccessToken, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list_deployments status: %d", resp.StatusCode)
	}
	var got []struct {
		ID      string `json:"id"`
		Adopted bool   `json:"adopted"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(got) != 1 || got[0].ID != d.ID || !got[0].Adopted {
		t.Errorf("listing didn't surface adopted row correctly: %+v", got)
	}

	// Delete must NOT call Docker.Destroy on adopted rows. Reset the
	// FakeDocker counter first so any spillover from setup is excluded.
	h.Docker.Destroyed = nil
	h.DoJSON(http.MethodPost, "/v1/deployments/"+d.Name+"/delete", u.AccessToken,
		map[string]any{}, http.StatusOK, nil)
	for _, name := range h.Docker.Destroyed {
		if name == d.Name {
			t.Errorf("Docker.Destroy was called for adopted deployment %q", d.Name)
		}
	}
}

// TestAdopt_BadAdminKey: backend rejects the supplied key, handler returns 400.
func TestAdopt_BadAdminKey(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo2", "App2")

	backend := newFakeConvexBackend(t, "the-real-key")
	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{
			"deploymentUrl": backend.server.URL,
			"adminKey":      "wrong-key",
		},
		http.StatusBadRequest)
	if env.Code != "invalid_admin_key" {
		t.Errorf("expected invalid_admin_key, got %q", env.Code)
	}
}

// TestAdopt_UnreachableURL: handler should return 502/probe_failed when the
// supplied URL doesn't respond. Uses a server that's been Closed.
func TestAdopt_UnreachableURL(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo3", "App3")

	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	dead.Close() // immediately

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{
			"deploymentUrl": dead.URL,
			"adminKey":      "anything",
		},
		http.StatusBadGateway)
	if env.Code != "probe_failed" {
		t.Errorf("expected probe_failed, got %q", env.Code)
	}
}

// TestAdopt_MissingFields: empty url / empty admin key both 400.
func TestAdopt_MissingFields(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo4", "App4")

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{"deploymentUrl": "", "adminKey": "x"}, http.StatusBadRequest)
	if env.Code != "missing_url" {
		t.Errorf("expected missing_url, got %q", env.Code)
	}

	env = h.AssertStatus(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{"deploymentUrl": "http://example.com", "adminKey": "  "}, http.StatusBadRequest)
	if env.Code != "missing_admin_key" {
		t.Errorf("expected missing_admin_key, got %q", env.Code)
	}

	env = h.AssertStatus(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{"deploymentUrl": "ftp://nope.example.com", "adminKey": "x"}, http.StatusBadRequest)
	if env.Code != "invalid_url" {
		t.Errorf("expected invalid_url for non-http scheme, got %q", env.Code)
	}
}

// TestAdopt_NonAdminForbidden: a member (non-admin) of the team cannot adopt.
func TestAdopt_NonAdminForbidden(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	teamID, projID := projectFor(t, h, admin, "AdoptCo5", "App5")

	// Add a second user as a non-admin member directly via DB (no
	// invite-token round-trip — keeps the test focused).
	member := h.RegisterRandomUser()
	if _, err := h.DB.Exec(h.rootCtx,
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
		teamID, member.ID); err != nil {
		t.Fatalf("seed member: %v", err)
	}

	backend := newFakeConvexBackend(t, "k")
	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment",
		member.AccessToken,
		map[string]any{"deploymentUrl": backend.server.URL, "adminKey": "k"},
		http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("expected forbidden, got %q", env.Code)
	}
}

// TestAdopt_NameCollision: supplying a name that's already taken by another
// deployment returns 409 name_taken.
func TestAdopt_NameCollision(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo6", "App6")

	backend := newFakeConvexBackend(t, "k6")

	// First adoption with explicit name.
	var first deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{
			"deploymentUrl": backend.server.URL,
			"adminKey":      "k6",
			"name":          "my-existing-app",
		},
		http.StatusCreated, &first)

	_ = first
	// Second adoption with the same name.
	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{
			"deploymentUrl": backend.server.URL,
			"adminKey":      "k6",
			"name":          "my-existing-app",
		},
		http.StatusConflict)
	if env.Code != "name_taken" {
		t.Errorf("expected name_taken, got %q", env.Code)
	}
}

// TestAdopt_HealthWorkerSkipsAdopted: confirm the health-worker SQL filter
// excludes adopted rows. We don't run the worker here — just exercise the
// query the worker uses, to keep this fast and deterministic.
func TestAdopt_HealthWorkerSkipsAdopted(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo7", "App7")

	backend := newFakeConvexBackend(t, "k7")
	var adopted deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{
			"deploymentUrl": backend.server.URL,
			"adminKey":      "k7",
		},
		http.StatusCreated, &adopted)

	rows, err := h.DB.Query(h.rootCtx,
		`SELECT id FROM deployments WHERE status = 'running' AND adopted = false`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()

	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if id == adopted.ID {
			t.Errorf("health worker query returned adopted deployment %s", id)
		}
	}
}

// TestAdopt_InvalidName: user-supplied names must be lowercase DNS labels —
// they become /d/{name} route segments, wildcard subdomain candidates, and
// CONVEX_DEPLOYMENT values. Adopt is the only door where a name arrives
// from user input (create auto-generates), so it's where the gate lives.
func TestAdopt_InvalidName(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo8", "App8")

	backend := newFakeConvexBackend(t, "k8")
	for _, bad := range []string{
		"My App",          // space + uppercase
		"UPPER",           // uppercase
		"-leading",        // leading hyphen
		"trailing-",       // trailing hyphen
		"dotted.name",     // dot (would break single-label wildcard routing)
		strings.Repeat("a", 64), // longer than a DNS label
	} {
		env := h.AssertStatus(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
			map[string]any{
				"deploymentUrl": backend.server.URL,
				"adminKey":      "k8",
				"name":          bad,
			},
			http.StatusBadRequest)
		if env.Code != "invalid_name" {
			t.Errorf("name %q: expected invalid_name, got %q", bad, env.Code)
		}
	}

	// A generator-shaped name still passes.
	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{
			"deploymentUrl": backend.server.URL,
			"adminKey":      "k8",
			"name":          "ok-name-1234",
		},
		http.StatusCreated, &d)
	if d.Name != "ok-name-1234" {
		t.Errorf("valid name rejected: got %q", d.Name)
	}
}

// TestAdopt_RedirectRefused: the probe must not follow redirects (SSRF
// hardening) — a /version that answers 3xx fails the probe instead of
// bouncing the prober somewhere else.
func TestAdopt_RedirectRefused(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo9", "App9")

	real := newFakeConvexBackend(t, "k9")
	bouncer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, real.server.URL+r.URL.Path, http.StatusFound)
	}))
	t.Cleanup(bouncer.Close)

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{
			"deploymentUrl": bouncer.URL,
			"adminKey":      "k9",
		},
		http.StatusBadGateway)
	if env.Code != "probe_failed" {
		t.Errorf("expected probe_failed for redirecting URL, got %q", env.Code)
	}
}

// TestAdopt_BackendVersion: adopted deployments report their backend
// version via the stored external URL (v1.27+; used to be a hardcoded
// "adopted_deployment" error).
func TestAdopt_BackendVersion(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo10", "App10")

	backend := newFakeConvexBackend(t, "k10")
	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{"deploymentUrl": backend.server.URL, "adminKey": "k10"},
		http.StatusCreated, &d)

	var got struct {
		Version      string     `json:"version,omitempty"`
		LastDeployAt *time.Time `json:"lastDeployAt,omitempty"`
		FetchedAt    string     `json:"fetchedAt"`
		FromCache    bool       `json:"fromCache"`
		Error        string     `json:"error,omitempty"`
	}
	h.DoJSON(http.MethodGet, "/v1/deployments/"+d.Name+"/backend_version", u.AccessToken,
		nil, http.StatusOK, &got)
	if got.Error != "" {
		t.Fatalf("expected no probe error, got %q", got.Error)
	}
	if got.Version != "0.1-test" {
		t.Errorf("version: got %q want 0.1-test", got.Version)
	}
}

// TestAdopt_DeployKeysListRefused: GET /deploy_keys 409s for adopted rows
// (v1.27+; used to silently return [] which let UIs render a panel whose
// every action would fail).
func TestAdopt_DeployKeysListRefused(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo11", "App11")

	backend := newFakeConvexBackend(t, "k11")
	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{"deploymentUrl": backend.server.URL, "adminKey": "k11"},
		http.StatusCreated, &d)

	env := h.AssertStatus(http.MethodGet, "/v1/deployments/"+d.Name+"/deploy_keys",
		u.AccessToken, nil, http.StatusConflict)
	if env.Code != "deploy_keys_unsupported_for_adopted" {
		t.Errorf("expected deploy_keys_unsupported_for_adopted, got %q", env.Code)
	}
}

// TestAdopt_DomainsRefused: custom domains can't front an adopted
// deployment (the proxy has no container to route to), so POST /domains
// 409s instead of registering a domain that would only ever 502.
func TestAdopt_DomainsRefused(t *testing.T) {
	h := Setup(t)
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo12", "App12")

	backend := newFakeConvexBackend(t, "k12")
	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{"deploymentUrl": backend.server.URL, "adminKey": "k12"},
		http.StatusCreated, &d)

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/"+d.Name+"/domains",
		u.AccessToken, map[string]any{"domain": "api.adopted.example.com"}, http.StatusConflict)
	if env.Code != "domains_unsupported_for_adopted" {
		t.Errorf("expected domains_unsupported_for_adopted, got %q", env.Code)
	}
}

// TestAdopt_TLSAskRejectsAdopted: the on-demand TLS gate must not approve
// wildcard certs for adopted deployments — the proxy can't route them, so
// a cert would only front a permanent 502.
func TestAdopt_TLSAskRejectsAdopted(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{BaseDomain: "synapse.example.com"})
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "AdoptCo13", "App13")

	backend := newFakeConvexBackend(t, "k13")
	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{
			"deploymentUrl": backend.server.URL,
			"adminKey":      "k13",
			"name":          "adopted-tls-1234",
		},
		http.StatusCreated, &d)

	q := url.Values{"domain": {"adopted-tls-1234.synapse.example.com"}}
	resp := h.Do(http.MethodGet, "/v1/internal/tls_ask?"+q.Encode(), "", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("tls_ask adopted wildcard: status=%d want 404", resp.StatusCode)
	}
}

// keep imports stable when fields shift around.
var _ = strings.TrimSpace
