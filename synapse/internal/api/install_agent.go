package api

import (
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
)

// InstallAgentHandler powers install-agent.sh's pre-Tailscale-join
// bootstrap query. The agent has only the operator-supplied
// --control-url at this point; it asks Synapse central "where do I
// point `tailscale up --login-server`?" so the dashboard one-liner
// doesn't have to carry 4 separate URLs.
//
// Public + unauth: the agent isn't registered yet (that comes after
// it has a tailnet IP) and can't carry a Bearer. The response
// reveals only what's already publicly observable from a curl to
// the headscale subdomain, plus the agent download manifest.
type InstallAgentHandler struct {
	// HeadscaleServerURL is the EXTERNAL URL Tailscale clients pass
	// to `tailscale up --login-server=...`. Empty when Remote Hosts
	// is disabled (no --enable-headscale at setup time); the handler
	// still returns 200 in that case and install-agent.sh refuses
	// based on remoteHostsEnabled=false with a clear error.
	HeadscaleServerURL string
	// AgentDownloadBase is the GitHub Release asset prefix (e.g.
	// https://github.com/Iann29/convex-synapse/releases/latest/download).
	// The handler appends the version+arch suffix to form the
	// concrete download URL pattern install-agent.sh substitutes.
	AgentDownloadBase string
	// AgentVersion is the running control-plane binary version
	// (server's main.Version). Echoed back so install-agent.sh can
	// log a compatibility line and skip the download when the on-
	// disk binary already matches.
	AgentVersion string
	// CryptoConfigured is true when *crypto.SecretBox is wired
	// (SYNAPSE_STORAGE_KEY present + valid). Together with a non-
	// empty HeadscaleServerURL it flips RemoteProvisioningEnabled
	// in the config response, so install-agent.sh can refuse early
	// instead of 503'ing on the encrypt step inside register.
	CryptoConfigured bool
	// ScriptPath is the on-disk location of install-agent.sh inside
	// the synapse-api container (mounted read-only via
	// docker-compose). The /v1/install_agent/script route serves its
	// bytes so the dashboard one-liner can `curl <PublicURL>/v1/
	// install_agent/script | sudo bash`. Empty → defaults to
	// "/install-agent.sh" (the compose mount target). Served under
	// /v1 so Caddy routes it to the api without a routing change —
	// the root path /install-agent.sh would land on the dashboard
	// (Next.js) and 404, the v1.18→v1.19 gap this fixes.
	ScriptPath string
}

// defaultInstallAgentScriptPath is the compose mount target for
// install-agent.sh inside the synapse-api container.
const defaultInstallAgentScriptPath = "/install-agent.sh"

func (h *InstallAgentHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/config", h.config)
	r.Get("/script", h.script)
	return r
}

// script serves the install-agent.sh bytes. Public + unauth: the
// new VPS has nothing but the operator-supplied --control-url when
// it runs `curl <url>/v1/install_agent/script | sudo bash`. The
// script itself carries no secrets — the tokens are passed as flags
// by the dashboard one-liner, never baked into the script.
func (h *InstallAgentHandler) script(w http.ResponseWriter, r *http.Request) {
	path := h.ScriptPath
	if path == "" {
		path = defaultInstallAgentScriptPath
	}
	data, err := os.ReadFile(path)
	if err != nil {
		logErr("install_agent: read script", err)
		writeError(w, http.StatusServiceUnavailable, "install_agent_script_unavailable",
			"install-agent.sh is not available on the control plane — ensure docker-compose mounts it into synapse-api")
		return
	}
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// agentInstallConfig is the install-agent.sh bootstrap payload.
// Adding fields is backward-compatible (older agents ignore unknown
// JSON fields). Removing fields IS breaking — mark with deprecation
// comment + ship-then-remove across two minor releases.
type agentInstallConfig struct {
	// HeadscaleServerURL is what install-agent.sh passes to
	// `tailscale up --login-server`. Empty when --enable-headscale
	// wasn't set on the control plane — install-agent.sh refuses
	// with a clear error in that case.
	HeadscaleServerURL string `json:"headscaleServerUrl"`
	// AgentDownloadURL is the GitHub Release asset URL pattern.
	// install-agent.sh substitutes {{version}} + {{arch}} (amd64 /
	// arm64) before invoking curl.
	AgentDownloadURL string `json:"agentDownloadUrl"`
	// AgentVersion lets install-agent.sh log a compatibility line.
	AgentVersion string `json:"agentVersion"`
	// RemoteHostsEnabled flips to true only when HeadscaleServerURL
	// is non-empty. Single-source-of-truth: clients check this
	// boolean instead of guessing from absence of the URL.
	RemoteHostsEnabled bool `json:"remoteHostsEnabled"`
	// RemoteProvisioningEnabled is true ONLY when SYNAPSE_HEADSCALE_URL
	// AND SYNAPSE_STORAGE_KEY are BOTH configured. install-agent.sh
	// refuses with a clear hint when this is false (the register call
	// would otherwise 503 silently on the encrypt step).
	RemoteProvisioningEnabled bool `json:"remoteProvisioningEnabled"`
}

func (h *InstallAgentHandler) config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, agentInstallConfig{
		HeadscaleServerURL:        h.HeadscaleServerURL,
		AgentDownloadURL:          h.AgentDownloadBase + "/synapse-agent-{{version}}-linux-{{arch}}.tar.gz",
		AgentVersion:              h.AgentVersion,
		RemoteHostsEnabled:        h.HeadscaleServerURL != "",
		RemoteProvisioningEnabled: h.HeadscaleServerURL != "" && h.CryptoConfigured,
	})
}
