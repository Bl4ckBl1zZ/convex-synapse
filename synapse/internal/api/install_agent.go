package api

import (
	"net/http"

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
}

func (h *InstallAgentHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/config", h.config)
	return r
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
