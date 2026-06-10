package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/mod/semver"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
)

// AdminHandler covers instance-level operations: version check + auto-upgrade.
// Endpoints under /v1/admin are gated to users.is_instance_admin. Team and
// project admins own application resources; instance admins own host-wide
// operations such as upgrading the Synapse binary and compose stack.
type AdminHandler struct {
	DB      *pgxpool.Pool
	Version string

	// UpdaterURL is the HTTP origin of the synapse-updater daemon. v1.5.1
	// migrated the daemon from a unix socket to a localhost-bound TCP
	// listener (see release notes); the api container reaches it via
	// host.docker.internal so the daemon survives the rebuild it
	// triggers without a bind-mounted socket. Empty → upgrade endpoints
	// return 503.
	UpdaterURL string

	// UpdaterToken is the bearer secret expected by the daemon on every
	// request. Generated once at install time, persisted in the
	// daemon's env-file + the api's compose env. Empty alongside a
	// non-empty UpdaterURL → 503 token_missing.
	UpdaterToken string

	// GitHubRepo is the repo owner/name pair (e.g. "Iann29/convex-synapse")
	// queried by /version_check. Pinned per-build so a forked deployment
	// with its own release stream can override.
	GitHubRepo string

	// GitHubAPIBase overrides https://api.github.com — primarily a test
	// seam (httptest.Server pretends to be the GitHub API). Production
	// keeps the default; empty falls through to the official endpoint.
	GitHubAPIBase string

	// PublicURL / BaseDomain / PublicIP mirror RouterDeps so GET
	// /v1/admin/host_domain can return the running config without
	// re-reading os.Getenv. POST validation also uses PublicIP for the
	// DNS preflight against the configured public IP.
	PublicURL  string
	BaseDomain string
	PublicIP   string

	// HostDomainResolver is overridable in tests so the host-domain
	// DNS preflight doesn't reach out to the real internet from the
	// integration suite. nil = use net.DefaultResolver.
	HostDomainResolver HostDomainResolver

	// DNSCredentials, when non-nil, mounts /dns_credentials sub-routes
	// under /v1/admin. Wired by router.go so the credential handler
	// inherits requireInstanceAdmin without duplicating the gate.
	DNSCredentials *DNSCredentialsHandler
	// EmailSettings, when non-nil, mounts /email_settings sub-routes under
	// /v1/admin (v1.22+). Same requireInstanceAdmin gate; nil = router
	// wired without email support (the dashboard probes via 404).
	EmailSettings *EmailSettingsHandler
	// ApplySettings, when non-nil, mounts /apply_settings under /v1/admin
	// (v1.23+): the dashboard toggle for CCP apply. Same instance-admin gate.
	ApplySettings *ApplySettingsHandler
	// AlertSettings, when non-nil, mounts /alert_settings under /v1/admin
	// (v1.26+, migration 000032): deployment-down notification channels.
	AlertSettings *AlertSettingsHandler
	// HeadscaleEnabled mirrors RouterDeps: true when Synapse boot wired
	// a non-nil headscale.Client AND a non-empty
	// SYNAPSE_HEADSCALE_SERVER_URL. The headscale admin GET handler
	// surfaces this as "Remote Hosts is live"; "configured but not
	// enabled" implies the operator just ran configure and synapse-api
	// hasn't restarted yet.
	HeadscaleEnabled bool
	// CryptoConfigured is true when *crypto.SecretBox is wired into
	// RouterDeps (SYNAPSE_STORAGE_KEY present). Surfaced as
	// remoteProvisioningReady so the dashboard can warn before the
	// agent-register path 503s on the SSH privkey encrypt step.
	CryptoConfigured bool
	// Headscale snapshot fields (v1.19+). The GET /v1/admin/headscale
	// handler reads these instead of os.Getenv so parallel tests can
	// inject independent state without env races. Production wiring in
	// router.go fills them from RouterDeps / os.Getenv at boot.
	//
	// HeadscaleDomain mirrors SYNAPSE_HEADSCALE_DOMAIN (operator's
	// explicit override); HeadscaleServerURL mirrors
	// SYNAPSE_HEADSCALE_SERVER_URL (the external https URL Tailscale
	// clients hit); HeadscaleInternalURL mirrors SYNAPSE_HEADSCALE_URL
	// (synapse-api → headscale API in-network). HeadscaleAPIKeyConfigured
	// is a presence-only signal — the key itself never leaves the
	// container. HostDomain mirrors SYNAPSE_DOMAIN so the default
	// Headscale subdomain derivation prefers the dashboard host over
	// the deployments wildcard.
	HeadscaleDomain           string
	HeadscaleServerURL        string
	HeadscaleInternalURL      string
	HeadscaleAPIKeyConfigured bool
	HostDomain                string

	// Cache for the latest-release fetch. GitHub's unauthenticated API limit
	// is 60 req/hour; with this 15min cache, a busy dashboard with N admin
	// pollers stays well under that.
	cacheMu       sync.Mutex
	cachedLatest  *latestRelease
	cachedAt      time.Time
	cachedFromAPI bool
	// Failure memory (v1.27.2): after a failed GitHub fetch, polls
	// within githubFailureBackoff get the remembered error instantly
	// instead of re-hanging for the full fetch timeout — without this,
	// every dashboard poll and every chip click on a host with broken
	// egress burned 6+ seconds and re-painted the raw error.
	lastFailAt  time.Time
	lastFailErr string
}

const (
	// updaterTimeout caps each call to the local socket. The daemon is
	// in-process tiny — anything taking >5s is a hung child or a bug.
	updaterTimeout = 5 * time.Second
	// versionCheckCacheTTL keeps GitHub fetches off the critical path
	// for dashboards that poll every minute.
	versionCheckCacheTTL = 15 * time.Minute
	// githubFetchTimeout caps EACH attempt (there are up to
	// githubFetchAttempts of them) — avoid hanging a request behind a
	// slow GitHub.
	githubFetchTimeout = 6 * time.Second
	// githubFetchAttempts: transient network errors get one retry.
	// HTTP-level answers (rate limit, 404) never retry — GitHub spoke,
	// repeating the question won't change the answer.
	githubFetchAttempts = 2
	// githubFailureBackoff: how long a failed fetch short-circuits
	// subsequent automatic checks. The manual refresh button bypasses
	// it (force=true) so an operator can re-test immediately after
	// fixing their network.
	githubFailureBackoff = 60 * time.Second
)

// githubHTTPClient is tuned for the failure mode real installs hit:
// VPS/docker hosts with a half-configured IPv6 stack. api.github.com
// publishes AAAA records; with the default transport a black-holed
// IPv6 route eats the whole deadline before IPv4 is ever tried, and
// every check ends in "context deadline exceeded". An aggressive
// Happy-Eyeballs fallback (150ms) plus explicit dial/TLS timeouts
// makes the IPv4 path win immediately on those machines.
var githubHTTPClient = &http.Client{
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:       5 * time.Second,
			FallbackDelay: 150 * time.Millisecond,
		}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 6 * time.Second,
	},
}

func (h *AdminHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Use(h.requireInstanceAdmin)
	r.Get("/version_check", h.versionCheck)
	r.Post("/version_check/refresh", h.versionCheckRefresh)
	r.Post("/upgrade", h.upgrade)
	r.Get("/upgrade/status", h.upgradeStatus)
	// Host-domain reconfigure (v1.4+). GET surfaces the current
	// config so the dashboard can pre-fill the form; POST hands the
	// requested change off to the synapse-updater daemon; status reads
	// the admin_jobs row the daemon updates. Same instance-admin gate
	// as the rest of /v1/admin.
	r.Get("/host_domain", h.getHostDomain)
	r.Post("/host_domain", h.postHostDomain)
	r.Get("/host_domain/status/{jobID}", h.getHostDomainStatus)
	// Headscale / Remote Hosts configuration (v1.19+, migration 000027).
	// Same admin_jobs handoff pattern as host-domain: GET → snapshot;
	// POST → enqueue + daemon dispatch; status → admin_jobs read-through.
	// Flat registration (no nested r.Route) so chi exposes the bare
	// /v1/admin/headscale path without requiring a trailing slash —
	// mirrors how /host_domain is registered above.
	r.Get("/headscale", h.getHeadscaleAdmin)
	r.Post("/headscale/configure", h.postHeadscaleAdmin)
	r.Get("/headscale/status/{jobID}", h.getHeadscaleStatus)
	// DNS-provider credentials (v1.5+, migration 000015). Mounted as
	// a child of /admin so everything below /admin shares the
	// requireInstanceAdmin gate. Nil means router wired without DNS
	// support; the dashboard probes feature availability via 404.
	if h.DNSCredentials != nil {
		r.Mount("/dns_credentials", h.DNSCredentials.Routes())
	}
	// Email settings (v1.22+, migration 000028). Same gate + nil-probe
	// pattern as dns_credentials above.
	if h.EmailSettings != nil {
		r.Mount("/email_settings", h.EmailSettings.Routes())
	}
	// Apply settings (v1.23+, migration 000030) — the CCP apply toggle.
	if h.ApplySettings != nil {
		r.Mount("/apply_settings", h.ApplySettings.Routes())
	}
	// Alert settings (v1.26+, migration 000032) — deployment-down alerts.
	if h.AlertSettings != nil {
		r.Mount("/alert_settings", h.AlertSettings.Routes())
	}
	return r
}

// requireInstanceAdmin gates every /v1/admin/* route. The first registered
// user is promoted during registration; later team admins do not inherit this
// host-wide role just by owning a team.
func (h *AdminHandler) requireInstanceAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid, err := auth.UserID(r.Context())
		if err != nil || uid == "" {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "Authentication required")
			return
		}
		var hasAdmin bool
		if err := h.DB.QueryRow(r.Context(), `
			SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND is_instance_admin)
		`, uid).Scan(&hasAdmin); err != nil {
			logErr("admin gate query", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to verify admin status")
			return
		}
		if !hasAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "Instance admin endpoints require instance-admin role")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- /v1/admin/version_check ---------------------------------

type latestRelease struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	HTMLURL     string `json:"html_url"`
	PublishedAt string `json:"published_at"`
	Body        string `json:"body"`
	Prerelease  bool   `json:"prerelease"`
	Draft       bool   `json:"draft"`
}

type versionCheckResp struct {
	Current         string `json:"current"`
	Latest          string `json:"latest,omitempty"`
	UpdateAvailable bool   `json:"updateAvailable"`
	ReleaseURL      string `json:"releaseUrl,omitempty"`
	ReleaseNotes    string `json:"releaseNotes,omitempty"`
	PublishedAt     string `json:"publishedAt,omitempty"`
	// FetchedAt mirrors Last-Modified semantics so the dashboard can
	// label a banner like "checked 3min ago". Populated even on cache
	// hits; on hard failure (GitHub unreachable + nothing cached), the
	// field is empty and the caller should treat updateAvailable as
	// "unknown".
	FetchedAt string `json:"fetchedAt,omitempty"`
	// CacheExpiresAt is when the next live GitHub fetch will happen.
	// The dashboard uses this to render a "next check in MM:SS"
	// countdown — operators who just published a release don't have to
	// stare at a stale banner wondering if it'll ever update. When
	// FromCache is true and CacheExpiresAt is in the past, the next
	// /version_check call refetches; the dashboard can also call
	// POST /v1/admin/version_check/refresh to force-bust the cache.
	CacheExpiresAt string `json:"cacheExpiresAt,omitempty"`
	// FromCache distinguishes "just fetched live" from "served from
	// the in-memory cache". Useful for the dashboard's countdown UX.
	FromCache bool `json:"fromCache"`
	// Error holds a short reason when GitHub couldn't be reached. The
	// dashboard renders the banner without the green "click to upgrade"
	// affordance when this is set.
	Error string `json:"error,omitempty"`
}

func (h *AdminHandler) versionCheck(w http.ResponseWriter, r *http.Request) {
	h.versionCheckWithForce(w, r, false)
}

func (h *AdminHandler) versionCheckWithForce(w http.ResponseWriter, r *http.Request, force bool) {
	resp := versionCheckResp{Current: trimVersion(h.Version)}

	latest, fetchedAt, fromCache, err := h.fetchLatestReleaseForce(r.Context(), force)
	if err != nil && latest == nil {
		// Never fetched and now offline — return current-only with the
		// error so the dashboard can still display "you're on v1.X.Y".
		resp.Error = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.FromCache = fromCache

	if latest != nil {
		resp.Latest = trimVersion(latest.TagName)
		resp.ReleaseURL = latest.HTMLURL
		resp.ReleaseNotes = latest.Body
		resp.PublishedAt = latest.PublishedAt
		resp.FetchedAt = fetchedAt.UTC().Format(time.RFC3339)
		resp.CacheExpiresAt = fetchedAt.Add(versionCheckCacheTTL).UTC().Format(time.RFC3339)
		// semver.Compare needs a leading "v"; trimVersion strips it.
		// Re-add for the comparison.
		resp.UpdateAvailable = semverNewer("v"+resp.Latest, "v"+resp.Current)
	}
	writeJSON(w, http.StatusOK, resp)
}

// versionCheckRefresh busts the in-memory cache and forces the next
// /version_check call to hit GitHub directly. Instance-admin only.
// Useful when an operator just tagged a release and doesn't want to
// wait up to 15 minutes for the dashboard banner to flip — same UX
// goal as the countdown timer in the dashboard.
//
// We rate-limit the bust to one per 30 seconds across all callers so
// a script with a tight loop can't blow through GitHub's 60 req/hr
// unauthenticated limit. The 30s floor is well above what an
// operator-driven UI button would ever produce.
func (h *AdminHandler) versionCheckRefresh(w http.ResponseWriter, r *http.Request) {
	h.cacheMu.Lock()
	// Don't allow more than one cache-bust per 30s. If the cache was
	// just refreshed, return the existing payload as if /version_check
	// were called.
	if h.cachedLatest != nil && time.Since(h.cachedAt) < 30*time.Second {
		h.cacheMu.Unlock()
		h.versionCheck(w, r)
		return
	}
	h.cachedLatest = nil
	h.cachedAt = time.Time{}
	h.cacheMu.Unlock()

	// force: the operator explicitly asked — bypass the failure
	// backoff so "I just fixed my network, test again" works
	// immediately instead of replaying the remembered error.
	h.versionCheckWithForce(w, r, true)
}

func (h *AdminHandler) fetchLatestRelease(ctx context.Context) (*latestRelease, time.Time, bool, error) {
	return h.fetchLatestReleaseForce(ctx, false)
}

func (h *AdminHandler) fetchLatestReleaseForce(ctx context.Context, force bool) (*latestRelease, time.Time, bool, error) {
	h.cacheMu.Lock()
	if h.cachedLatest != nil && time.Since(h.cachedAt) < versionCheckCacheTTL {
		latest := h.cachedLatest
		at := h.cachedAt
		h.cacheMu.Unlock()
		return latest, at, true, nil
	}
	// Failure backoff: a fetch just failed, so don't burn another
	// timeout-worth of seconds on every poll — answer with the
	// remembered error immediately. Manual refresh (force) bypasses.
	if !force && h.lastFailErr != "" && time.Since(h.lastFailAt) < githubFailureBackoff {
		latest := h.cachedLatest
		at := h.cachedAt
		msg := h.lastFailErr
		h.cacheMu.Unlock()
		return latest, at, latest != nil, errors.New(msg)
	}
	h.cacheMu.Unlock()

	repo := h.GitHubRepo
	if repo == "" {
		return nil, time.Time{}, false, errors.New("no GitHub repo configured")
	}
	base := h.GitHubAPIBase
	if base == "" {
		base = "https://api.github.com"
	}
	apiURL := strings.TrimRight(base, "/") + "/repos/" + repo + "/releases/latest"

	// Transient NETWORK errors get a retry; an HTTP answer of any kind
	// doesn't (GitHub spoke — asking again won't change a rate limit).
	var release *latestRelease
	var lastErr error
	for attempt := 0; attempt < githubFetchAttempts; attempt++ {
		var retryable bool
		release, retryable, lastErr = h.fetchReleaseOnce(ctx, apiURL)
		if lastErr == nil {
			break
		}
		if !retryable || ctx.Err() != nil {
			break
		}
	}
	if lastErr != nil {
		msg := classifyGitHubError(lastErr)
		now := time.Now()
		h.cacheMu.Lock()
		h.lastFailAt = now
		h.lastFailErr = msg
		h.cacheMu.Unlock()
		return h.lastKnownLatest(), time.Time{}, false, errors.New(msg)
	}

	now := time.Now()
	h.cacheMu.Lock()
	h.cachedLatest = release
	h.cachedAt = now
	h.cachedFromAPI = true
	h.lastFailErr = ""
	h.lastFailAt = time.Time{}
	h.cacheMu.Unlock()
	return release, now, false, nil
}

// fetchReleaseOnce performs a single GitHub API attempt with its own
// timeout. `retryable` is true only for transport-level failures
// (dial/TLS/timeout) — the cases where a second attempt through the
// already-warmed IPv4 path tends to succeed.
func (h *AdminHandler) fetchReleaseOnce(ctx context.Context, apiURL string) (*latestRelease, bool, error) {
	cctx, cancel := context.WithTimeout(ctx, githubFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := githubHTTPClient.Do(req)
	if err != nil {
		return nil, true, fmt.Errorf("github fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		return nil, false, fmt.Errorf("github rate-limited (HTTP %d)", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("github HTTP %d", resp.StatusCode)
	}
	var release latestRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, false, fmt.Errorf("decode release: %w", err)
	}
	if release.Draft || release.Prerelease {
		// /releases/latest already filters these out, but defense-in-depth:
		// a misclick on Make Latest could still show up here.
		return nil, false, errors.New("latest is prerelease/draft")
	}
	return &release, false, nil
}

// classifyGitHubError turns transport noise into one actionable line.
// The raw Go error ("Get \"https://api.github.com/...\": context
// deadline exceeded") leaked straight into the dashboard chip and told
// the operator nothing about WHAT to do.
func classifyGitHubError(err error) string {
	if err == nil {
		return ""
	}
	var netErr net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()):
		return fmt.Sprintf(
			"GitHub didn't answer within %ds (tried twice). This server's egress to api.github.com is slow or blocked — a broken IPv6 route is the usual culprit on VPSes. Retrying automatically; use the refresh button to re-test now.",
			int(githubFetchTimeout.Seconds()))
	case strings.Contains(err.Error(), "no such host"):
		return "DNS for api.github.com failed on this server — check the host's resolver (/etc/resolv.conf) and outbound DNS."
	case strings.Contains(err.Error(), "connection refused"):
		return "Connection to api.github.com was refused — an egress firewall or proxy on this server is likely blocking it."
	default:
		return err.Error()
	}
}

func (h *AdminHandler) lastKnownLatest() *latestRelease {
	h.cacheMu.Lock()
	defer h.cacheMu.Unlock()
	return h.cachedLatest
}

// trimVersion drops a leading "v" so equality + comparison surfaces don't
// trip on "v1.0.3" vs "1.0.3" mismatches. Callers re-add the v for semver
// compare since x/mod/semver requires it.
func trimVersion(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	return v
}

// semverNewer reports whether `latest` strictly exceeds `current`. Bad
// inputs (non-semver, missing v-prefix) compare as "not newer" — we'd
// rather miss showing a banner than incorrectly tell the operator their
// production-good version is stale.
func semverNewer(latest, current string) bool {
	if !semver.IsValid(latest) || !semver.IsValid(current) {
		return false
	}
	return semver.Compare(latest, current) > 0
}

// ---------- /v1/admin/upgrade ---------------------------------------

type upgradeReq struct {
	Ref string `json:"ref,omitempty"`
}

type upgradeResp struct {
	Started bool   `json:"started"`
	Ref     string `json:"ref"`
}

func (h *AdminHandler) upgrade(w http.ResponseWriter, r *http.Request) {
	if err := h.updaterReachable(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "updater_unreachable",
			"Self-update daemon unreachable: "+err.Error())
		return
	}

	var req upgradeReq
	if r.ContentLength > 0 {
		if err := readJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
	}

	body, err := json.Marshal(map[string]any{"ref": req.Ref})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Failed to encode upgrade request")
		return
	}

	status, payload, err := h.callUpdater(r.Context(), http.MethodPost, "/upgrade", body)
	if err != nil {
		writeError(w, http.StatusBadGateway, "updater_unreachable",
			"Could not reach the self-update daemon: "+err.Error())
		return
	}
	if status >= 400 {
		// Re-wrap the updater's `{"error": "..."}` into Synapse's standard
		// `{"code", "message"}` envelope so dashboard error parsing
		// stays uniform across endpoints. The bare-error string from
		// the updater becomes the code; we humanise common ones.
		var ue struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(payload, &ue)
		code := ue.Error
		if code == "" {
			code = "updater_error"
		}
		msg := updaterErrorMessage(code)
		writeError(w, status, code, msg)
		return
	}

	var parsed upgradeResp
	if err := json.Unmarshal(payload, &parsed); err != nil {
		// Updater returned 2xx but mangled JSON — log + best-effort response.
		logErr("decode updater /upgrade response", err)
	}

	uid, _ := auth.UserID(r.Context())
	// audit_events.target_id is UUID-typed; the upgrade target is the
	// instance itself, which has no UUID. Leave TargetID empty —
	// audit.Record skips the column when blank, the row still records
	// who pressed the button + when via target_type='synapse'.
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionUpgradeStarted,
		TargetType: audit.TargetSynapse,
		Metadata: map[string]any{
			"ref":            req.Ref,
			"currentVersion": trimVersion(h.Version),
		},
	})

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// updaterErrorMessage humanises the codes the daemon emits for the
// dashboard's error banner.
func updaterErrorMessage(code string) string {
	switch code {
	case "upgrade_in_progress":
		return "Another upgrade is already running"
	case "invalid_ref":
		return "ref contains characters that aren't allowed (use a tag like v1.2.0 or a branch name)"
	case "invalid_json":
		return "Updater rejected the request body"
	default:
		return "Updater error: " + code
	}
}

// upgradeStatus is a read-through to the updater's /status. We don't cache
// — operators expect log-tail freshness when watching an upgrade run.
func (h *AdminHandler) upgradeStatus(w http.ResponseWriter, r *http.Request) {
	if err := h.updaterReachable(r.Context()); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"state": "unavailable",
			"error": err.Error(),
		})
		return
	}
	status, payload, err := h.callUpdater(r.Context(), http.MethodGet, "/status", nil)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"state": "unavailable",
			"error": err.Error(),
		})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// callUpdater talks to the synapse-updater daemon over plain HTTP using
// the v1.5.1+ TCP+bearer protocol. UpdaterURL is the daemon's origin
// (e.g. http://host.docker.internal:9876); UpdaterToken is the shared
// secret the daemon checks against the Authorization: Bearer header.
func (h *AdminHandler) callUpdater(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	client := &http.Client{Timeout: updaterTimeout}
	u := strings.TrimRight(h.UpdaterURL, "/") + path
	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, reader)
	if err != nil {
		return 0, nil, err
	}
	if reader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+h.UpdaterToken)
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("updater unreachable at %s: %w", h.UpdaterURL, err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, payload, nil
}

// updaterReachable probes /healthz with a short timeout, returning a
// clear error when the daemon is unconfigured (no URL), missing a
// token, or simply not listening. Used by every mutating updater
// endpoint as a pre-flight so callers see 503 instead of an opaque
// 502/timeout.
func (h *AdminHandler) updaterReachable(ctx context.Context) error {
	if h.UpdaterURL == "" {
		return errors.New("not_configured")
	}
	if h.UpdaterToken == "" {
		return errors.New("token_missing")
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	status, _, err := h.callUpdater(cctx, http.MethodGet, "/healthz", nil)
	if err != nil {
		return err
	}
	if status >= 400 {
		return fmt.Errorf("healthz returned %d", status)
	}
	return nil
}
