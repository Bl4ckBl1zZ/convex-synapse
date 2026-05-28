package synapsetest

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/proxy"
)

// Spin up a local HTTP server, treat it as the "convex backend" the proxy
// forwards to, seed a deployment row pointing at it, and round-trip a
// request through proxy.Handler.
func TestProxy_ForwardsToResolvedAddress(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Proxied")
	project := createProject(t, h, owner.AccessToken, team.Slug, "App")

	// Upstream that records what it received.
	var hitPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hitPath = r.URL.Path
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("upstream-ok:" + r.URL.Path))
	}))
	t.Cleanup(upstream.Close)

	// Extract the port the test server picked.
	_, portStr, err := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	if err != nil {
		t.Fatalf("split upstream URL: %v", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("port: %v", err)
	}

	// Seed a deployment row pointing at the upstream port.
	h.SeedDeployment(project.ID, "px-cat-1234", "dev", "running", false, owner.ID, port, "k")

	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Second}
	srv := httptest.NewServer(proxy.Handler(resolver, nil, ""))
	t.Cleanup(srv.Close)

	// GET /d/px-cat-1234/api/check_admin_key → upstream sees /api/check_admin_key
	resp, err := http.Get(srv.URL + "/d/px-cat-1234/api/check_admin_key")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Errorf("status: got %d, want 200; body=%s", resp.StatusCode, string(body))
	}
	if hitPath != "/api/check_admin_key" {
		t.Errorf("upstream saw %q; want /api/check_admin_key", hitPath)
	}
	if !strings.HasPrefix(string(body), "upstream-ok:") {
		t.Errorf("body: got %q; want prefix upstream-ok:", string(body))
	}
}

func TestProxy_404OnMissingDeployment(t *testing.T) {
	h := Setup(t)
	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Second}
	srv := httptest.NewServer(proxy.Handler(resolver, nil, ""))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/d/does-not-exist/anything")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status: got %d, want 404", resp.StatusCode)
	}
}

// A "deleted" or "failed" deployment row must not be reachable through the proxy.
func TestProxy_404ForNonRunningDeployment(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Px2")
	project := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(project.ID, "down-fox-1234", "dev", "failed", false, owner.ID, 9999, "k")

	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Second}
	srv := httptest.NewServer(proxy.Handler(resolver, nil, ""))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/d/down-fox-1234/api/check_admin_key")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status: got %d, want 404", resp.StatusCode)
	}
}

// The Resolver caches name → address until TTL expires.
func TestProxy_ResolverCaches(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Cache")
	project := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(project.ID, "cached-owl-1234", "dev", "running", false, owner.ID, 4242, "k")

	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Hour}

	got1, err := resolver.Resolve(context.Background(), "cached-owl-1234")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got1 != "127.0.0.1:4242" {
		t.Errorf("got %q; want 127.0.0.1:4242", got1)
	}

	// Mutate the replica's port directly. With cache active, Resolve should
	// still return the OLD address. (Post-v0.5 the proxy reads from
	// deployment_replicas, not deployments.host_port — see chunk 5.)
	if _, err := h.DB.Exec(context.Background(),
		`UPDATE deployment_replicas
		    SET host_port = 5252
		   FROM deployments
		  WHERE deployment_replicas.deployment_id = deployments.id
		    AND deployments.name = 'cached-owl-1234'`); err != nil {
		t.Fatalf("update: %v", err)
	}
	got2, _ := resolver.Resolve(context.Background(), "cached-owl-1234")
	if got2 != "127.0.0.1:4242" {
		t.Errorf("cache miss: got %q; want stale 127.0.0.1:4242", got2)
	}

	// Invalidate → next resolve hits DB and sees the new port.
	resolver.Invalidate("cached-owl-1234")
	got3, _ := resolver.Resolve(context.Background(), "cached-owl-1234")
	if got3 != "127.0.0.1:5252" {
		t.Errorf("post-invalidate: got %q; want 127.0.0.1:5252", got3)
	}
}

// TestProxy_HostBasedRouting (v1.0+): when proxy.Handler is wired with
// a baseDomain, requests where Host == "<name>.<base>" route to the
// matching deployment using the request path verbatim — no /d/ prefix
// required. This is the path Caddy takes after on-demand TLS for a
// per-deployment subdomain.
func TestProxy_HostBasedRouting(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Host Co")
	project := createProject(t, h, owner.AccessToken, team.Slug, "Host Proj")

	var hitPath, hitHost string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hitPath = r.URL.Path
		hitHost = r.Host
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(upstream.Close)

	_, portStr, _ := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	h.SeedDeployment(project.ID, "host-fox-1234", "dev", "running", false, owner.ID, port, "k")

	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Second}
	srv := httptest.NewServer(proxy.Handler(resolver, nil, "synapse.example.com"))
	t.Cleanup(srv.Close)

	// Send a request with Host = "host-fox-1234.synapse.example.com" and
	// path /api/check_admin_key (no /d/ prefix). Because httptest's URL
	// is 127.0.0.1:<port>, we have to set Host on the *Request* directly.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/check_admin_key", nil)
	req.Host = "host-fox-1234.synapse.example.com"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Errorf("status: got %d, want 200", resp.StatusCode)
	}
	if hitPath != "/api/check_admin_key" {
		t.Errorf("upstream path: got %q want /api/check_admin_key", hitPath)
	}
	_ = hitHost
}

// TestProxy_HostBased_NotFoundOutsideBase: when baseDomain is set but
// Host doesn't match, fall through to path-based routing — and 404
// when the path isn't /d/ either. Verifies the dispatch tree doesn't
// accidentally swallow non-proxy requests.
func TestProxy_HostBased_NotFoundOutsideBase(t *testing.T) {
	h := Setup(t)
	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Second}
	srv := httptest.NewServer(proxy.Handler(resolver, nil, "synapse.example.com"))
	t.Cleanup(srv.Close)

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/random", nil)
	req.Host = "evil.example.com"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status: got %d, want 404", resp.StatusCode)
	}
}

// TestProxy_HostBased_PathStillWorks: with baseDomain configured,
// internal /d/ path requests must STILL work — that's how compose-
// network calls reach a deployment from the synapse-api process.
func TestProxy_HostBased_PathStillWorks(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Both Co")
	project := createProject(t, h, owner.AccessToken, team.Slug, "Both Proj")

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok:" + r.URL.Path))
	}))
	t.Cleanup(upstream.Close)
	_, portStr, _ := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	h.SeedDeployment(project.ID, "both-fox-9999", "dev", "running", false, owner.ID, port, "k")

	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Second}
	srv := httptest.NewServer(proxy.Handler(resolver, nil, "synapse.example.com"))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/d/both-fox-9999/version")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != "ok:/version" {
		t.Errorf("path-based with baseDomain set: status=%d body=%q", resp.StatusCode, body)
	}
}

// TestResolveAllSite_DNSReportsTo3211: in network-DNS mode the site
// resolver returns the same docker-DNS host as the cloud path but on
// port 3211. The cloud path stays on 3210, untouched. The DNS→upstream
// happy path is exercised against real docker in staging (Phase 8).
func TestResolveAllSite_DNSReportsTo3211(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "SiteRes Co")
	project := createProject(t, h, owner.AccessToken, team.Slug, "SiteRes Proj")
	h.SeedDeployment(project.ID, "site-fox-1234", "dev", "running", false, owner.ID, 3999, "k")

	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: true, CacheTTL: time.Second}
	site, err := resolver.ResolveAllSite(context.Background(), "site-fox-1234")
	if err != nil {
		t.Fatalf("ResolveAllSite: %v", err)
	}
	if len(site) != 1 || site[0] != "convex-site-fox-1234:3211" {
		t.Fatalf("ResolveAllSite: got %v want [convex-site-fox-1234:3211]", site)
	}
	cloud, err := resolver.ResolveAll(context.Background(), "site-fox-1234")
	if err != nil {
		t.Fatalf("ResolveAll: %v", err)
	}
	if len(cloud) != 1 || cloud[0] != "convex-site-fox-1234:3210" {
		t.Fatalf("ResolveAll (cloud must stay 3210): got %v", cloud)
	}
}

// TestResolveAllSite_HostPortUnsupported: host-port mode doesn't publish
// 3211, so the site resolver refuses with ErrSiteUnsupported rather than
// returning a wrong address.
func TestResolveAllSite_HostPortUnsupported(t *testing.T) {
	h := Setup(t)
	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Second}
	_, err := resolver.ResolveAllSite(context.Background(), "anything")
	if !errors.Is(err, proxy.ErrSiteUnsupported) {
		t.Fatalf("ResolveAllSite host-port: got %v want ErrSiteUnsupported", err)
	}
}

// TestProxy_SiteSubdomain_DispatchesToSiteResolver: a request to
// "<name>.site.<base>" must be recognised as a site request and routed
// through the site resolver — proven here by the host-port refusal
// surfacing as 501 (the Handler detected the site form, called
// ResolveAllSite, and got ErrSiteUnsupported). Confirms the cloud
// wildcard form is NOT what handled it.
func TestProxy_SiteSubdomain_DispatchesToSiteResolver(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "SiteDisp Co")
	project := createProject(t, h, owner.AccessToken, team.Slug, "SiteDisp Proj")
	h.SeedDeployment(project.ID, "sitehp-fox-1234", "dev", "running", false, owner.ID, 3998, "k")

	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Second}
	srv := httptest.NewServer(proxy.Handler(resolver, nil, "app.synapsepanel.com"))
	t.Cleanup(srv.Close)

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/get-session", nil)
	req.Host = "sitehp-fox-1234.site.app.synapsepanel.com"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotImplemented {
		t.Errorf("site host in host-port mode: status=%d want 501", resp.StatusCode)
	}
}

// ---- Remote host routing (v1.19+) ---------------------------------
//
// Phase 4 of v1.19 makes the proxy host-aware: deployments pinned to a
// remote host return `<tailnet_addr>:<host_port>` instead of the
// local docker DNS / 127.0.0.1 forms. The control plane uses these
// addresses to SSH/HTTP into the tailnet IP the remote provisioner
// bound the container to.
//
// We exercise these against an httptest upstream that we treat as
// "the remote container" — the tailnet IP we seed in the host row
// is whatever the test server happens to be listening on. That's
// the only way to drive the real proxy.Handler path without a
// running tailnet.

func TestProxy_RemoteDeployment_RoutesViaTailnetAddress(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Remote Co")
	project := createProject(t, h, owner.AccessToken, team.Slug, "App")

	// Upstream pretends to be the remote container. The host's
	// tailnet_addr is set to 127.0.0.1 so the proxy resolves to the
	// loopback port of this httptest server.
	var hitPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hitPath = r.URL.Path
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("remote-upstream-ok:" + r.URL.Path))
	}))
	t.Cleanup(upstream.Close)

	_, portStr, err := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	if err != nil {
		t.Fatalf("split upstream URL: %v", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("port: %v", err)
	}

	// Seed a deployment pinned to a remote host whose tailnet IP is
	// 127.0.0.1. The proxy resolver will compose 127.0.0.1:<port>.
	h.SeedRemoteDeployment(project.ID, "remote-fox-1234", "dev", "running",
		owner.ID, port, "k", "127.0.0.1")

	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Second}
	srv := httptest.NewServer(proxy.Handler(resolver, nil, ""))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/d/remote-fox-1234/api/check_admin_key")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Errorf("status: got %d, want 200; body=%s", resp.StatusCode, string(body))
	}
	if hitPath != "/api/check_admin_key" {
		t.Errorf("remote upstream saw %q; want /api/check_admin_key", hitPath)
	}
	if !strings.HasPrefix(string(body), "remote-upstream-ok:") {
		t.Errorf("body: got %q; want remote-upstream-ok: prefix", string(body))
	}
}

// TestProxy_RemoteDeployment_NetworkDNSStillUsesTailnet ensures that
// even when the control plane runs in compose-network mode (where
// LOCAL deployments resolve to convex-<name>:3210), REMOTE
// deployments STILL resolve to <tailnet>:<host_port>. The remote
// container isn't on the synapse-network bridge — the docker DNS
// name would not resolve from inside synapse-api.
func TestProxy_RemoteDeployment_NetworkDNSStillUsesTailnet(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "RemoteDNS Co")
	project := createProject(t, h, owner.AccessToken, team.Slug, "App")

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("via-tailnet"))
	}))
	t.Cleanup(upstream.Close)

	_, portStr, _ := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
	port, _ := strconv.Atoi(portStr)

	h.SeedRemoteDeployment(project.ID, "remote-bear-5678", "dev", "running",
		owner.ID, port, "k", "127.0.0.1")

	// UseNetworkDNS=true mimics the control plane running inside
	// compose. Remote deployments must STILL bypass docker DNS.
	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: true, CacheTTL: time.Second}
	addrs, err := resolver.ResolveAll(context.Background(), "remote-bear-5678")
	if err != nil {
		t.Fatalf("ResolveAll: %v", err)
	}
	if len(addrs) != 1 {
		t.Fatalf("expected 1 address, got %v", addrs)
	}
	want := "127.0.0.1:" + strconv.Itoa(port)
	if addrs[0] != want {
		t.Errorf("addr: got %q want %q (must be tailnet, not docker DNS)", addrs[0], want)
	}
}

// TestResolveAllSite_RemoteRefuses confirms the v1.19 carve-out:
// remote deployments don't expose port 3211, so the site resolver
// must surface ErrSiteUnsupported instead of routing to a closed
// port. (Documented in docs/REMOTE_HOSTS.md.)
func TestResolveAllSite_RemoteRefuses(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "SiteRem Co")
	project := createProject(t, h, owner.AccessToken, team.Slug, "App")
	h.SeedRemoteDeployment(project.ID, "remote-otter-9999", "dev", "running",
		owner.ID, 3998, "k", "100.64.0.5")

	// Even with network-DNS enabled, the remote-host carve-out wins.
	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: true, CacheTTL: time.Second}
	// First call: cloud path warms the cache + flips isRemote.
	if _, err := resolver.ResolveAll(context.Background(), "remote-otter-9999"); err != nil {
		t.Fatalf("ResolveAll: %v", err)
	}
	_, err := resolver.ResolveAllSite(context.Background(), "remote-otter-9999")
	if !errors.Is(err, proxy.ErrSiteUnsupported) {
		t.Errorf("ResolveAllSite remote: got %v want ErrSiteUnsupported", err)
	}
}

// TestProxy_RemoteDeployment_MissingTailnet_503 — a remote host that
// hasn't completed adoption (tailnet_addr NULL) cannot be routed to.
// The resolver refuses; the proxy handler 404s upstream (the path is
// "deployment exists but unreachable" — same shape as a deleted
// deployment).
func TestProxy_RemoteDeployment_MissingTailnet_503(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "OrphanedRemote Co")
	project := createProject(t, h, owner.AccessToken, team.Slug, "App")
	// Seed the host without a tailnet_addr by going through the
	// helper and then NULL'ing the column.
	depID, hostID := h.SeedRemoteDeployment(project.ID, "remote-orphan-7777",
		"dev", "running", owner.ID, 3998, "k", "100.64.0.6")
	if _, err := h.DB.Exec(h.rootCtx, `
		UPDATE hosts SET tailnet_addr = NULL WHERE id = $1
	`, hostID); err != nil {
		t.Fatalf("null tailnet: %v", err)
	}
	_ = depID

	resolver := &proxy.Resolver{DB: h.DB, UseNetworkDNS: false, CacheTTL: time.Second}
	_, err := resolver.ResolveAll(context.Background(), "remote-orphan-7777")
	if err == nil || !strings.Contains(err.Error(), "tailnet") {
		t.Fatalf("ResolveAll: got %v want error mentioning tailnet", err)
	}
}
