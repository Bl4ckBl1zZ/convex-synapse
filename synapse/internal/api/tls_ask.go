package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TLSAskHandler implements the contract Caddy's `tls { on_demand }`
// expects: a 200 means "yes, issue a Let's Encrypt cert for this host";
// a non-200 means "refuse". Without this gate any rando could trigger
// cert issuance for arbitrary subdomains by sending TLS handshakes —
// Caddy would happily ask Let's Encrypt for `evil.<base>` if we let it.
//
// We answer 200 iff one of:
//
//	A. The host is `<sub>.<BaseDomain>` (case-insensitive) AND `<sub>`
//	   is the name of a real, non-deleted deployment (wildcard
//	   subdomain mode — needs BaseDomain configured).
//	B. The host exactly matches an active row in `deployment_domains`
//	   bound to a real, non-deleted deployment (per-deployment custom
//	   domain, v1.1+).
//
// Endpoint: GET /v1/internal/tls_ask?domain=<host>
// Public — Caddy hits it from inside the docker network with no JWT.
// We intentionally don't gate on a shared-secret because that would
// require operator setup we don't want to push (and the underlying
// risk is "an attacker on the synapse-network triggers a cert" which
// is bounded by Let's Encrypt rate limits anyway).
type TLSAskHandler struct {
	DB         *pgxpool.Pool
	BaseDomain string

	// HeadscaleEnabled (v1.18.3+) lets the wildcard subdomain branch
	// approve cert issuance for the literal "headscale" subdomain
	// under BaseDomain. Without this whitelist, `headscale.<BaseDomain>`
	// falls into the same approveIfDeploymentExists check that everything
	// else does — and "headscale" is not a deployment, so cert issuance
	// is silently refused and Tailscale clients never see a valid TLS
	// endpoint. True when SYNAPSE_HEADSCALE_SERVER_URL or
	// SYNAPSE_HEADSCALE_DOMAIN is set on the running synapse-api.
	HeadscaleEnabled bool
	// HeadscaleHost (v1.19.7+) is the FQDN of the Headscale control
	// server (e.g. "headscale.synapsepanel.com"). When the asked host
	// matches it, we approve cert issuance regardless of BaseDomain —
	// a domain-only install (SYNAPSE_DOMAIN, no wildcard base) derives
	// the headscale host from SYNAPSE_DOMAIN, so it never falls under
	// the base-subdomain branch below. Without this top-level match the
	// headscale host lands in the on-demand catch-all, tls_ask refuses
	// it, no cert issues, and `tailscale up` hangs on the TLS
	// handshake. Empty when Remote Hosts is disabled.
	HeadscaleHost string
}

func (h *TLSAskHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := strings.TrimSpace(r.URL.Query().Get("domain"))
	if host == "" {
		http.Error(w, "domain query param required", http.StatusBadRequest)
		return
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))

	// (0) Headscale control server (v1.19.7+). Approve regardless of
	// BaseDomain — the headscale host derives from SYNAPSE_DOMAIN on a
	// domain-only install, so it never falls under the base-subdomain
	// branch. This is what lets Caddy's on-demand TLS issue the
	// headscale cert; without it `tailscale up` hangs on a failed
	// handshake. The host is a single, operator-configured FQDN —
	// not attacker-controlled — so a flat equality check is the whole
	// gate.
	if h.HeadscaleEnabled && h.HeadscaleHost != "" &&
		host == strings.ToLower(strings.TrimSuffix(strings.TrimSpace(h.HeadscaleHost), ".")) {
		w.WriteHeader(http.StatusOK)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	// (A) Wildcard subdomain path — only when BaseDomain is set.
	// When the host falls under the base, we do the wildcard check
	// AND short-circuit on its result so an attacker can't make us
	// issue `evil.<base>` certs by registering the same string as a
	// custom domain (the unique constraint on deployment_domains
	// would already block it, but defense-in-depth).
	if h.BaseDomain != "" {
		base := strings.ToLower(strings.Trim(h.BaseDomain, ". "))
		suffix := "." + base
		if strings.HasSuffix(host, suffix) && host != base {
			name := host[:len(host)-len(suffix)]
			// Site form "<dep>.site.<base>" (the HTTP-actions host): strip
			// the ".site" level and validate the deployment exactly like
			// the cloud form. This MUST run BEFORE the multi-label reject
			// below — "<dep>.site" itself contains a dot and would
			// otherwise be refused. See docs/CONVEX_SITE_ORIGIN.md.
			if siteName, ok := strings.CutSuffix(name, ".site"); ok {
				if siteName == "" || strings.Contains(siteName, ".") {
					http.Error(w, "multi-label subdomain", http.StatusForbidden)
					return
				}
				h.approveIfDeploymentExists(ctx, w, siteName)
				return
			}
			// Refuse multi-label subdomains — Synapse only addresses a
			// single label per deployment under the wildcard.
			if strings.Contains(name, ".") {
				http.Error(w, "multi-label subdomain", http.StatusForbidden)
				return
			}
			if name == "" {
				http.Error(w, "empty subdomain", http.StatusBadRequest)
				return
			}
			// v1.18.3+: whitelist the Headscale subdomain. Headscale is a
			// first-class control-plane service when the operator opted in
			// via `setup.sh --enable-headscale`; its cert needs to issue
			// even though there's no deployment named "headscale".
			if h.HeadscaleEnabled && name == "headscale" {
				w.WriteHeader(http.StatusOK)
				return
			}
			h.approveIfDeploymentExists(ctx, w, name)
			return
		}
		// Falls through to (B) when host isn't under the base.
	}

	// (B) Custom-domain path — accept any host with an active row in
	// deployment_domains pointing at a non-deleted deployment. Adopted
	// deployments are excluded: the proxy has nothing to route to for
	// them, so issuing a cert would only enable a permanent 502 (also
	// covers legacy rows created before createDomain refused adopted).
	var domainExists bool
	err := h.DB.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			  FROM deployment_domains dd
			  JOIN deployments d ON d.id = dd.deployment_id
			 WHERE dd.domain = $1
			   AND dd.status = 'active'
			   AND d.status <> 'deleted'
			   AND d.adopted = false
		)`, host).Scan(&domainExists)
	if err != nil {
		http.Error(w, "db error", http.StatusServiceUnavailable)
		return
	}
	if domainExists {
		w.WriteHeader(http.StatusOK)
		return
	}

	// Neither path matched. 404 covers "host not under base AND not a
	// custom domain"; the wildcard branch above already covered
	// "under base but the deployment doesn't exist".
	http.Error(w, "domain not registered", http.StatusNotFound)
}

// approveIfDeploymentExists writes 200 when a non-deleted, non-adopted
// deployment named `name` exists, 404 when it doesn't, and 503 on a db
// blip. Shared by the cloud ("<name>.<base>") and site
// ("<name>.site.<base>") wildcard branches so the existence check stays
// in one place. Adopted deployments don't get wildcard certs: their URL
// is external and the proxy can't route them, so a cert would only
// front a permanent 502.
func (h *TLSAskHandler) approveIfDeploymentExists(ctx context.Context, w http.ResponseWriter, name string) {
	var exists bool
	err := h.DB.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM deployments
			WHERE name = $1 AND status <> 'deleted' AND adopted = false
		)`, name).Scan(&exists)
	if err != nil {
		http.Error(w, "db error", http.StatusServiceUnavailable)
		return
	}
	if !exists {
		http.Error(w, "deployment not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusOK)
}
