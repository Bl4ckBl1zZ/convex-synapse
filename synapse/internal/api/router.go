// Package api wires HTTP routes for Synapse.
package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/convexenv"
	synapsedns "github.com/Iann29/synapse/internal/dns"
	"github.com/Iann29/synapse/internal/geo"
	"github.com/Iann29/synapse/internal/middleware"
)

type RouterDeps struct {
	Logger *slog.Logger
	DB     *pgxpool.Pool
	JWT    *auth.JWTIssuer
	// Docker is a Provisioner — accepting an interface here lets tests inject
	// a fake without bringing the docker SDK along for the ride. Production
	// wiring passes *dockerprov.Client which already satisfies it.
	Docker                Provisioner
	PortRangeMin          int
	PortRangeMax          int
	HealthcheckViaNetwork bool
	AllowedOrigins        string
	Version               string

	// PublicURL is the externally-reachable origin of the Synapse instance
	// (e.g. "https://synapse.example.com"). When set, /auth and
	// /cli_credentials return URLs the caller's machine can reach instead
	// of the container-internal "http://127.0.0.1:<port>". See
	// config.PublicURL for the full rules.
	PublicURL string
	// ProxyEnabled mirrors config.ProxyEnabled. With PublicURL set, the
	// rewrite becomes "<PublicURL>/d/<name>"; without proxy mode it's
	// "<PublicURL>:<port>" (operator still has to expose the port).
	ProxyEnabled bool

	// BaseDomain (v1.0+) — when set, deployment URLs become
	// "https://<name>.<BaseDomain>". Wins over PublicURL+ProxyEnabled.
	// Empty = custom domains disabled (path-based proxy still works).
	BaseDomain string

	// HA configuration (v0.5+). Zero value = HA disabled, behaves
	// exactly like pre-v0.5. When HA.Enabled is true, create_deployment
	// honours the `ha:true` flag in the request body and provisions
	// replicas backed by the configured Postgres + S3.
	HA HAConfig

	// Crypto encrypts deployment_storage secrets at rest. Required when
	// HA.Enabled is true; nil disables the HA path. The handler refuses
	// ha:true requests with ha_misconfigured when HA is on but Crypto
	// is unset.
	Crypto SecretEncrypter

	// UpdaterURL is the HTTP origin of the synapse-updater daemon
	// (v1.5.1+ TCP+bearer migration; see installer/updater/README.md).
	// Empty (or unreachable) → /v1/admin/upgrade degrades to
	// "Run setup.sh --upgrade via SSH" via 503. Default in compose:
	// http://host.docker.internal:9876.
	UpdaterURL string

	// UpdaterToken is the bearer secret shared with the daemon. Empty
	// alongside a non-empty URL is treated as misconfigured (503
	// token_missing).
	UpdaterToken string

	// GitHubRepo is "<owner>/<name>" used by /v1/admin/version_check.
	// Default "Iann29/convex-synapse"; overridable so a hard fork can
	// point its dashboard at its own release stream.
	GitHubRepo string

	// GitHubAPIBase is a test seam — defaults to https://api.github.com.
	// Setting it (httptest.Server URL) lets integration tests stub the
	// GitHub fetch without network.
	GitHubAPIBase string

	// PublicIP (v1.1+) is the IPv4 the operator publishes in DNS for
	// per-deployment custom domains. The /domains create + verify
	// handlers gate status='active' on a successful A-record match.
	// Empty disables DNS preflight; rows stay status='pending'.
	PublicIP string

	// DomainCache, when non-nil, is invoked by the domains handler
	// after add / delete / status-flip so the proxy's per-host
	// custom-domain cache drops stale entries instead of waiting for
	// the TTL to elapse. Production wiring passes the *proxy.Resolver
	// (which satisfies the interface). Tests that don't exercise the
	// proxy leave it nil.
	DomainCache DomainCacheInvalidator

	// HostDomainResolver lets the host-domain DNS preflight be stubbed
	// in tests. Production wiring leaves this nil and the handler
	// falls back to net.DefaultResolver. See AdminHandler.dnsLookupA.
	HostDomainResolver HostDomainResolver

	// DomainsResolver lets the per-deployment custom-domain DNS
	// preflight (DomainsHandler.verifyDomainDNS) be stubbed in tests.
	// Production wiring leaves this nil and the handler falls back to
	// synapsedns.ExternalResolver (1.1.1.1 → 8.8.8.8). Tests use it to
	// exercise the propagation / mismatch / active flips without
	// reaching the real internet.
	DomainsResolver LookupIPResolver

	// DNSEnvelope is the encrypt+decrypt envelope the DNS-credentials
	// flow uses to protect the stored Cloudflare token. Same backing
	// SecretBox as Crypto in the HA flow; the separate field exists
	// because the two flows have different "is this required" rules
	// (HA refuses to start without Crypto; DNS auto-configure
	// degrades to "503 unavailable" when nil).
	DNSEnvelope SecretEnvelope

	// CloudflareFactory is a test seam — production wiring leaves it
	// nil and both the credentials-CRUD and the auto-configure flow
	// build a real CloudflareClient. Tests inject a closure that
	// points at an httptest.Server pretending to be Cloudflare.
	CloudflareFactory func(token string) *synapsedns.CloudflareClient

	// DNSProviderLookup is a test seam — production leaves it nil and
	// /v1/internal/dns_provider delegates to the real DNS resolver.
	// Tests can inject canned NS responses.
	DNSProviderLookup func(ctx context.Context, domain string) (string, []string, error)

	// BackendProbe powers GET /v1/deployments/{name}/backend_version.
	// Production leaves it nil and the handler defaults to the HTTP
	// probe against `convex-<name>:3210/version`. Tests inject a
	// deterministic fake here so they don't depend on a live container.
	BackendProbe BackendProbe

	// GeoResolver feeds the /v1/projects/{id}/topology endpoint. nil
	// in production → use the cached ipinfo.io resolver. Tests inject
	// a deterministic stub so they don't burn outbound calls + so
	// CI stays offline-friendly.
	GeoResolver geo.Resolver

	// AgentStaleAfter / AgentOfflineAfter (Bloco 6.5) tune the computed host
	// effectiveStatus. Zero → HostsHandler defaults (60s / 300s), which is
	// what the test harness uses.
	AgentStaleAfter   time.Duration
	AgentOfflineAfter time.Duration

	// Bloco 9 — desired/observed state. Default true in the harness (zero
	// value false there, so the harness opts in explicitly if needed). Apply
	// is never enabled in this block.
	EnableDesiredState  bool
	EnableObservedState bool
	// ConvexEnv pushes operator-set project_env_vars into each
	// deployment's Convex FUNCTION runtime env store (the store that
	// backs process.env inside function isolates). Constructed once in
	// cmd/server/main.go and shared with provisioner.Worker. nil
	// disables env sync — minimal test harnesses + legacy wirings
	// degrade gracefully (the helpers log + skip instead of panicking).
	ConvexEnv *convexenv.Client
}

// DomainCacheInvalidator is the subset of *proxy.Resolver the
// domains handler depends on. Defined as an interface so the api
// package doesn't import internal/proxy (and can stay test-friendly
// with a no-op stub).
type DomainCacheInvalidator interface {
	InvalidateDomain(host string)
}

// HAConfig carries cluster-wide defaults for the per-deployment Postgres
// + S3 backing. Each value can be overridden on a per-deployment basis
// through the create-deployment payload (operator can register a
// different Postgres for a specific tenant).
type HAConfig struct {
	Enabled             bool
	BackendPostgresURL  string
	BackendS3Endpoint   string
	BackendS3Region     string
	BackendS3AccessKey  string
	BackendS3SecretKey  string
	BackendBucketPrefix string
}

// NewRouter builds the top-level chi router. Sub-handlers are mounted by
// resource. Versioned API routes live under /v1; ops endpoints (/health,
// /metrics later) live at the root.
func NewRouter(d RouterDeps) http.Handler {
	r := chi.NewRouter()

	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(middleware.RequestLogger(d.Logger))
	r.Use(middleware.CORS(d.AllowedOrigins))
	r.Use(chimw.Recoverer)
	// Short-circuit OpenAPI paths that Synapse self-hosted intentionally
	// doesn't implement (Convex Cloud's billing, SSO, Discord/Vercel,
	// OAuth apps, cloud backups). Returns 404 not_supported_in_self_hosted
	// before auth so probes reveal the cut without leaking auth state.
	// Catalog: internal/api/not_supported.go.
	r.Use(NotSupportedMiddleware)
	// 30s is plenty now that create_deployment is async — it returns 201 the
	// moment the row is inserted, and the docker pull/start/healthcheck runs
	// in a background goroutine. No request handler should hold a connection
	// longer than this; anything that does is a bug.
	r.Use(chimw.Timeout(30 * time.Second))

	r.Method(http.MethodGet, "/health", &HealthHandler{DB: d.DB, Version: d.Version})

	authH := &AuthHandler{DB: d.DB, JWT: d.JWT}
	meH := &MeHandler{DB: d.DB}
	invitesH := &InvitesHandler{DB: d.DB}
	tokensH := &AccessTokensHandler{DB: d.DB}
	deploymentsH := &DeploymentsHandler{
		DB:                    d.DB,
		Docker:                d.Docker,
		Tokens:                tokensH,
		PortRangeMin:          d.PortRangeMin,
		PortRangeMax:          d.PortRangeMax,
		HealthcheckViaNetwork: d.HealthcheckViaNetwork,
		PublicURL:             d.PublicURL,
		BaseDomain:            d.BaseDomain,
		ProxyEnabled:          d.ProxyEnabled,
		HA:                    d.HA,
		Crypto:                d.Crypto,
		BackendProbe:          d.BackendProbe,
		ConvexEnv:             d.ConvexEnv,
	}
	// Per-deployment custom domains (v1.1+). Sub-routes mount under
	// /v1/deployments/{name}/domains; the handler reuses the
	// deployments handler for loadDeploymentForRequest so
	// authorisation logic stays in one place.
	domainsH := &DomainsHandler{
		DB:                d.DB,
		Deployments:       deploymentsH,
		PublicIP:          d.PublicIP,
		Cache:             d.DomainCache,
		Logger:            d.Logger,
		Crypto:            d.DNSEnvelope,
		CloudflareFactory: d.CloudflareFactory,
		Resolver:          d.DomainsResolver,
	}
	deploymentsH.Domains = domainsH
	// teamsH + projectsH carry a *DeploymentsHandler reference so their
	// listDeployments handlers can call publicDeploymentURL — same
	// rewrite as /auth and /cli_credentials so dashboards and CLIs see
	// public URLs instead of the loopback "http://127.0.0.1:<port>".
	// Tokens enables scope-aware access-token CRUD under /access_tokens.
	// dnsCredsH is shared between the instance-admin path (mounted
	// under /v1/admin/dns_credentials below) and the per-project
	// path (mounted on ProjectsHandler). Constructing it once keeps
	// the CloudflareFactory test seam consistent across both surfaces.
	dnsCredsH := &DNSCredentialsHandler{
		DB:                d.DB,
		Crypto:            d.DNSEnvelope,
		CloudflareFactory: d.CloudflareFactory,
	}
	teamsH := &TeamsHandler{DB: d.DB, Deployments: deploymentsH, Tokens: tokensH}
	projectsH := &ProjectsHandler{DB: d.DB, Deployments: deploymentsH, Tokens: tokensH, DNSCredentials: dnsCredsH}
	// v1.9.6: topology endpoint shares the projects handler's auth path
	// (loadProjectForRequest). The geo cache is constructed once at boot
	// so a single Synapse instance burns at most one ipinfo call per IP
	// per process lifetime. Tests inject d.GeoResolver to keep CI
	// offline-friendly.
	geoResolver := d.GeoResolver
	if geoResolver == nil {
		geoResolver = geo.NewCache(geo.DefaultResolver)
	}
	topologyH := &TopologyHandler{
		DB:             d.DB,
		PublicIP:       d.PublicIP,
		PublicURL:      d.PublicURL,
		SynapseVersion: d.Version,
		Geo:            geoResolver,
		Projects:       projectsH,
	}
	projectsH.Topology = topologyH
	// v1.10.0: activity feed handler shares the project auth path.
	activityH := &ActivityHandler{DB: d.DB, Projects: projectsH}
	projectsH.Activity = activityH

	// Cell Control Plane (feat/cell-control-plane). Cells are project-scoped
	// and reuse loadProjectForRequest via the same Projects-reference pattern
	// TopologyHandler uses. Hosts are instance-level (their own
	// instance-admin gate). Both route surfaces are always mounted — they're
	// additive + auth-gated; the SYNAPSE_ENABLE_CELLS flag only governs the
	// startup backfill in cmd/server, not API availability.
	cellsH := &CellsHandler{DB: d.DB, Projects: projectsH}
	projectsH.Cells = cellsH
	// Cell links + service tokens (Bloco 7). Project-scoped create/list reuse
	// loadProjectForRequest via Projects; discovery is mounted publicly below.
	cellLinksH := &CellLinksHandler{DB: d.DB, Projects: projectsH}
	projectsH.CellLinks = cellLinksH
	// Bloco 8: real Cell Control Plane topology. Shares the host-liveness
	// thresholds with HostsHandler.
	cellTopologyH := &CellTopologyHandler{
		DB:           d.DB,
		Projects:     projectsH,
		StaleAfter:   d.AgentStaleAfter,
		OfflineAfter: d.AgentOfflineAfter,
	}
	projectsH.CellTopology = cellTopologyH
	// Bloco 9 — desired state + operation runs.
	desiredStateH := &DesiredStateHandler{DB: d.DB, Projects: projectsH}
	projectsH.DesiredState = desiredStateH
	operationsH := &OperationsHandler{DB: d.DB, Projects: projectsH}
	projectsH.Operations = operationsH
	hostsH := &HostsHandler{
		DB:           d.DB,
		PublicURL:    d.PublicURL,
		StaleAfter:   d.AgentStaleAfter,
		OfflineAfter: d.AgentOfflineAfter,
	}
	// Bloco 9b — Drift Engine + dry-run planner. Shares the host-liveness
	// thresholds (they decide whether observed state can be trusted) and reuses
	// the project / cell / host load+RBAC helpers via the references below.
	// Routes are mounted on each scope's handler (instance-admin for host,
	// project-RBAC for cell/project). Compares + plans only; never applies.
	driftH := &DriftHandler{
		DB:           d.DB,
		Projects:     projectsH,
		Cells:        cellsH,
		Hosts:        hostsH,
		StaleAfter:   d.AgentStaleAfter,
		OfflineAfter: d.AgentOfflineAfter,
	}
	projectsH.Drift = driftH
	cellsH.Drift = driftH
	hostsH.Drift = driftH
	// Agent contact points (feat/cell-control-plane, Bloco 6). Public —
	// register authenticates with the adoption token in the body, heartbeat
	// + desired_state with the agent bearer token. Mounted in the public
	// group below (NOT under the JWT Authenticator).
	agentsH := &AgentsHandler{
		DB:                  d.DB,
		PublicURL:           d.PublicURL,
		EnableObservedState: d.EnableObservedState,
		EnableDesiredState:  d.EnableDesiredState,
	}

	r.Route("/v1", func(r chi.Router) {
		r.Get("/", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]string{"name": "synapse", "api": "v1"})
		})

		// Public.
		r.Mount("/auth", authH.Routes())
		// install_status is also public — the dashboard hits it pre-auth
		// to decide whether to redirect /login → /setup (first-run wizard).
		r.Method(http.MethodGet, "/install_status", &InstallStatusHandler{DB: d.DB, Version: d.Version})
		// CLI latest version probe (v1.9.4+). Public for the same reason
		// install_status is public: every operator who can log into the
		// dashboard is a potential CLI user; gating it behind admin would
		// just buy a confusing UX with no security upside. Cached
		// server-side so npm sees one fetch per 15min across all
		// connected clients. cliVersionH is shared with the /refresh
		// route below so cache state stays single-source.
		cliVersionH := &CLIVersionHandler{}
		r.Method(http.MethodGet, "/cli_latest_version", cliVersionH)
		r.Method(http.MethodPost, "/cli_latest_version/refresh", http.HandlerFunc(cliVersionH.RefreshHandler))
		// TLS-ask for Caddy on-demand TLS (v1.0+). Public, no auth —
		// Caddy hits it from inside the docker network without a JWT.
		// The handler rejects any host outside `<sub>.<BaseDomain>`,
		// so an unconfigured cluster (BaseDomain empty) always 404s.
		//
		// Wrapped in r.Route("/internal", ...) because chi's r.Method
		// on a multi-segment pattern silently fails to register —
		// real-VPS smoke caught a 404 on every request despite the
		// handler compiling and the path looking right.
		r.Route("/internal", func(r chi.Router) {
			r.Method(http.MethodGet, "/tls_ask", &TLSAskHandler{DB: d.DB, BaseDomain: d.BaseDomain})
			// list_deployments_for_dashboard — cross-origin endpoint
			// the upstream Convex Dashboard hits from inside the
			// /embed/<name> iframe. Public route, but the request
			// must carry a `?token=` query param holding a
			// project-scoped PAT (minted by the Synapse Dashboard
			// before the iframe loads, TTL ~15min). See
			// dashboard_proxy.go for the auth + cors discussion.
			dashProxy := &DashboardProxyHandler{DB: d.DB, Deployments: deploymentsH}
			r.Get("/list_deployments_for_dashboard", dashProxy.listDeploymentsForDashboard)
			// dns_provider — looks up which DNS provider hosts a
			// given domain so the dashboard can render the right
			// auto-configure UI before the operator pastes a token.
			// Public + unauthenticated; result is informational only.
			r.Method(http.MethodGet, "/dns_provider", &DNSProviderHandler{Lookup: d.DNSProviderLookup})
		})

		// synapse-agent contact points (feat/cell-control-plane, Bloco 6).
		// Public group: register uses a single-use adoption token in the
		// body; heartbeat + desired_state use the agent bearer token
		// (looked up in host_agents, never access_tokens).
		r.Mount("/agents", agentsH.Routes())

		// Cell-link discovery (Bloco 7). Public — authenticated by a syn_svc_
		// service-token bearer (looked up in service_tokens, never
		// access_tokens). Returns the active links from the token's source cell.
		r.Get("/internal/cell_links/discovery", cellLinksH.Discovery)

		// Authenticated.
		r.Group(func(r chi.Router) {
			r.Use(middleware.Authenticator(d.JWT, d.DB))

			r.Mount("/me", meH.Routes())
			r.Mount("/profile", meH.Routes()) // alias for cloud-dashboard parity
			r.Mount("/teams", teamsH.Routes())
			r.Mount("/projects", projectsH.Routes())
			r.Mount("/deployments", deploymentsH.Routes())
			r.Mount("/team_invites", invitesH.Routes())
			// Cell Control Plane (feat/cell-control-plane). /hosts is
			// instance-admin gated inside its own Routes(); /cells is
			// project-RBAC gated per cell.
			r.Mount("/hosts", hostsH.Routes())
			// /v1/host_agents — instance-admin agent lifecycle (revoke /
			// rotate_token). Same gate as /hosts; separate prefix.
			r.Mount("/host_agents", hostsH.AgentAdminRoutes())
			r.Mount("/cells", cellsH.Routes())
			// Cell links + service tokens (Bloco 7). Project-RBAC gated per
			// link (loadCellLinkForRequest); discovery is the public route above.
			r.Mount("/cell_links", cellLinksH.Routes())
			r.Mount("/service_tokens", cellLinksH.ServiceTokenRoutes())
			// Bloco 9 — operation run detail (read). Project-scoped list is
			// mounted under /v1/projects/{id}/operation_runs.
			r.Mount("/operation_runs", operationsH.Routes())
			// /v1/admin — instance-level operations (version check + auto-
			// upgrade). The handler's own middleware gates each route to
			// users.is_instance_admin; we mount inside the authenticated group
			// so unauthenticated probes still hit the auth 401 path.
			adminH := &AdminHandler{
				DB:                 d.DB,
				Version:            d.Version,
				UpdaterURL:         d.UpdaterURL,
				UpdaterToken:       d.UpdaterToken,
				GitHubRepo:         d.GitHubRepo,
				GitHubAPIBase:      d.GitHubAPIBase,
				PublicURL:          d.PublicURL,
				BaseDomain:         d.BaseDomain,
				PublicIP:           d.PublicIP,
				HostDomainResolver: d.HostDomainResolver,
			}
			// DNS-provider credentials — mounted under /admin and
			// gated by AdminHandler.requireInstanceAdmin. Same
			// handler instance is also mounted on ProjectsHandler
			// for project-scoped credentials (v1.6.4+).
			adminH.DNSCredentials = dnsCredsH
			r.Mount("/admin", adminH.Routes())
			// Personal access tokens — flat verb-suffixed endpoints under /v1.
			// Registered directly (not via Mount) because chi's Mount("/", ...)
			// collides with the existing GET /v1/ index handler above.
			tokensH.Register(r)
			// Profile-level cloud-spec endpoints — mounted flat the same way
			// as access tokens (Mount("/", ...) collides with the index
			// handler). See MeHandler.RegisterTopLevel for the per-route
			// rationale.
			meH.RegisterTopLevel(r)
		})
	})

	return r
}
