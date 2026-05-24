package synapsetest

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

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

	// Authenticated → empty desired state.
	var ds struct {
		Version   int   `json:"version"`
		Resources []any `json:"resources"`
	}
	h.DoJSON(http.MethodGet, "/v1/agents/desired_state", reg.AgentToken, nil, http.StatusOK, &ds)
	if ds.Version != 0 || len(ds.Resources) != 0 {
		t.Errorf("desired state = %+v, want empty", ds)
	}

	// Unauthenticated → 401.
	h.AssertStatus(http.MethodGet, "/v1/agents/desired_state", "", nil, http.StatusUnauthorized)
}
