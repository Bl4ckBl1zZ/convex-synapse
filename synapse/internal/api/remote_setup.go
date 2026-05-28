package api

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/headscale"
)

// Remote Hosts (v1.18+, Phase 5). The dashboard's "Setup remote install"
// button hits POST /v1/hosts/{id}/remote_setup; the handler mints a
// Synapse adoption token AND a Headscale pre-auth key in a single call,
// returning a copy-pasteable install-agent.sh one-liner. Two tokens are
// returned in plaintext exactly once — same contract as the existing
// adoption-token endpoint, never persisted on the dashboard side.
//
// Gated by HostsHandler.requireInstanceAdmin (mounted on the same
// /v1/hosts sub-router as adoption_token); reuses the
// auth.GenerateTokenWithPrefix("syn_adopt_") + hash-at-rest helper so we
// don't fork the token-mint flow. Disabled with 503 remote_hosts_disabled
// when the operator didn't run setup.sh --enable-headscale.

// remoteSetupResp is the bundle returned to the dashboard. AdoptionToken
// + HeadscaleAuthKey are PLAINTEXT — shown ONCE in the modal, never
// persisted on the dashboard side. OneLiner is the pre-rendered bash
// command the operator pastes into the new VPS's root shell.
type remoteSetupResp struct {
	AdoptionToken      string    `json:"adoptionToken"`
	HeadscaleAuthKey   string    `json:"headscaleAuthKey"`
	ControlURL         string    `json:"controlUrl"`
	HeadscaleServerURL string    `json:"headscaleServerUrl"`
	OneLiner           string    `json:"oneLiner"`
	ExpiresAt          time.Time `json:"expiresAt"`
}

// remoteSetupTTL: both tokens expire at the same UTC instant — 1h is
// long enough for an operator to SSH into the new VPS and paste the
// one-liner, short enough that a forgotten value can't be claimed
// hours later by a stranger.
const remoteSetupTTL = time.Hour

// remoteSetupAdoptionPrefix is the prefix on the plaintext adoption
// token portion of the bundle. We use a distinct "syn_adopt_" prefix
// (rather than the bare auth.TokenPrefix) so leak-scanners + audit
// queries can tell apart a Remote Hosts bundle token from a regular
// personal-access token without checking which table it lives in.
const remoteSetupAdoptionPrefix = "syn_adopt_"

func (h *HostsHandler) createRemoteSetup(w http.ResponseWriter, r *http.Request) {
	// Headscale wiring is the single signal that Remote Hosts is
	// configured: both the API key client AND the externally-reachable
	// server URL must be present (one without the other is a partial
	// setup that would 502 mid-flow). Return 503 with a hint so the
	// dashboard's modal renders a friendly error.
	if h.Headscale == nil || h.HeadscaleServerURL == "" {
		writeError(w, http.StatusServiceUnavailable, "remote_hosts_disabled",
			"Remote Hosts not enabled — open Admin → Remote Hosts in the dashboard to configure Headscale")
		return
	}

	uid, _ := auth.UserID(r.Context())

	// requireInstanceAdmin middleware on the parent router already
	// enforced admin + authenticated; we still load the host row so
	// 404 / "host not found" stays distinct from the generic admin
	// rejection a malformed id would otherwise produce.
	hostID := chi.URLParam(r, "hostID")
	var hostName string
	err := h.DB.QueryRow(r.Context(),
		`SELECT name FROM hosts WHERE id::text = $1`, hostID,
	).Scan(&hostName)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "host_not_found", "Host not found")
		return
	}
	if err != nil {
		logErr("remote_setup: load host", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load host")
		return
	}

	expiresAt := time.Now().Add(remoteSetupTTL).UTC()

	// 1) Mint the adoption token bound to this host. Persist the hash
	//    + expiry; the plaintext goes back over the wire once. Same
	//    storage shape as createAdoptionToken so the agent-register
	//    path (resolveOrCreateHost) lights up unchanged.
	adoptionPlain, adoptionHash, err := auth.GenerateTokenWithPrefix(remoteSetupAdoptionPrefix)
	if err != nil {
		logErr("remote_setup: generate adoption token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to mint adoption token")
		return
	}
	var uidPtr *string
	if uid != "" {
		uidPtr = &uid
	}
	tokenName := "remote-setup-" + time.Now().UTC().Format("20060102-150405")
	if _, err := h.DB.Exec(r.Context(), `
		INSERT INTO host_adoption_tokens (host_id, token_hash, name, expires_at, created_by_user_id)
		VALUES ($1::uuid, $2, $3, $4, $5)
	`, hostID, adoptionHash, tokenName, expiresAt, uidPtr); err != nil {
		logErr("remote_setup: insert adoption token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to mint adoption token")
		return
	}

	// 2) Mint the Headscale pre-auth key under the "synapse" user
	//    (Synapse uses a single namespace; tag-based ACLs handle
	//    multi-tenancy in a later phase). Single-use, NOT ephemeral,
	//    matching the adoption-token TTL so the operator only has one
	//    expiry to remember.
	pak, err := h.Headscale.CreatePreAuthKey(r.Context(), headscale.CreatePreAuthKeyOpts{
		User:       "synapse",
		Reusable:   false,
		Ephemeral:  false,
		Expiration: expiresAt,
		// v1.19+: tag every remote-host pre-auth key with
		// tag:synapse-remote so the default ACL (control plane only
		// reaches remote hosts on port 22) applies the moment the
		// host joins. Untagged hosts would silently inherit a
		// permissive default if an operator later widens the policy.
		ACLTags: []string{"tag:synapse-remote"},
	})
	if err != nil {
		logErr("remote_setup: mint headscale preauth key", err)
		writeError(w, http.StatusBadGateway, "headscale_unreachable",
			"Headscale rejected pre-auth key mint — check the control plane logs")
		return
	}

	// 3) Compose the one-liner. control-url is the EXTERNAL Synapse
	//    origin (h.PublicURL) — install-agent.sh is fetched from
	//    /v1/install_agent/script (served by the api + routed through
	//    Caddy's /v1/* rule; the bare /install-agent.sh path would
	//    land on the Next.js dashboard and 404 — the v1.18→v1.19
	//    gap). The register POSTs against the same origin. The
	//    `bash -s --` form passes flags through `curl | sudo bash`
	//    without bash claiming them as its own.
	controlURL := h.PublicURL
	oneLiner := fmt.Sprintf(
		"curl -fsSL %s/v1/install_agent/script | sudo bash -s -- --control-url=%s --headscale-auth=%s --adoption-token=%s",
		controlURL, controlURL, pak.Key, adoptionPlain,
	)

	// Audit. Metadata is intentionally token-free — the plaintext
	// values must NEVER touch the audit log. Operators can trace
	// "who minted a bundle for which host" via the recorded host id
	// + name + expiresAt; the actual secrets stayed on the wire.
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionMintRemoteSetup,
		TargetType: audit.TargetHost,
		TargetID:   hostID,
		Metadata: map[string]any{
			"hostName":  hostName,
			"expiresAt": expiresAt.Format(time.RFC3339),
		},
	})

	writeJSON(w, http.StatusCreated, remoteSetupResp{
		AdoptionToken:      adoptionPlain,
		HeadscaleAuthKey:   pak.Key,
		ControlURL:         controlURL,
		HeadscaleServerURL: h.HeadscaleServerURL,
		OneLiner:           oneLiner,
		ExpiresAt:          expiresAt,
	})
}
