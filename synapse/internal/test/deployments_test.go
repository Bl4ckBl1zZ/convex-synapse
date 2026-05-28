package synapsetest

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	dockerprov "github.com/Iann29/synapse/internal/docker"
)

var errBoom = errors.New("simulated docker error")

// waitForStatus polls the deployments table until the named row reaches the
// expected status or the timeout elapses. The async tests use this to wait
// for the provisioning goroutine to settle.
func waitForStatus(t *testing.T, h *Harness, name, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		if err := h.DB.QueryRow(h.rootCtx,
			`SELECT status FROM deployments WHERE name = $1`, name).Scan(&last); err != nil {
			t.Fatalf("read status: %v", err)
		}
		if last == want {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("status of %q never became %q within %v (last seen: %q)", name, want, timeout, last)
}

// itoa is a tiny stand-in for strconv.Itoa to keep the call sites readable.
func itoa(i int) string { return strconv.Itoa(i) }

type deploymentResp struct {
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
}

type deploymentAuthResp struct {
	DeploymentName string `json:"deploymentName"`
	DeploymentURL  string `json:"deploymentUrl"`
	AdminKey       string `json:"adminKey"`
	DeploymentType string `json:"deploymentType"`
}

func TestDeployments_GetReturnsRow(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Dep Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "DepProj")

	id := h.SeedDeployment(proj.ID, "happy-cat-1234", "dev", "running", true, owner.ID, 3211, "")
	_ = id

	var got deploymentResp
	h.DoJSON(http.MethodGet, "/v1/deployments/happy-cat-1234", owner.AccessToken,
		nil, http.StatusOK, &got)
	if got.Name != "happy-cat-1234" {
		t.Errorf("name mismatch: %s", got.Name)
	}
	if got.Status != "running" {
		t.Errorf("status: got %s want running", got.Status)
	}
	if got.DeploymentURL == "" {
		t.Errorf("expected deployment URL")
	}
	// admin_key MUST NOT be in the response.
	// (This is enforced by `json:"-"` in models.Deployment; if a future
	// refactor breaks that, our DisallowUnknownFields decode will catch it.)
}

func TestDeployments_GetUnknown(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	env := h.AssertStatus(http.MethodGet, "/v1/deployments/no-such-name",
		owner.AccessToken, nil, http.StatusNotFound)
	if env.Code != "deployment_not_found" {
		t.Errorf("got code %q want deployment_not_found", env.Code)
	}
}

func TestDeployments_NonMember403(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	stranger := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Closed Dep Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Closed")
	h.SeedDeployment(proj.ID, "secret-fox-9999", "prod", "running", false, owner.ID, 3212, "")

	env := h.AssertStatus(http.MethodGet, "/v1/deployments/secret-fox-9999",
		stranger.AccessToken, nil, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}
}

func TestDeployments_AuthReturnsAdminKey(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Auth Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "AuthProj")
	h.SeedDeployment(proj.ID, "auth-bee-5555", "prod", "running", true, owner.ID, 3213, "secret-key-xyz")

	var got deploymentAuthResp
	h.DoJSON(http.MethodGet, "/v1/deployments/auth-bee-5555/auth", owner.AccessToken,
		nil, http.StatusOK, &got)
	if got.AdminKey != "secret-key-xyz" {
		t.Errorf("admin key mismatch: got %q", got.AdminKey)
	}
	if got.DeploymentName != "auth-bee-5555" {
		t.Errorf("name mismatch: %s", got.DeploymentName)
	}
	if got.DeploymentType != "prod" {
		t.Errorf("type mismatch: %s", got.DeploymentType)
	}
	if got.DeploymentURL == "" {
		t.Errorf("expected deployment URL")
	}
}

func TestDeployments_AuthNonMember403(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	stranger := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "AuthStranger Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "stranger-owl-7777", "dev", "running", false, owner.ID, 3214, "")

	h.AssertStatus(http.MethodGet, "/v1/deployments/stranger-owl-7777/auth",
		stranger.AccessToken, nil, http.StatusForbidden)
}

// cliCredentialsResp mirrors the JSON shape returned by
// GET /v1/deployments/{name}/cli_credentials. Decoded with
// DisallowUnknownFields so any drift in the handler payload fails loudly.
type cliCredentialsResp struct {
	DeploymentName string `json:"deploymentName"`
	ConvexURL      string `json:"convexUrl"`
	SiteURL        string `json:"siteUrl,omitempty"`
	AdminKey       string `json:"adminKey"`
	ExportSnippet  string `json:"exportSnippet"`
	EnvSnippet     string `json:"envSnippet"`
}

func TestDeployments_CLICredentialsReturnsExportSnippet(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "CLI Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "CLIProj")
	h.SeedDeployment(proj.ID, "cli-rabbit-1234", "prod", "running", true, owner.ID, 3220, "admin-key-abc")

	var got cliCredentialsResp
	h.DoJSON(http.MethodGet, "/v1/deployments/cli-rabbit-1234/cli_credentials",
		owner.AccessToken, nil, http.StatusOK, &got)

	if got.DeploymentName != "cli-rabbit-1234" {
		t.Errorf("deployment name: got %q want cli-rabbit-1234", got.DeploymentName)
	}
	if got.AdminKey != "admin-key-abc" {
		t.Errorf("admin key: got %q want admin-key-abc", got.AdminKey)
	}
	if got.ConvexURL == "" {
		t.Errorf("expected convex URL")
	}

	// Both snippets must contain BOTH env-var names so either copy-paste
	// path sets the CLI up correctly. We don't pin the exact line
	// ordering, but the values must match the structured fields.
	for _, tc := range []struct {
		name    string
		snippet string
		prefix  string // "export " for shell, "" for .env
	}{
		{"export", got.ExportSnippet, "export "},
		{"env", got.EnvSnippet, ""},
	} {
		if !strings.Contains(tc.snippet, tc.prefix+"CONVEX_SELF_HOSTED_URL") {
			t.Errorf("%s snippet missing %sCONVEX_SELF_HOSTED_URL: %q", tc.name, tc.prefix, tc.snippet)
		}
		if !strings.Contains(tc.snippet, tc.prefix+"CONVEX_SELF_HOSTED_ADMIN_KEY") {
			t.Errorf("%s snippet missing %sCONVEX_SELF_HOSTED_ADMIN_KEY: %q", tc.name, tc.prefix, tc.snippet)
		}
		if !strings.Contains(tc.snippet, "admin-key-abc") {
			t.Errorf("%s snippet missing admin key value: %q", tc.name, tc.snippet)
		}
		if !strings.Contains(tc.snippet, got.ConvexURL) {
			t.Errorf("%s snippet missing convex URL %q: %q", tc.name, got.ConvexURL, tc.snippet)
		}
	}
	// Belt-and-suspenders: the .env snippet must NOT carry `export `
	// (otherwise dotenv parsers choke).
	if strings.Contains(got.EnvSnippet, "export ") {
		t.Errorf("env snippet should not contain `export `: %q", got.EnvSnippet)
	}
}

// CLI URL must be a *root* URL the official `npx convex` CLI can hit
// directly. The CLI builds API requests via `new URL("/api/...", baseUrl)`,
// which is host-anchored — a baseUrl like `<host>:8080/d/<name>` would
// resolve to `<host>:8080/api/...` (Synapse 404), not the deployment.
// So the snippet must point at the per-deployment host port instead of
// the path-proxy form, even when ProxyEnabled is on for browsers.
func TestDeployments_CLICredentialsURLBypassesPathProxy(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL:    "http://synapse.example.com:8080",
		ProxyEnabled: true,
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "CLIProxy Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "cli-fox-9999", "dev", "running", false, owner.ID, 3290, "key-xyz")

	var got cliCredentialsResp
	h.DoJSON(http.MethodGet, "/v1/deployments/cli-fox-9999/cli_credentials",
		owner.AccessToken, nil, http.StatusOK, &got)

	// CLI-facing URL strips the synapse-api port and appends the
	// deployment's own host_port, giving the CLI a root URL.
	wantURL := "http://synapse.example.com:3290"
	if got.ConvexURL != wantURL {
		t.Errorf("convexUrl: got %q want %q", got.ConvexURL, wantURL)
	}
	// The /d/<name> path-proxy form must NOT leak into the CLI snippet —
	// it'd silently break `npx convex dev`.
	if strings.Contains(got.ConvexURL, "/d/") {
		t.Errorf("CLI URL must not use /d/<name> proxy form: %q", got.ConvexURL)
	}
}

// When BaseDomain is set, every deployment gets its own subdomain — that
// is already a root URL, no port-strip needed. Verifies CLI snippet uses
// the wildcard form instead of falling back.
func TestDeployments_CLICredentialsBaseDomainURL(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL:    "http://synapse.example.com:8080",
		ProxyEnabled: true,
		BaseDomain:   "convex.example.com",
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "CLIWild Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "cli-bee-4242", "prod", "running", true, owner.ID, 3300, "key-bd")

	var got cliCredentialsResp
	h.DoJSON(http.MethodGet, "/v1/deployments/cli-bee-4242/cli_credentials",
		owner.AccessToken, nil, http.StatusOK, &got)

	wantURL := "https://cli-bee-4242.convex.example.com"
	if got.ConvexURL != wantURL {
		t.Errorf("convexUrl: got %q want %q", got.ConvexURL, wantURL)
	}
}

// Custom api-role domain wins over every other URL form when active.
// This is the operator-friendly path: they set api.<client>.com on the
// deployment, pointed DNS, and Caddy issues TLS — the snippet should
// hand `https://api.<client>.com` to the CLI, not host:port (which
// requires the dynamic backend port to be open in the firewall) or the
// random `<name>.<BaseDomain>` (which is ugly and nobody memorizes).
func TestDeployments_CLICredentialsPrefersActiveAPIDomain(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		// Both PublicURL+HostPort and BaseDomain are set so we can prove
		// the custom-domain branch wins over the others, not just over
		// the empty case.
		PublicURL:    "http://synapse.example.com:8080",
		ProxyEnabled: true,
		BaseDomain:   "convex.example.com",
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "CLIDomain Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	depID := h.SeedDeployment(proj.ID, "cli-cat-7000", "prod", "running", true, owner.ID, 3310, "key-cd")

	// Seed an active api-role domain row. Mimics what
	// /v1/deployments/{name}/domains would create then verify.
	insertDomain(t, h, depID, "api.example.com", "api", "active")

	var got cliCredentialsResp
	h.DoJSON(http.MethodGet, "/v1/deployments/cli-cat-7000/cli_credentials",
		owner.AccessToken, nil, http.StatusOK, &got)

	wantURL := "https://api.example.com"
	if got.ConvexURL != wantURL {
		t.Errorf("convexUrl: got %q want %q (custom api domain must win over BaseDomain + PublicURL)",
			got.ConvexURL, wantURL)
	}
	// Sanity: the URL must NOT carry the deployment name or a port —
	// custom domain is the whole story.
	if strings.Contains(got.ConvexURL, "cli-cat-7000") {
		t.Errorf("custom-domain URL should not embed deployment name: %q", got.ConvexURL)
	}
	if strings.Contains(got.ConvexURL, ":3310") {
		t.Errorf("custom-domain URL should not embed host port: %q", got.ConvexURL)
	}
}

// Pending domain rows must NOT be used. Domains start in 'pending' until
// DNS verification succeeds — using them prematurely would emit a URL
// that doesn't resolve. Should fall through to the legacy decision.
func TestDeployments_CLICredentialsIgnoresPendingDomain(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL:    "http://synapse.example.com:8080",
		ProxyEnabled: true,
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "CLIPending Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	depID := h.SeedDeployment(proj.ID, "cli-owl-7100", "dev", "running", false, owner.ID, 3311, "key-pd")

	insertDomain(t, h, depID, "api-pending.example.com", "api", "pending")

	var got cliCredentialsResp
	h.DoJSON(http.MethodGet, "/v1/deployments/cli-owl-7100/cli_credentials",
		owner.AccessToken, nil, http.StatusOK, &got)

	// Pending row ignored → falls through to PublicURL+HostPort path.
	wantURL := "http://synapse.example.com:3311"
	if got.ConvexURL != wantURL {
		t.Errorf("convexUrl: got %q want %q (pending domain must be ignored)", got.ConvexURL, wantURL)
	}
}

// dashboard-role domains route to the Convex Dashboard container, NOT the
// backend — using one as the CLI URL would point `npx convex` at a UI
// that doesn't speak `/api/...`. Must fall through.
func TestDeployments_CLICredentialsIgnoresDashboardRoleDomain(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL:    "http://synapse.example.com:8080",
		ProxyEnabled: true,
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "CLIDashRole Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	depID := h.SeedDeployment(proj.ID, "cli-bee-7200", "dev", "running", false, owner.ID, 3312, "key-dr")

	insertDomain(t, h, depID, "dash.example.com", "dashboard", "active")

	var got cliCredentialsResp
	h.DoJSON(http.MethodGet, "/v1/deployments/cli-bee-7200/cli_credentials",
		owner.AccessToken, nil, http.StatusOK, &got)

	wantURL := "http://synapse.example.com:3312"
	if got.ConvexURL != wantURL {
		t.Errorf("convexUrl: got %q want %q (dashboard-role domain must be ignored)", got.ConvexURL, wantURL)
	}
}

// /auth feeds the embedded Convex Dashboard via postMessage. The dashboard
// upstream uses `new URL("/api/...", deploymentUrl)` — host-anchored, same
// trap as the CLI. With ProxyEnabled on, the legacy publicDeploymentURL
// would have emitted `<host>/d/<name>`, which silently drops the path
// when the dashboard composes API URLs. /auth must return a root URL.
func TestDeployments_AuthReturnsRootURLNotProxyPath(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL:    "http://synapse.example.com:8080",
		ProxyEnabled: true,
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "AuthRoot Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "auth-fox-8000", "dev", "running", false, owner.ID, 3320, "key-auth-rt")

	var got deploymentAuthResp
	h.DoJSON(http.MethodGet, "/v1/deployments/auth-fox-8000/auth",
		owner.AccessToken, nil, http.StatusOK, &got)

	wantURL := "http://synapse.example.com:3320"
	if got.DeploymentURL != wantURL {
		t.Errorf("deploymentUrl: got %q want %q (must be root URL — no /d/ proxy form)",
			got.DeploymentURL, wantURL)
	}
	if strings.Contains(got.DeploymentURL, "/d/") {
		t.Errorf("/auth must not return /d/<name> proxy form (Convex Dashboard would 404 on /api/*): %q",
			got.DeploymentURL)
	}
}

// /auth must also honour active api-role custom domains (same precedence
// as cli_credentials). This is the production case for the agency: each
// deployment has api.<client>.com pointed at it, the embedded dashboard
// should resolve through that domain.
func TestDeployments_AuthPrefersActiveAPIDomain(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL:    "http://synapse.example.com:8080",
		ProxyEnabled: true,
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "AuthDomain Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	depID := h.SeedDeployment(proj.ID, "auth-cat-8100", "prod", "running", true, owner.ID, 3321, "key-auth-cd")

	insertDomain(t, h, depID, "api.client.com", "api", "active")

	var got deploymentAuthResp
	h.DoJSON(http.MethodGet, "/v1/deployments/auth-cat-8100/auth",
		owner.AccessToken, nil, http.StatusOK, &got)

	wantURL := "https://api.client.com"
	if got.DeploymentURL != wantURL {
		t.Errorf("deploymentUrl: got %q want %q", got.DeploymentURL, wantURL)
	}
}

// insertDomain seeds a deployment_domains row directly via SQL so URL-
// rewrite tests don't have to spin up the full /domains POST + DNS
// verification flow (which depends on PublicIP being set, etc).
func insertDomain(t *testing.T, h *Harness, deploymentID, domain, role, status string) {
	t.Helper()
	_, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO deployment_domains (deployment_id, domain, role, status)
		VALUES ($1, $2, $3, $4)
	`, deploymentID, domain, role, status)
	if err != nil {
		t.Fatalf("insert deployment_domain: %v", err)
	}
}

func TestDeployments_CLICredentialsAnonymous401(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "CLIAnon Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "cli-anon-2222", "dev", "running", true, owner.ID, 3221, "")

	// No bearer at all → 401 from the auth middleware.
	env := h.AssertStatus(http.MethodGet, "/v1/deployments/cli-anon-2222/cli_credentials",
		"", nil, http.StatusUnauthorized)
	if env.Code == "" {
		t.Errorf("expected error code on 401, got empty envelope")
	}
}

func TestDeployments_CLICredentialsNonMember403(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	stranger := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "CLIStranger Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "cli-stranger-3333", "dev", "running", false, owner.ID, 3222, "")

	env := h.AssertStatus(http.MethodGet, "/v1/deployments/cli-stranger-3333/cli_credentials",
		stranger.AccessToken, nil, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}
}

func TestDeployments_CLICredentialsUnknown404(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	env := h.AssertStatus(http.MethodGet, "/v1/deployments/no-such-name/cli_credentials",
		owner.AccessToken, nil, http.StatusNotFound)
	if env.Code != "deployment_not_found" {
		t.Errorf("got code %q want deployment_not_found", env.Code)
	}
}

func TestDeployments_DeleteMarksRowDeletedAndCallsDocker(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Del Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	id := h.SeedDeployment(proj.ID, "del-wolf-3333", "dev", "running", true, owner.ID, 3215, "")

	h.DoJSON(http.MethodPost, "/v1/deployments/del-wolf-3333/delete", owner.AccessToken,
		nil, http.StatusOK, &map[string]string{})

	// Fake docker should have been called with the deployment name.
	if len(h.Docker.Destroyed) != 1 || h.Docker.Destroyed[0] != "del-wolf-3333" {
		t.Errorf("expected fake Destroy([del-wolf-3333]), got %v", h.Docker.Destroyed)
	}

	// Row is now status=deleted with cleared host_port + container_id.
	var status string
	var hostPort *int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT status, host_port FROM deployments WHERE id = $1`, id).Scan(&status, &hostPort); err != nil {
		t.Fatalf("read deployment row: %v", err)
	}
	if status != "deleted" {
		t.Errorf("status: got %q want deleted", status)
	}
	if hostPort != nil {
		t.Errorf("expected host_port to be nulled, got %v", *hostPort)
	}
}

func TestDeployments_DeleteAdminOnly(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	member := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Member Del Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "stay-cat-4444", "dev", "running", true, owner.ID, 3216, "")

	if _, err := h.DB.Exec(h.rootCtx,
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
		team.ID, member.ID); err != nil {
		t.Fatalf("seed member: %v", err)
	}

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/stay-cat-4444/delete",
		member.AccessToken, nil, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}
	// Fake docker should NOT have been called.
	if len(h.Docker.Destroyed) != 0 {
		t.Errorf("expected no destroys, got %v", h.Docker.Destroyed)
	}
}

func TestDeployments_ListExcludesDeleted(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "List Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")

	// Two live deployments + one deleted.
	h.SeedDeployment(proj.ID, "live-fox-1111", "dev", "running", true, owner.ID, 3217, "")
	h.SeedDeployment(proj.ID, "live-fox-2222", "prod", "running", false, owner.ID, 3218, "")
	h.SeedDeployment(proj.ID, "dead-fox-3333", "dev", "deleted", false, owner.ID, 0, "")

	var fromTeam []deploymentResp
	h.DoJSON(http.MethodGet, "/v1/teams/"+team.Slug+"/list_deployments",
		owner.AccessToken, nil, http.StatusOK, &fromTeam)
	if len(fromTeam) != 2 {
		t.Errorf("team list_deployments: expected 2 live, got %d (%+v)", len(fromTeam), fromTeam)
	}

	var fromProject []deploymentResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/list_deployments",
		owner.AccessToken, nil, http.StatusOK, &fromProject)
	if len(fromProject) != 2 {
		t.Errorf("project list_deployments: expected 2 live, got %d", len(fromProject))
	}

	// Deleted one should not be retrievable individually either.
	env := h.AssertStatus(http.MethodGet, "/v1/deployments/dead-fox-3333",
		owner.AccessToken, nil, http.StatusNotFound)
	if env.Code != "deployment_not_found" {
		t.Errorf("got code %q want deployment_not_found", env.Code)
	}
}

// TestDeployments_CreateReturnsImmediatelyAndProvisionsAsync covers the new
// async contract: POST /create_deployment returns 201 the instant the row is
// inserted (status="provisioning"), and FakeDocker.Provision is invoked
// shortly after on a background goroutine.
func TestDeployments_CreateReturnsImmediatelyAndProvisionsAsync(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Async Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "AsyncProj")

	// Make Provision slow-ish so the response definitely beats it. If the
	// handler were still synchronous, our 201 wouldn't arrive until after
	// this sleep — which would fail the elapsed-time assertion below.
	provisionDone := make(chan struct{})
	h.Docker.ProvisionFn = func(_ context.Context, spec dockerprov.DeploymentSpec) (*dockerprov.DeploymentInfo, error) {
		defer close(provisionDone)
		time.Sleep(150 * time.Millisecond)
		return &dockerprov.DeploymentInfo{
			ContainerID:   "fake-" + spec.Name,
			HostPort:      spec.HostPort,
			DeploymentURL: "http://127.0.0.1:" + itoa(spec.HostPort),
		}, nil
	}

	start := time.Now()
	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]string{"type": "dev"}, http.StatusCreated, &got)
	elapsed := time.Since(start)

	if got.Status != "provisioning" {
		t.Errorf("status: got %q want provisioning", got.Status)
	}
	if got.Name == "" {
		t.Errorf("expected a generated name, got empty")
	}
	// Generous bound — request should return well before Provision finishes.
	if elapsed >= 150*time.Millisecond {
		t.Errorf("expected fast return; elapsed=%v (handler still sync?)", elapsed)
	}

	// Wait for the goroutine to call Provision.
	select {
	case <-provisionDone:
	case <-time.After(5 * time.Second):
		t.Fatalf("Provision was never called by the background goroutine")
	}

	// Now poll until the row flips to "running".
	waitForStatus(t, h, got.Name, "running", 5*time.Second)

	// FakeDocker recorded the call.
	if len(h.Docker.Provisioned) != 1 || h.Docker.Provisioned[0].Name != got.Name {
		t.Errorf("expected Provisioned([%s]), got %+v", got.Name, h.Docker.Provisioned)
	}
}

// v1.17+: project_env_vars no longer flow into container ENV. They
// land in the Convex backend's function runtime store via the
// convexenv client. The provisioner's spec.EnvVars should carry ONLY
// system vars (CORS_ALLOWED_ORIGINS when an active custom domain
// exists; nothing project-derived otherwise).
func TestDeployments_Create_DoesNotInjectProjectEnvVarsIntoContainer(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Env Runtime Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "EnvRuntime")

	// Seed project env vars across all the deployment-type slices the
	// old test exercised — they must all stay OUT of spec.EnvVars.
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		owner.AccessToken,
		map[string]any{"changes": []map[string]any{
			{"op": "set", "name": "SHARED", "value": "yes"},
			{"op": "set", "name": "PROD_ONLY", "value": "prod", "deploymentTypes": []string{"prod"}},
			{"op": "set", "name": "DEV_ONLY", "value": "dev", "deploymentTypes": []string{"dev"}},
			{"op": "set", "name": "CUSTOM_ONLY", "value": "custom", "deploymentTypes": []string{"custom"}},
		}},
		http.StatusOK, nil)

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]string{"type": "prod"}, http.StatusCreated, &got)
	waitForStatus(t, h, got.Name, "running", 5*time.Second)

	specs := h.Docker.ProvisionedSpecs()
	if len(specs) != 1 {
		t.Fatalf("expected 1 Provision call, got %d (%+v)", len(specs), specs)
	}
	env := specs[0].EnvVars

	// Regression guards: every project_env_var name from the seed must
	// be ABSENT from container env. Functions read these via the Convex
	// backend's runtime env store, not process.env — see
	// docs/ENV_PIPELINE_PLAN.md §3 for the three env categories.
	for _, name := range []string{"SHARED", "PROD_ONLY", "DEV_ONLY", "CUSTOM_ONLY"} {
		if _, present := env[name]; present {
			t.Errorf("%s leaked into container spec.EnvVars (%+v) — must go through convexenv only", name, env)
		}
	}
}

// TestDeployments_CreateAsyncFailureMarksRowFailed covers the unhappy path:
// FakeDocker returns an error from Provision, so the goroutine should
// transition the row to "failed" (not leave it stuck in "provisioning").
func TestDeployments_CreateAsyncFailureMarksRowFailed(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Fail Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "FailProj")

	h.Docker.ProvisionFn = func(_ context.Context, _ dockerprov.DeploymentSpec) (*dockerprov.DeploymentInfo, error) {
		return nil, errBoom
	}

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]string{"type": "dev"}, http.StatusCreated, &got)
	if got.Status != "provisioning" {
		t.Fatalf("status: got %q want provisioning (initial state)", got.Status)
	}

	waitForStatus(t, h, got.Name, "failed", 5*time.Second)

	// last_deploy_at should be populated so the UI knows when we gave up.
	var lastDeploy *time.Time
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT last_deploy_at FROM deployments WHERE name = $1`, got.Name).
		Scan(&lastDeploy); err != nil {
		t.Fatalf("read last_deploy_at: %v", err)
	}
	if lastDeploy == nil {
		t.Errorf("expected last_deploy_at to be set on failed provision")
	}
}

// TestDeployments_ListIncludesProvisioning ensures the row is visible in
// list_deployments while still mid-provisioning. Without this, the dashboard
// can't show the "provisioning..." badge while the goroutine is in flight.
func TestDeployments_ListIncludesProvisioning(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Vis Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "VisProj")

	// Block Provision so the row stays in "provisioning" for the duration
	// of the assertions below. We unblock at the end so the goroutine can
	// exit cleanly before the test (and its DB) tears down.
	release := make(chan struct{})
	h.Docker.ProvisionFn = func(ctx context.Context, spec dockerprov.DeploymentSpec) (*dockerprov.DeploymentInfo, error) {
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return &dockerprov.DeploymentInfo{
			ContainerID:   "fake-" + spec.Name,
			HostPort:      spec.HostPort,
			DeploymentURL: "http://127.0.0.1:" + itoa(spec.HostPort),
		}, nil
	}
	defer close(release)

	var created deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]string{"type": "dev"}, http.StatusCreated, &created)

	var listed []deploymentResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/list_deployments",
		owner.AccessToken, nil, http.StatusOK, &listed)
	if len(listed) != 1 {
		t.Fatalf("expected 1 deployment, got %d (%+v)", len(listed), listed)
	}
	if listed[0].Name != created.Name {
		t.Errorf("listed name mismatch: got %q want %q", listed[0].Name, created.Name)
	}
	if listed[0].Status != "provisioning" {
		t.Errorf("status: got %q want provisioning", listed[0].Status)
	}
}

func TestDeployments_DeleteIdempotentOnDockerError(t *testing.T) {
	// If the fake docker returns an error, we should NOT mark the row deleted —
	// the operator can retry. Mirrors the prod contract.
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Err Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	id := h.SeedDeployment(proj.ID, "fail-bee-9999", "dev", "running", true, owner.ID, 3219, "")

	h.Docker.DestroyFn = func(_ context.Context, _ string) error {
		return errBoom
	}

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/fail-bee-9999/delete",
		owner.AccessToken, nil, http.StatusInternalServerError)
	if env.Code != "destroy_failed" {
		t.Errorf("got code %q want destroy_failed", env.Code)
	}

	// Row remains running so the operator can retry after fixing docker.
	var status string
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT status FROM deployments WHERE id = $1`, id).Scan(&status); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if status != "running" {
		t.Errorf("status: got %q want running (retry-able)", status)
	}
}

// Restart bounces the deployment's container; refuses for adopted (no managed
// container) and for unauthenticated callers.
func TestRestartDeployment(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Restart Team")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "restart-proj")
	h.SeedDeployment(proj.ID, "bright-fox-3030", "dev", "running", true, owner.ID, 3210, "")

	// happy path → 200, container restarted
	h.Docker.Restarted = nil
	h.DoJSON(http.MethodPost, "/v1/deployments/bright-fox-3030/restart", owner.AccessToken, map[string]any{}, http.StatusOK, &map[string]string{})
	found := false
	for _, n := range h.Docker.RestartedNames() {
		if n == "bright-fox-3030" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a Restart for bright-fox-3030, got %v", h.Docker.RestartedNames())
	}

	// unauthenticated → 401
	h.AssertStatus(http.MethodPost, "/v1/deployments/bright-fox-3030/restart", "", map[string]any{}, http.StatusUnauthorized)

	// adopted deployment → 409 (no Synapse-managed container)
	if _, err := h.DB.Exec(h.rootCtx, `UPDATE deployments SET adopted = true WHERE name = $1`, "bright-fox-3030"); err != nil {
		t.Fatalf("mark adopted: %v", err)
	}
	env := h.AssertStatus(http.MethodPost, "/v1/deployments/bright-fox-3030/restart", owner.AccessToken, map[string]any{}, http.StatusConflict)
	if env.Code != "cannot_restart_adopted" {
		t.Errorf("expected cannot_restart_adopted, got %q", env.Code)
	}
}

// ---------- v1.18.0 Phase 4: Remote Hosts placement ----------

// seedRemoteHost inserts a hosts row that looks like one registered via
// install-agent.sh: is_remote=true, tailnet_addr populated, an encrypted
// privkey blob present so create_deployment's host_not_provisioned guard
// doesn't trip. The blob is not a real ciphertext — Phase 4 validation
// only checks IS NOT NULL, never decrypts. Returns the new host id.
func seedRemoteHost(t *testing.T, h *Harness, name, tailnetAddr string, draining bool, withSSHKey bool) string {
	t.Helper()
	status := "online"
	if draining {
		status = "draining"
	}
	var pk any
	if withSSHKey {
		pk = []byte("not-a-real-ciphertext-but-non-nil")
	}
	var id string
	if err := h.DB.QueryRow(h.rootCtx, `
		INSERT INTO hosts (name, provider, region, status, is_remote, tailnet_addr,
		                    ssh_pubkey, ssh_privkey_encrypted, ssh_privkey_fingerprint)
		VALUES ($1, 'remote-test', '', $2, TRUE, $3,
		        'ssh-ed25519 AAAA test', $4, 'SHA256:abcd')
		RETURNING id::text
	`, name, status, tailnetAddr, pk).Scan(&id); err != nil {
		t.Fatalf("seed remote host: %v", err)
	}
	return id
}

// TestCreateDeployment_HostIdDefaultsToSelfHost — omitting hostId on
// create persists the row against the is_synapse_host=true row and the
// response carries that host's id + name.
func TestCreateDeployment_HostIdDefaultsToSelfHost(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "DefHost Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "DefHostProj")

	var selfHostID string
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT id::text FROM hosts WHERE is_synapse_host = TRUE LIMIT 1`,
	).Scan(&selfHostID); err != nil {
		t.Fatalf("locate self-host: %v", err)
	}

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken,
		map[string]any{"type": "dev"}, http.StatusCreated, &got)

	if got.HostID != selfHostID {
		t.Errorf("host_id: got %q want self-host %q", got.HostID, selfHostID)
	}
	if got.HostIsRemote {
		t.Errorf("self-host should report is_remote=false")
	}

	// Verify the DB row, not just the response shape.
	var dbHostID string
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT host_id::text FROM deployments WHERE name = $1`, got.Name,
	).Scan(&dbHostID); err != nil {
		t.Fatalf("read deployments.host_id: %v", err)
	}
	if dbHostID != selfHostID {
		t.Errorf("persisted host_id: got %q want %q", dbHostID, selfHostID)
	}
}

// TestCreateDeployment_AcceptsHostId — operator places a deployment on
// a seeded remote host. The row persists with the supplied host_id and
// the response surfaces host_name + host_tailnet_addr from the JOIN.
func TestCreateDeployment_AcceptsHostId(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "RemoteCo")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "RemoteProj")

	hostID := seedRemoteHost(t, h, "vps-eu-1", "100.64.0.5", false, true)

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken,
		map[string]any{"type": "prod", "hostId": hostID},
		http.StatusCreated, &got)

	if got.HostID != hostID {
		t.Errorf("host_id: got %q want %q", got.HostID, hostID)
	}
	if got.HostName != "vps-eu-1" {
		t.Errorf("host_name: got %q want vps-eu-1", got.HostName)
	}
	if got.HostTailnetAddr != "100.64.0.5" {
		t.Errorf("host_tailnet_addr: got %q want 100.64.0.5", got.HostTailnetAddr)
	}
	if !got.HostIsRemote {
		t.Errorf("host_is_remote: got false want true")
	}

	// Cancel the provisioning job we just enqueued — the test FakeDocker
	// + worker will run dockerForJob → SSH=nil → markFailed the job with
	// the "Remote Hosts disabled" hint, which is exactly the correct
	// behaviour for a test that never wired sshprov. Wait for the row
	// to settle to 'failed' so cleanup tears down deterministically.
	waitForStatus(t, h, got.Name, "failed", 5*time.Second)
}

// TestCreateDeployment_HostNotFound — supplying a UUID that doesn't
// match any row returns 400 host_not_found with no DB writes.
func TestCreateDeployment_HostNotFound(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "NotFoundCo")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "NotFoundProj")

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken,
		map[string]any{"type": "prod", "hostId": "00000000-0000-0000-0000-000000000000"},
		http.StatusBadRequest)
	if env.Code != "host_not_found" {
		t.Errorf("code: got %q want host_not_found", env.Code)
	}

	// No deployment row should have been written.
	var n int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT COUNT(*) FROM deployments WHERE project_id = $1`, proj.ID,
	).Scan(&n); err != nil {
		t.Fatalf("count deployments: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 deployments after validation reject, got %d", n)
	}
}

// TestCreateDeployment_HostDraining — refuses placement on a draining
// host. Operator's correct move is to pick another host.
func TestCreateDeployment_HostDraining(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "DrainingCo")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "DrainingProj")

	hostID := seedRemoteHost(t, h, "vps-drain", "100.64.0.6", true, true)

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken,
		map[string]any{"type": "prod", "hostId": hostID},
		http.StatusBadRequest)
	if env.Code != "host_draining" {
		t.Errorf("code: got %q want host_draining", env.Code)
	}
	if !strings.Contains(env.Message, "vps-drain") {
		t.Errorf("message should name the host; got %q", env.Message)
	}
}

// TestCreateDeployment_RemoteHostMissingSSHKey — is_remote=true but no
// ssh_privkey_encrypted on the row → host_not_provisioned. Mirrors the
// production failure mode where install-agent.sh registered the host
// metadata but the privkey upload step never reached central.
func TestCreateDeployment_RemoteHostMissingSSHKey(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "NoKeyCo")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "NoKeyProj")

	hostID := seedRemoteHost(t, h, "vps-nokey", "100.64.0.7", false, false)

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken,
		map[string]any{"type": "prod", "hostId": hostID},
		http.StatusBadRequest)
	if env.Code != "host_not_provisioned" {
		t.Errorf("code: got %q want host_not_provisioned", env.Code)
	}
	if !strings.Contains(env.Message, "vps-nokey") {
		t.Errorf("message should name the host; got %q", env.Message)
	}
}

// TestListDeployments_IncludesHostFields — after creating one
// deployment on the self-host and one on a remote host, list_deployments
// returns host_id + host_name + host_tailnet_addr for each row.
func TestListDeployments_IncludesHostFields(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "ListHostCo")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "ListHostProj")

	// Self-host placement via SeedDeployment (default routing).
	h.SeedDeployment(proj.ID, "local-fox-7001", "dev", "running", true, owner.ID, 3270, "")
	// Remote-host placement: insert the row directly so we control
	// host_id without going through the worker (which would markFailed
	// the job since SSH=nil in tests).
	remoteHostID := seedRemoteHost(t, h, "vps-list", "100.64.0.8", false, true)
	if _, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO deployments (project_id, name, deployment_type, status, host_port,
		                          admin_key, instance_secret, is_default,
		                          deployment_url, container_id, host_id)
		VALUES ($1, 'remote-fox-7002', 'prod', 'running', 3271,
		        'fake-admin', 'fake-secret', FALSE,
		        'https://remote-fox-7002.example.com', 'fake-container', $2)
	`, proj.ID, remoteHostID); err != nil {
		t.Fatalf("seed remote-placed deployment: %v", err)
	}
	// Mirror the replica row that SeedDeployment normally creates so
	// downstream invariants stay consistent.
	if _, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO deployment_replicas (deployment_id, replica_index, container_id, host_port, status)
		SELECT id, 0, 'fake-container', 3271, 'running' FROM deployments WHERE name = 'remote-fox-7002'
	`); err != nil {
		t.Fatalf("seed remote replica: %v", err)
	}

	var list []deploymentResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/list_deployments",
		owner.AccessToken, nil, http.StatusOK, &list)

	if len(list) != 2 {
		t.Fatalf("list size: got %d want 2 (%+v)", len(list), list)
	}

	byName := map[string]deploymentResp{}
	for _, d := range list {
		byName[d.Name] = d
	}
	local, ok := byName["local-fox-7001"]
	if !ok {
		t.Fatalf("local deployment missing from list")
	}
	if local.HostID == "" {
		t.Errorf("local.host_id should be populated (self-host id)")
	}
	if local.HostIsRemote {
		t.Errorf("local.host_is_remote: got true want false")
	}

	remote, ok := byName["remote-fox-7002"]
	if !ok {
		t.Fatalf("remote deployment missing from list")
	}
	if remote.HostID != remoteHostID {
		t.Errorf("remote.host_id: got %q want %q", remote.HostID, remoteHostID)
	}
	if remote.HostName != "vps-list" {
		t.Errorf("remote.host_name: got %q want vps-list", remote.HostName)
	}
	if remote.HostTailnetAddr != "100.64.0.8" {
		t.Errorf("remote.host_tailnet_addr: got %q want 100.64.0.8", remote.HostTailnetAddr)
	}
	if !remote.HostIsRemote {
		t.Errorf("remote.host_is_remote: got false want true")
	}
}
