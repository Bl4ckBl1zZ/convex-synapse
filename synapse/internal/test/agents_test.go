package synapsetest

import (
	"bytes"
	"context"
	"database/sql"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/models"
)

// synapse-agent backend endpoints (feat/cell-control-plane, Bloco 6).
// Register (adoption-token auth) + heartbeat / desired_state (agent-token
// auth). Public routes — no JWT.

type adoptionTokenResult struct {
	Token       string     `json:"token"`
	ID          string     `json:"id"`
	HostID      string     `json:"hostId"`
	Name        string     `json:"name,omitempty"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	JoinCommand string     `json:"joinCommand"`
}

type agentRegisterResult struct {
	HostID     string `json:"hostId"`
	AgentID    string `json:"agentId"`
	AgentToken string `json:"agentToken"`
	Config     struct {
		ControlURL               string `json:"controlUrl,omitempty"`
		HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
		Mode                     string `json:"mode"`
	} `json:"config"`
}

// mintHostToken creates a host (as the instance admin) and an adoption token
// bound to it, returning the admin, host id, and the plaintext token.
func mintHostToken(t *testing.T, h *Harness, hostName string) (*User, string, adoptionTokenResult) {
	t.Helper()
	admin := h.RegisterRandomUser()
	var host models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", admin.AccessToken,
		map[string]any{"name": hostName}, http.StatusCreated, &host)
	var tok adoptionTokenResult
	h.DoJSON(http.MethodPost, "/v1/hosts/"+host.ID+"/adoption_token", admin.AccessToken,
		map[string]any{}, http.StatusCreated, &tok)
	return admin, host.ID, tok
}

func agentRegisterBody(token string) map[string]any {
	return map[string]any{
		"token":         token,
		"hostname":      "vps-1.local",
		"os":            "linux",
		"arch":          "amd64",
		"agentVersion":  "test-agent-1.0",
		"dockerVersion": "27.0.0",
		"cpuCores":      4,
		"memoryMb":      8192,
		"diskGb":        80,
	}
}

func TestAgent_RegisterActivatesHost(t *testing.T) {
	h := Setup(t)
	admin, hostID, tok := mintHostToken(t, h, "vps-1")

	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	if reg.HostID != hostID {
		t.Fatalf("register returned host %s, want %s", reg.HostID, hostID)
	}
	if !strings.HasPrefix(reg.AgentToken, "syn_agent_") {
		t.Errorf("agent token should carry the syn_agent_ prefix, got %q", reg.AgentToken)
	}
	if reg.Config.Mode != "observe-only" || reg.Config.HeartbeatIntervalSeconds != 15 {
		t.Errorf("unexpected config: %+v", reg.Config)
	}

	// Host flips online with the reported facts.
	var host models.Host
	h.DoJSON(http.MethodGet, "/v1/hosts/"+hostID, admin.AccessToken, nil, http.StatusOK, &host)
	if host.Status != models.HostStatusOnline {
		t.Errorf("host status = %q, want online", host.Status)
	}
	if host.AgentVersion != "test-agent-1.0" || host.DockerVersion != "27.0.0" {
		t.Errorf("host facts not applied: %+v", host)
	}
	if host.CPUCores == nil || *host.CPUCores != 4 || host.MemoryMB == nil || *host.MemoryMB != 8192 {
		t.Errorf("host specs not applied: cpu=%v mem=%v", host.CPUCores, host.MemoryMB)
	}
	if host.LastHeartbeatAt == nil {
		t.Errorf("lastHeartbeatAt should be set after register")
	}
}

func TestAgent_HeartbeatUpdatesHostAndAgent(t *testing.T) {
	h := Setup(t)
	admin, hostID, tok := mintHostToken(t, h, "vps-1")
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	// A later heartbeat reports a new agent version + observed payload.
	hb := map[string]any{
		"hostId":        reg.HostID,
		"agentId":       reg.AgentID,
		"hostname":      "vps-1.local",
		"os":            "linux",
		"arch":          "amd64",
		"agentVersion":  "test-agent-1.1",
		"dockerVersion": "27.1.0",
		"cpuCores":      8,
		"memoryMb":      16384,
		"diskGb":        160,
		"observed": map[string]any{
			"dockerAvailable":          true,
			"synapseManagedContainers": []string{"convex-lush-heron-4656"},
		},
	}
	var ok map[string]any
	h.DoJSON(http.MethodPost, "/v1/agents/heartbeat", reg.AgentToken, hb, http.StatusOK, &ok)
	if ok["ok"] != true {
		t.Errorf("heartbeat response = %+v", ok)
	}

	var host models.Host
	h.DoJSON(http.MethodGet, "/v1/hosts/"+hostID, admin.AccessToken, nil, http.StatusOK, &host)
	if host.AgentVersion != "test-agent-1.1" || host.DockerVersion != "27.1.0" {
		t.Errorf("heartbeat facts not applied: %+v", host)
	}
	if host.CPUCores == nil || *host.CPUCores != 8 {
		t.Errorf("heartbeat cpu not applied: %v", host.CPUCores)
	}

	// The observed payload landed on the agent row.
	var payload *string
	if err := h.DB.QueryRow(context.Background(),
		`SELECT last_heartbeat_payload::text FROM host_agents WHERE id = $1`, reg.AgentID).Scan(&payload); err != nil {
		t.Fatalf("query agent payload: %v", err)
	}
	if payload == nil || !strings.Contains(*payload, "convex-lush-heron-4656") {
		t.Errorf("observed payload not persisted: %v", payload)
	}
}

func TestAgent_RegisterRejectsExpiredToken(t *testing.T) {
	h := Setup(t)
	_, _, tok := mintHostToken(t, h, "vps-1")
	if _, err := h.DB.Exec(context.Background(),
		`UPDATE host_adoption_tokens SET expires_at = now() - interval '1 hour' WHERE id = $1`, tok.ID); err != nil {
		t.Fatalf("expire token: %v", err)
	}
	env := h.AssertStatus(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusUnauthorized)
	if env.Code != "adoption_token_expired" {
		t.Errorf("code = %q, want adoption_token_expired", env.Code)
	}
}

func TestAgent_RegisterRejectsUsedToken(t *testing.T) {
	h := Setup(t)
	_, _, tok := mintHostToken(t, h, "vps-1")
	// First use succeeds.
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &agentRegisterResult{})
	// Reuse is rejected.
	env := h.AssertStatus(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusUnauthorized)
	if env.Code != "adoption_token_used" {
		t.Errorf("code = %q, want adoption_token_used", env.Code)
	}
}

func TestAgent_RegisterRejectsRevokedToken(t *testing.T) {
	h := Setup(t)
	_, _, tok := mintHostToken(t, h, "vps-1")
	if _, err := h.DB.Exec(context.Background(),
		`UPDATE host_adoption_tokens SET revoked_at = now() WHERE id = $1`, tok.ID); err != nil {
		t.Fatalf("revoke token: %v", err)
	}
	env := h.AssertStatus(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusUnauthorized)
	if env.Code != "adoption_token_revoked" {
		t.Errorf("code = %q, want adoption_token_revoked", env.Code)
	}
}

func TestAgent_RegisterRejectsUnknownToken(t *testing.T) {
	h := Setup(t)
	env := h.AssertStatus(http.MethodPost, "/v1/agents/register", "",
		agentRegisterBody("syn_bogus_token"), http.StatusUnauthorized)
	if env.Code != "invalid_adoption_token" {
		t.Errorf("code = %q, want invalid_adoption_token", env.Code)
	}
}

func TestAgent_HeartbeatRejectsInvalidToken(t *testing.T) {
	h := Setup(t)
	h.AssertStatus(http.MethodPost, "/v1/agents/heartbeat", "syn_agent_bogus",
		map[string]any{"hostId": "x"}, http.StatusUnauthorized)
	// Missing bearer too.
	h.AssertStatus(http.MethodPost, "/v1/agents/heartbeat", "",
		map[string]any{"hostId": "x"}, http.StatusUnauthorized)
}

func TestAgent_DesiredStateEmptyButAuthenticated(t *testing.T) {
	h := Setup(t)
	_, _, tok := mintHostToken(t, h, "vps-1")
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	// Authenticated → empty desired state (this host has no placements/desired).
	var ds struct {
		Version      int    `json:"version"`
		Mode         string `json:"mode"`
		ApplyAllowed bool   `json:"applyAllowed"`
		Resources    []any  `json:"resources"`
	}
	h.DoJSON(http.MethodGet, "/v1/agents/desired_state", reg.AgentToken, nil, http.StatusOK, &ds)
	if ds.Version != 0 || len(ds.Resources) != 0 {
		t.Errorf("desired state = %+v, want empty", ds)
	}
	if ds.ApplyAllowed {
		t.Errorf("applyAllowed MUST be false")
	}

	// Unauthenticated → 401.
	h.AssertStatus(http.MethodGet, "/v1/agents/desired_state", "", nil, http.StatusUnauthorized)
}

// ---------- Bloco 6.5: liveness + agent lifecycle ----------

type hostAgentItem struct {
	ID             string     `json:"id"`
	HostID         string     `json:"hostId"`
	Status         string     `json:"status"`
	ConnectionMode string     `json:"connectionMode"`
	LastSeenAt     *time.Time `json:"lastSeenAt,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
	Observed       *struct {
		DockerAvailable       bool `json:"dockerAvailable"`
		ManagedContainerCount int  `json:"managedContainerCount"`
	} `json:"observed,omitempty"`
}

type hostAgentsListResult struct {
	AgentVersion string          `json:"agentVersion,omitempty"`
	Items        []hostAgentItem `json:"items"`
}

func TestHost_EffectiveStatusTransitions(t *testing.T) {
	h := Setup(t)
	admin, hostID, tok := mintHostToken(t, h, "vps-1")
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &agentRegisterResult{})

	getStatus := func() string {
		var host models.Host
		h.DoJSON(http.MethodGet, "/v1/hosts/"+hostID, admin.AccessToken, nil, http.StatusOK, &host)
		return host.EffectiveStatus
	}
	setHeartbeatAge := func(seconds int) {
		if _, err := h.DB.Exec(context.Background(),
			`UPDATE hosts SET last_heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1`,
			hostID, seconds); err != nil {
			t.Fatalf("age heartbeat: %v", err)
		}
	}

	// Fresh register → online (default thresholds 60/300 in tests).
	if s := getStatus(); s != models.HostStatusOnline {
		t.Errorf("fresh host effectiveStatus = %q, want online", s)
	}
	// 120s old → stale.
	setHeartbeatAge(120)
	if s := getStatus(); s != models.HostStatusStale {
		t.Errorf("120s-old host effectiveStatus = %q, want stale", s)
	}
	// 600s old → offline.
	setHeartbeatAge(600)
	if s := getStatus(); s != models.HostStatusOffline {
		t.Errorf("600s-old host effectiveStatus = %q, want offline", s)
	}
}

func TestHost_AgentsList(t *testing.T) {
	h := Setup(t)
	admin, hostID, tok := mintHostToken(t, h, "vps-1")
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	// Heartbeat with an observed payload so the summary is populated.
	hb := map[string]any{
		"agentVersion": "test-agent-1.0",
		"observed": map[string]any{
			"dockerAvailable":          true,
			"synapseManagedContainers": []string{"convex-a", "convex-b"},
		},
	}
	h.DoJSON(http.MethodPost, "/v1/agents/heartbeat", reg.AgentToken, hb, http.StatusOK, &map[string]any{})

	var list hostAgentsListResult
	h.DoJSON(http.MethodGet, "/v1/hosts/"+hostID+"/agents", admin.AccessToken, nil, http.StatusOK, &list)
	if len(list.Items) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(list.Items))
	}
	a := list.Items[0]
	if a.ID != reg.AgentID || a.HostID != hostID || a.Status != models.HostAgentStatusOnline {
		t.Errorf("agent view wrong: %+v", a)
	}
	if a.Observed == nil || !a.Observed.DockerAvailable || a.Observed.ManagedContainerCount != 2 {
		t.Errorf("observed summary wrong: %+v", a.Observed)
	}
	// Non-admin can't list agents.
	stranger := h.RegisterRandomUser()
	h.AssertStatus(http.MethodGet, "/v1/hosts/"+hostID+"/agents", stranger.AccessToken, nil, http.StatusForbidden)
}

func TestAgent_RevokeBlocksHeartbeat(t *testing.T) {
	h := Setup(t)
	admin, _, tok := mintHostToken(t, h, "vps-1")
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	// Heartbeat works before revoke.
	h.DoJSON(http.MethodPost, "/v1/agents/heartbeat", reg.AgentToken, map[string]any{}, http.StatusOK, &map[string]any{})

	// Revoke (instance-admin).
	h.DoJSON(http.MethodPost, "/v1/host_agents/"+reg.AgentID+"/revoke", admin.AccessToken, map[string]any{}, http.StatusOK, &map[string]any{})

	// Same token now fails.
	h.AssertStatus(http.MethodPost, "/v1/agents/heartbeat", reg.AgentToken, map[string]any{}, http.StatusUnauthorized)

	// Non-admin can't revoke.
	stranger := h.RegisterRandomUser()
	h.AssertStatus(http.MethodPost, "/v1/host_agents/"+reg.AgentID+"/revoke", stranger.AccessToken, map[string]any{}, http.StatusForbidden)
	assertAuditEvent(t, h, audit.ActionRevokeHostAgent, admin.ID, audit.TargetHostAgent, reg.AgentID)
}

func TestAgent_RotateToken(t *testing.T) {
	h := Setup(t)
	admin, _, tok := mintHostToken(t, h, "vps-1")
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	var rot struct {
		ID         string `json:"id"`
		HostID     string `json:"hostId"`
		AgentToken string `json:"agentToken"`
	}
	h.DoJSON(http.MethodPost, "/v1/host_agents/"+reg.AgentID+"/rotate_token", admin.AccessToken, map[string]any{}, http.StatusOK, &rot)
	if !strings.HasPrefix(rot.AgentToken, "syn_agent_") || rot.AgentToken == reg.AgentToken {
		t.Errorf("rotate should mint a new syn_agent_ token, got %q", rot.AgentToken)
	}

	// Old token no longer works; new token does.
	h.AssertStatus(http.MethodPost, "/v1/agents/heartbeat", reg.AgentToken, map[string]any{}, http.StatusUnauthorized)
	h.DoJSON(http.MethodPost, "/v1/agents/heartbeat", rot.AgentToken, map[string]any{}, http.StatusOK, &map[string]any{})
	assertAuditEvent(t, h, audit.ActionRotateHostAgentToken, admin.ID, audit.TargetHostAgent, reg.AgentID)
}

func TestAgent_HeartbeatIgnoresBodyHostID(t *testing.T) {
	h := Setup(t)
	admin, hostAID, tokA := mintHostToken(t, h, "host-A")
	var regA agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tokA.Token), http.StatusCreated, &regA)

	// A second, unrelated host.
	var hostB models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", admin.AccessToken, map[string]any{"name": "host-B"}, http.StatusCreated, &hostB)

	// Agent A heartbeats but LIES about hostId (claims host B). The server must
	// update host A (from the token), never host B (from the body).
	hb := map[string]any{
		"hostId":       hostB.ID,
		"agentId":      "whatever",
		"agentVersion": "lied-1.2.3",
	}
	h.DoJSON(http.MethodPost, "/v1/agents/heartbeat", regA.AgentToken, hb, http.StatusOK, &map[string]any{})

	var a, b models.Host
	h.DoJSON(http.MethodGet, "/v1/hosts/"+hostAID, admin.AccessToken, nil, http.StatusOK, &a)
	h.DoJSON(http.MethodGet, "/v1/hosts/"+hostB.ID, admin.AccessToken, nil, http.StatusOK, &b)
	if a.AgentVersion != "lied-1.2.3" {
		t.Errorf("host A should have been updated from the token, got agentVersion %q", a.AgentVersion)
	}
	if b.AgentVersion == "lied-1.2.3" {
		t.Errorf("host B must NOT be updated from a body hostId — tenant/host isolation breach")
	}
}

// ---------- v1.18 Remote Hosts contract ----------

// TestAgent_Register_WithRemoteFields_PersistsHostRow locks the v1.18
// Remote Hosts wire contract: install-agent.sh sends tailnet_addr +
// ssh_* in the register body; backend persists them on the host row +
// flips is_remote=true. Pre-v1.18 agents omit these fields and the
// host stays is_remote=false (covered by the StaysLocal sibling).
func TestAgent_Register_WithRemoteFields_PersistsHostRow(t *testing.T) {
	h := Setup(t)
	_, hostID, tok := mintHostToken(t, h, "vps-eu-1")

	sshPort := 22
	body := map[string]any{
		"token":        tok.Token,
		"hostname":     "vps-eu-1",
		"os":           "linux",
		"arch":         "amd64",
		"agentVersion": "v1.18.0",
		"tailnetAddr":  "100.64.0.5",
		"sshPubkey":    "ssh-ed25519 AAAAC3Nz... synapse-deployer@vps-eu-1",
		"sshUser":      "synapse-deployer",
		"sshPort":      sshPort,
	}
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", body, http.StatusCreated, &reg)
	if reg.HostID != hostID {
		t.Fatalf("register returned host %s, want %s", reg.HostID, hostID)
	}

	var (
		tailnetAddr, sshPubkey, sshUser sql.NullString
		sshPortDB                       int
		isRemote                        bool
	)
	if err := h.DB.QueryRow(context.Background(),
		`SELECT tailnet_addr, ssh_pubkey, ssh_user, ssh_port, is_remote FROM hosts WHERE id = $1`,
		hostID,
	).Scan(&tailnetAddr, &sshPubkey, &sshUser, &sshPortDB, &isRemote); err != nil {
		t.Fatalf("load host: %v", err)
	}
	if !isRemote {
		t.Errorf("is_remote should be true after remote-fields register")
	}
	if tailnetAddr.String != "100.64.0.5" {
		t.Errorf("tailnet_addr: got %q, want 100.64.0.5", tailnetAddr.String)
	}
	if !strings.HasPrefix(sshPubkey.String, "ssh-ed25519 ") {
		t.Errorf("ssh_pubkey shape: got %q", sshPubkey.String)
	}
	if sshUser.String != "synapse-deployer" {
		t.Errorf("ssh_user: got %q, want synapse-deployer", sshUser.String)
	}
	if sshPortDB != 22 {
		t.Errorf("ssh_port: got %d, want 22", sshPortDB)
	}
}

// TestAgent_Register_WithoutRemoteFields_StaysLocal locks the
// backward-compat: pre-v1.18 agents that don't send tailnet/ssh fields
// keep is_remote=false. Important so upgrading existing fleets doesn't
// silently flip them into remote-provisioning mode.
func TestAgent_Register_WithoutRemoteFields_StaysLocal(t *testing.T) {
	h := Setup(t)
	_, hostID, tok := mintHostToken(t, h, "vps-legacy")

	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	var (
		tailnetAddr, sshPubkey sql.NullString
		isRemote               bool
	)
	if err := h.DB.QueryRow(context.Background(),
		`SELECT tailnet_addr, ssh_pubkey, is_remote FROM hosts WHERE id = $1`,
		hostID,
	).Scan(&tailnetAddr, &sshPubkey, &isRemote); err != nil {
		t.Fatalf("load host: %v", err)
	}
	if isRemote {
		t.Errorf("is_remote should stay false when register omits remote fields")
	}
	if tailnetAddr.Valid {
		t.Errorf("tailnet_addr should stay NULL, got %q", tailnetAddr.String)
	}
	if sshPubkey.Valid {
		t.Errorf("ssh_pubkey should stay NULL, got %q", sshPubkey.String)
	}
}

// ---------- /v1/install_agent/config (public, unauth) ----------

type installAgentConfigResult struct {
	HeadscaleServerURL        string `json:"headscaleServerUrl"`
	AgentDownloadURL          string `json:"agentDownloadUrl"`
	AgentVersion              string `json:"agentVersion"`
	RemoteHostsEnabled        bool   `json:"remoteHostsEnabled"`
	RemoteProvisioningEnabled bool   `json:"remoteProvisioningEnabled"`
}

// TestInstallAgent_Config_Disabled covers the default harness: Remote
// Hosts isn't configured (HeadscaleServerURL empty), but the endpoint
// still 200s — install-agent.sh gates on remoteHostsEnabled=false to
// emit a clear "control plane has not enabled Remote Hosts" error
// instead of a confusing curl failure.
func TestInstallAgent_Config_Disabled(t *testing.T) {
	h := Setup(t)
	var resp installAgentConfigResult
	h.DoJSON(http.MethodGet, "/v1/install_agent/config", "", nil, http.StatusOK, &resp)
	if resp.RemoteHostsEnabled {
		t.Errorf("remoteHostsEnabled should be false when HeadscaleServerURL is empty")
	}
	if resp.HeadscaleServerURL != "" {
		t.Errorf("HeadscaleServerURL should be empty, got %q", resp.HeadscaleServerURL)
	}
}

// TestInstallAgent_Config_Enabled covers the configured path: the
// endpoint echoes back the EXTERNAL Headscale URL + the parameterised
// download URL pattern install-agent.sh substitutes {{version}} /
// {{arch}} into.
func TestInstallAgent_Config_Enabled(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{HeadscaleServerURL: "https://headscale.example.com"})
	var resp installAgentConfigResult
	h.DoJSON(http.MethodGet, "/v1/install_agent/config", "", nil, http.StatusOK, &resp)
	if !resp.RemoteHostsEnabled {
		t.Errorf("remoteHostsEnabled should be true when HeadscaleServerURL is set")
	}
	if resp.HeadscaleServerURL != "https://headscale.example.com" {
		t.Errorf("HeadscaleServerURL: got %q", resp.HeadscaleServerURL)
	}
	if !strings.Contains(resp.AgentDownloadURL, "{{arch}}") {
		t.Errorf("AgentDownloadURL should carry the {{arch}} substitution placeholder, got %q", resp.AgentDownloadURL)
	}
	if !strings.Contains(resp.AgentDownloadURL, "{{version}}") {
		t.Errorf("AgentDownloadURL should carry the {{version}} substitution placeholder, got %q", resp.AgentDownloadURL)
	}
	// Must be tag-pinned: /releases/download/v{{version}}/... — NOT
	// /releases/latest/. The latest form 404s the moment a newer release
	// ships than the advertised agentVersion (v1.19.9 vs latest=v1.19.10).
	if !strings.Contains(resp.AgentDownloadURL, "/releases/download/v{{version}}/") {
		t.Errorf("AgentDownloadURL must be tag-pinned (/releases/download/v{{version}}/), got %q", resp.AgentDownloadURL)
	}
	if strings.Contains(resp.AgentDownloadURL, "/releases/latest/") {
		t.Errorf("AgentDownloadURL must NOT use /releases/latest/ (version-skew 404), got %q", resp.AgentDownloadURL)
	}
}

// ---------- v1.18 Phase 3: SSH privkey encrypt-at-rest ----------

// TestAgent_Register_WithSSHPrivkey_EncryptsAndPersists verifies the
// v1.18 Phase 3 contract: install-agent.sh sends the PEM-encoded ed25519
// private key once, Synapse encrypts with crypto.SecretBox and persists
// in hosts.ssh_privkey_encrypted. The plaintext NEVER appears in the
// stored row.
func TestAgent_Register_WithSSHPrivkey_EncryptsAndPersists(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{WithCrypto: true})
	_, hostID, tok := mintHostToken(t, h, "vps-eu-1")

	privkeyPlaintext := "-----BEGIN OPENSSH PRIVATE KEY-----\ntest-not-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n"
	body := map[string]any{
		"token":       tok.Token,
		"hostname":    "vps-eu-1",
		"os":          "linux",
		"arch":        "amd64",
		"tailnetAddr": "100.64.0.5",
		"sshPubkey":   "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBcfGTm0RvSEFTHvxlTAAAAAAAAAAAAAAAAAAAAAAAA synapse-deployer@vps-eu-1",
		"sshUser":     "synapse-deployer",
		"sshPrivkey":  privkeyPlaintext,
	}
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", body, http.StatusCreated, &reg)
	if reg.HostID != hostID {
		t.Fatalf("register returned host %s, want %s", reg.HostID, hostID)
	}

	var ciphertext []byte
	var fingerprint sql.NullString
	if err := h.DB.QueryRow(context.Background(),
		`SELECT ssh_privkey_encrypted, ssh_privkey_fingerprint FROM hosts WHERE id = $1`,
		hostID,
	).Scan(&ciphertext, &fingerprint); err != nil {
		t.Fatalf("load host: %v", err)
	}
	if len(ciphertext) == 0 {
		t.Fatal("ssh_privkey_encrypted is empty — register did not persist")
	}
	// Critical guard: stored bytes must NOT contain the plaintext PEM.
	if bytes.Contains(ciphertext, []byte("OPENSSH PRIVATE KEY")) ||
		bytes.Contains(ciphertext, []byte("test-not-a-real-key")) {
		t.Fatal("ciphertext contains plaintext PEM — encryption is broken")
	}
	// Round-trip: decrypt via the same SecretBox the harness wired.
	if h.Crypto == nil {
		t.Fatal("harness Crypto nil despite WithCrypto: true")
	}
	decrypted, err := h.Crypto.DecryptString(ciphertext)
	if err != nil {
		t.Fatalf("decrypt round-trip: %v", err)
	}
	if decrypted != privkeyPlaintext {
		t.Errorf("decrypted plaintext doesn't match input: got %q", decrypted)
	}
	// fingerprint shape: best-effort, may be NULL on malformed pubkey input.
	// The test pubkey above is synthetic — Phase 3B will use a real ed25519
	// keypair so the fingerprint reliably populates. Don't gate the test
	// on that downstream-of-encryption convenience field.
}

// TestAgent_Register_WithSSHPrivkey_NoCrypto_503 verifies the operator-
// facing error when SYNAPSE_STORAGE_KEY isn't set but a remote-host
// register includes a private key.
func TestAgent_Register_WithSSHPrivkey_NoCrypto_503(t *testing.T) {
	h := Setup(t) // no WithCrypto — h.Crypto == nil
	_, _, tok := mintHostToken(t, h, "vps-eu-1")

	body := map[string]any{
		"token":       tok.Token,
		"hostname":    "vps-eu-1",
		"tailnetAddr": "100.64.0.5",
		"sshPubkey":   "ssh-ed25519 AAAAtestpubkey synapse-deployer@vps-eu-1",
		"sshPrivkey":  "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n",
	}
	env := h.AssertStatus(http.MethodPost, "/v1/agents/register", "", body, http.StatusServiceUnavailable)
	if env.Code != "crypto_disabled" {
		t.Errorf("code: got %q, want crypto_disabled", env.Code)
	}
}

// TestInstallAgent_Config_RemoteProvisioningEnabled checks
// remoteProvisioningEnabled flips true ONLY when both Headscale + crypto
// are configured. install-agent.sh gates on this to refuse early
// instead of 503'ing inside register's encrypt step.
func TestInstallAgent_Config_RemoteProvisioningEnabled(t *testing.T) {
	cases := []struct {
		name             string
		headscale        bool
		crypto           bool
		wantProvisioning bool
	}{
		{"both", true, true, true},
		{"headscale_only", true, false, false},
		{"crypto_only", false, true, false},
		{"neither", false, false, false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			opts := SetupOpts{}
			if tc.headscale {
				opts.HeadscaleServerURL = "https://headscale.example.com"
			}
			if tc.crypto {
				opts.WithCrypto = true
			}
			h := SetupWithOpts(t, opts)
			var resp struct {
				HeadscaleServerURL        string `json:"headscaleServerUrl"`
				AgentDownloadURL          string `json:"agentDownloadUrl"`
				AgentVersion              string `json:"agentVersion"`
				RemoteHostsEnabled        bool   `json:"remoteHostsEnabled"`
				RemoteProvisioningEnabled bool   `json:"remoteProvisioningEnabled"`
			}
			h.DoJSON(http.MethodGet, "/v1/install_agent/config", "", nil, http.StatusOK, &resp)
			if resp.RemoteProvisioningEnabled != tc.wantProvisioning {
				t.Errorf("remoteProvisioningEnabled: got %v, want %v", resp.RemoteProvisioningEnabled, tc.wantProvisioning)
			}
			if resp.RemoteHostsEnabled != tc.headscale {
				t.Errorf("remoteHostsEnabled: got %v, want %v (Headscale-only signal)", resp.RemoteHostsEnabled, tc.headscale)
			}
		})
	}
}
