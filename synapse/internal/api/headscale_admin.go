package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
)

// Headscale admin (v1.19+). Drives the "Admin → Remote Hosts" tab in the
// dashboard so a fresh operator can enable Headscale + Tailnet membership
// for the Remote Hosts feature without SSH'ing to the control plane.
//
// API shape (all gated by AdminHandler.requireInstanceAdmin):
//
//	GET  /v1/admin/headscale                 → current state snapshot
//	POST /v1/admin/headscale/configure       → enqueue configure_headscale job
//	GET  /v1/admin/headscale/status/{jobID}  → admin_jobs row for the job
//
// The configure path mirrors the host-domain flow: validate request,
// optionally upsert a Cloudflare A record for the chosen Headscale
// subdomain, insert an admin_jobs row, hand off to the synapse-updater
// daemon's POST /configure_headscale. The daemon shells setup.sh
// --configure-headscale --non-interactive on the host.

// headscaleAdminResp is the GET shape. Pointers (well — explicit
// nullable strings via omitempty on plain strings) keep "field not
// configured" distinguishable from "field is empty". Fields are
// intentionally additive-friendly: older dashboards ignore unknown
// keys; new clients gate UI on the boolean flags.
type headscaleAdminResp struct {
	// Enabled flips true only when the runtime Headscale client AND
	// the externally-reachable server URL are BOTH wired into this
	// api process. Equivalent to remote_setup.go's gate.
	Enabled bool `json:"enabled"`
	// Configured is true when .env / runtime has the trio of
	// SYNAPSE_HEADSCALE_URL, SYNAPSE_HEADSCALE_SERVER_URL, and
	// SYNAPSE_HEADSCALE_API_KEY at least intent-stamped. A
	// freshly-configured install where the operator hasn't restarted
	// synapse-api yet will be `configured=true && enabled=false` and
	// the dashboard surfaces a "restart synapse-api" hint.
	Configured bool `json:"configured"`
	// RemoteProvisioningReady mirrors install_agent/config's
	// remoteProvisioningEnabled: Enabled AND SYNAPSE_STORAGE_KEY
	// configured (Crypto wired). Without it the agent-register path
	// 503s on the ssh privkey encrypt step.
	RemoteProvisioningReady bool `json:"remoteProvisioningReady"`
	// NeedsAPIRestart is true when configure intent is on disk (.env)
	// but the running api process hasn't picked it up yet. Empty
	// today's session, restart inside an hour expected.
	NeedsAPIRestart bool `json:"needsApiRestart"`
	// UpdaterAvailable is best-effort: when the daemon is unreachable,
	// the panel can render a degraded state instead of letting the
	// operator click "Configure" only to get 503'd.
	UpdaterAvailable bool   `json:"updaterAvailable"`
	UpdaterReason    string `json:"updaterReason,omitempty"`

	// Domain / ServerURL / InternalURL are the operator-facing knobs
	// the panel renders. ServerURL is "https://<headscale-domain>",
	// InternalURL is the in-network http://synapse-headscale:8080
	// that synapse-api uses. DefaultDomain is what the dashboard
	// pre-fills in the "Headscale subdomain" input.
	Domain        string `json:"domain,omitempty"`
	ServerURL     string `json:"serverUrl,omitempty"`
	InternalURL   string `json:"internalUrl,omitempty"`
	BaseDomain    string `json:"baseDomain,omitempty"`
	HostDomain    string `json:"hostDomain,omitempty"`
	PublicURL     string `json:"publicUrl,omitempty"`
	PublicIP      string `json:"publicIp,omitempty"`
	DefaultDomain string `json:"defaultDomain,omitempty"`

	// DNSCredentialAvailable is true when a stored Cloudflare
	// credential covers the proposed Headscale subdomain. The
	// dashboard uses this to show / hide the "Auto-configure DNS"
	// checkbox without making the operator save a credential first.
	DNSCredentialAvailable bool `json:"dnsCredentialAvailable"`
}

// getHeadscaleAdmin returns the current state snapshot. No mutations.
// Tier-1 honesty: anything we don't know is left nil/empty so the
// dashboard doesn't render "configured" against an empty backend.
func (h *AdminHandler) getHeadscaleAdmin(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(h.HeadscaleDomain)
	serverURL := strings.TrimSpace(h.HeadscaleServerURL)
	internalURL := strings.TrimSpace(h.HeadscaleInternalURL)
	apiKeyConfigured := h.HeadscaleAPIKeyConfigured

	configured := internalURL != "" && serverURL != "" && apiKeyConfigured
	enabled := h.HeadscaleEnabled
	needsRestart := configured && !enabled

	hostDomain := strings.TrimSpace(h.HostDomain)
	baseDomain := strings.TrimSpace(h.BaseDomain)
	defaultDomain := headscaleDefaultDomain(domain, hostDomain, baseDomain)

	updaterErr := h.updaterReachable(r.Context())
	updaterReason := ""
	if updaterErr != nil {
		updaterReason = updaterErr.Error()
	}

	resp := headscaleAdminResp{
		Enabled:                 enabled,
		Configured:              configured,
		RemoteProvisioningReady: enabled && h.CryptoConfigured,
		NeedsAPIRestart:         needsRestart,
		UpdaterAvailable:        updaterErr == nil,
		UpdaterReason:           updaterReason,
		Domain:                  domain,
		ServerURL:               serverURL,
		InternalURL:             internalURL,
		BaseDomain:              baseDomain,
		HostDomain:              hostDomain,
		PublicURL:               h.PublicURL,
		PublicIP:                h.PublicIP,
		DefaultDomain:           defaultDomain,
	}

	// Best-effort DNS-credential probe so the dashboard knows whether
	// to surface the "Auto-configure DNS" checkbox. We use the
	// computed defaultDomain rather than `domain` so a fresh install
	// (no SYNAPSE_HEADSCALE_DOMAIN yet) still gets the right answer.
	if defaultDomain != "" && h.DNSCredentials != nil && h.DNSCredentials.Crypto != nil {
		if _, _, _, err := h.findCloudflareCredentialForDomain(r.Context(), defaultDomain); err == nil {
			resp.DNSCredentialAvailable = true
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// headscaleDefaultDomain returns the hostname the dashboard should
// pre-fill in the "Headscale subdomain" input. Resolution order:
//  1. explicit SYNAPSE_HEADSCALE_DOMAIN (operator already chose).
//  2. headscale.<SYNAPSE_DOMAIN> — the dashboard host's first-level
//     parent; right answer when the operator put the dashboard at
//     synapsepanel.com and the wildcard at app.synapsepanel.com.
//  3. headscale.<SYNAPSE_BASE_DOMAIN> — last-ditch fallback so a
//     base-domain-only install still gets a sensible suggestion.
//
// All three drop a leading dot the operator might have typed.
func headscaleDefaultDomain(persisted, hostDomain, baseDomain string) string {
	persisted = strings.TrimPrefix(strings.TrimSpace(persisted), ".")
	if persisted != "" {
		return persisted
	}
	hostDomain = strings.TrimPrefix(strings.TrimSpace(hostDomain), ".")
	if hostDomain != "" {
		return "headscale." + hostDomain
	}
	baseDomain = strings.TrimPrefix(strings.TrimSpace(baseDomain), ".")
	if baseDomain != "" {
		return "headscale." + baseDomain
	}
	return ""
}

// ---------- POST /v1/admin/headscale/configure ----------

type headscaleConfigureReq struct {
	// HeadscaleDomain overrides the auto-derived default. When empty
	// the daemon falls back to headscale::_resolve_server_url() in
	// installer/install/headscale.sh, which honours the same
	// "headscale.<SYNAPSE_DOMAIN> > headscale.<SYNAPSE_BASE_DOMAIN>"
	// order as the GET handler.
	HeadscaleDomain *string `json:"headscaleDomain"`
	// AutoConfigureDNS, when true, makes the handler upsert the
	// matching A record via a stored Cloudflare credential BEFORE
	// dispatching the daemon configure. Default off so operators
	// with manually-managed DNS see no behaviour change.
	AutoConfigureDNS bool `json:"autoConfigureDns"`
}

func (r headscaleConfigureReq) domain() string {
	if r.HeadscaleDomain == nil {
		return ""
	}
	return strings.TrimSpace(*r.HeadscaleDomain)
}

type headscaleConfigureResp struct {
	JobID         string `json:"jobId"`
	StatusURL     string `json:"statusUrl"`
	State         string `json:"state"`
	Domain        string `json:"domain,omitempty"`
	ServerURL     string `json:"serverUrl,omitempty"`
	DNSAuto       *dnsAutoResult `json:"dnsAuto,omitempty"`
}

// postHeadscaleAdmin validates the configure request, optionally
// upserts the Cloudflare A record, persists an admin_jobs row, and
// dispatches the work to the synapse-updater daemon. Returns 202 with
// the job id so the dashboard can poll for completion.
//
// Order of operations (mirrors postHostDomain so operators see the
// same UX cadence for both flows):
//
//  1. Refuse 503 when the synapse-updater daemon is unreachable —
//     queuing a row that no daemon will pick up is a worse failure
//     mode than failing the request up front.
//  2. Refuse 400 when no host context is configured (PublicURL +
//     either BaseDomain or SYNAPSE_DOMAIN). Headscale needs a stable
//     externally-reachable HTTPS URL the Tailscale clients can
//     register against — point the operator at Admin → Host domain
//     first.
//  3. Parse + validate the requested Headscale domain (or fall back
//     to the auto-derived default when the body omits it).
//  4. Best-effort DNS auto-config when the operator ticked the box.
//  5. INSERT admin_jobs row.
//  6. POST /configure_headscale to the daemon; on failure, flip the
//     row to 'failed' and surface 502/503 to the caller.
//  7. Audit + return 202.
func (h *AdminHandler) postHeadscaleAdmin(w http.ResponseWriter, r *http.Request) {
	if err := h.updaterReachable(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "updater_unreachable",
			"Self-update daemon unreachable: "+err.Error())
		return
	}

	hostDomain := strings.TrimSpace(h.HostDomain)
	baseDomain := strings.TrimSpace(h.BaseDomain)
	persistedDomain := strings.TrimSpace(h.HeadscaleDomain)

	// Headscale needs a stable HTTPS URL on a real domain. Without a
	// dashboard host AND without a base-domain wildcard there's
	// nothing we can derive a default from — point the operator at
	// the Host domain panel and refuse here.
	if hostDomain == "" && baseDomain == "" && persistedDomain == "" {
		writeError(w, http.StatusBadRequest, "host_domain_required",
			"Headscale needs a TLS host. Configure Admin → Host domain first.")
		return
	}

	var req headscaleConfigureReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	requestedDomain := req.domain()
	if requestedDomain == "" {
		requestedDomain = headscaleDefaultDomain(persistedDomain, hostDomain, baseDomain)
	}
	if requestedDomain == "" {
		writeError(w, http.StatusBadRequest, "headscale_domain_required",
			"headscaleDomain is required when no SYNAPSE_DOMAIN or SYNAPSE_BASE_DOMAIN is configured")
		return
	}

	canonical, code, msg := validateDomain(requestedDomain)
	if code != "" {
		writeError(w, http.StatusBadRequest, code, msg)
		return
	}
	requestedDomain = canonical

	// Optional Cloudflare A-record upsert. Best-effort per the same
	// warn-and-proceed semantic the host-domain panel uses; daemon's
	// configure pass still runs whether the auto-config succeeded.
	var dnsAuto *dnsAutoResult
	if req.AutoConfigureDNS {
		dnsAuto = h.attemptHostDomainDNSAuto(r.Context(), requestedDomain)
		// Give DNS a few seconds to propagate before the daemon's
		// downstream Caddy issuance racing the recursive resolver.
		if dnsAuto != nil && dnsAuto.Success {
			h.waitForARecord(r.Context(), requestedDomain, dnsAuto.IP)
		}
	}

	uid, _ := auth.UserID(r.Context())

	payload := map[string]any{
		"headscaleDomain": requestedDomain,
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Failed to encode payload")
		return
	}

	var jobID string
	if err := h.DB.QueryRow(r.Context(), `
		INSERT INTO admin_jobs (kind, payload, state, created_by)
		VALUES ('configure_headscale', $1, 'queued', $2)
		RETURNING id
	`, payloadJSON, nullableUUID(uid)).Scan(&jobID); err != nil {
		logErr("insert admin_jobs (headscale)", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to enqueue configure job")
		return
	}

	daemonBody, err := json.Marshal(map[string]any{
		"jobId":           jobID,
		"headscaleDomain": requestedDomain,
	})
	if err != nil {
		_ = h.markJobFailed(r.Context(), jobID, "encode daemon body: "+err.Error())
		writeError(w, http.StatusInternalServerError, "internal", "Failed to encode daemon request")
		return
	}

	status, daemonResp, err := h.callUpdater(r.Context(), http.MethodPost, "/configure_headscale", daemonBody)
	if err != nil {
		_ = h.markJobFailed(r.Context(), jobID, "daemon unreachable: "+err.Error())
		writeError(w, http.StatusBadGateway, "updater_unreachable",
			"Could not reach the self-update daemon: "+err.Error())
		return
	}
	if status >= 400 {
		var ue struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(daemonResp, &ue)
		errCode := ue.Error
		if errCode == "" {
			errCode = "updater_error"
		}
		_ = h.markJobFailed(r.Context(), jobID, "daemon returned "+errCode)
		clientStatus := http.StatusBadGateway
		if status == http.StatusConflict {
			clientStatus = http.StatusConflict
		}
		writeError(w, clientStatus, errCode, headscaleErrorMessage(errCode))
		return
	}

	auditMeta := map[string]any{
		"jobId":           jobID,
		"headscaleDomain": requestedDomain,
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionHeadscaleConfigureInitiated,
		TargetType: audit.TargetSynapse,
		TargetID:   jobID,
		Metadata:   auditMeta,
	})

	writeJSON(w, http.StatusAccepted, headscaleConfigureResp{
		JobID:     jobID,
		StatusURL: "/v1/admin/headscale/status/" + jobID,
		State:     "queued",
		Domain:    requestedDomain,
		ServerURL: "https://" + requestedDomain,
		DNSAuto:   dnsAuto,
	})
}

// headscaleErrorMessage humanises the codes the daemon emits so the
// dashboard banner doesn't render snake_case to the operator.
func headscaleErrorMessage(code string) string {
	switch code {
	case "configure_in_progress":
		return "Another Headscale configure job is already running. Wait for it to finish."
	case "invalid_payload":
		return "The configure request was malformed (bad characters or empty body)."
	case "missing_job_id":
		return "The configure request was missing its job id."
	case "invalid_job_id":
		return "The configure request had a malformed job id."
	default:
		return "Self-update daemon returned " + code
	}
}

// ---------- GET /v1/admin/headscale/status/{jobID} ----------
//
// Same shape as the host-domain status endpoint — the dashboard's
// "Apply" dialog reuses the polling component, so identical fields
// keep the UX cadence consistent.
func (h *AdminHandler) getHeadscaleStatus(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "jobID")
	if jobID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "job id is required")
		return
	}

	var (
		state                 string
		logText               string
		errStr                *string
		createdAt             time.Time
		startedAt, finishedAt *time.Time
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT state, log, error, created_at, started_at, finished_at
		  FROM admin_jobs
		 WHERE id = $1 AND kind = 'configure_headscale'
	`, jobID).Scan(&state, &logText, &errStr, &createdAt, &startedAt, &finishedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "job_not_found",
				"No Headscale configure job with that id")
			return
		}
		if isInvalidUUID(err) {
			writeError(w, http.StatusNotFound, "job_not_found",
				"No Headscale configure job with that id")
			return
		}
		logErr("load admin_jobs (headscale)", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load job")
		return
	}

	if len(logText) > maxStatusLogBytes {
		logText = "...\n" + logText[len(logText)-maxStatusLogBytes:]
	}

	resp := hostDomainStatusResp{
		ID:         jobID,
		State:      state,
		Log:        logText,
		CreatedAt:  createdAt,
		StartedAt:  startedAt,
		FinishedAt: finishedAt,
	}
	if errStr != nil {
		resp.Error = *errStr
	}
	writeJSON(w, http.StatusOK, resp)
}