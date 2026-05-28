package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/models"
)

// AgentsHandler powers the synapse-agent's contact points (feat/cell-control-
// plane, Bloco 6). These routes are PUBLIC (mounted outside the JWT-
// authenticated group): register authenticates with a single-use adoption
// token in the body; heartbeat + desired_state authenticate with the agent
// token as a bearer (looked up in host_agents, never access_tokens — an agent
// token can't impersonate a user).
//
// Observe-only contract: nothing here issues commands to an agent. desired_state
// returns an empty resource set; the reconcile loop is a later block.
type AgentsHandler struct {
	DB *pgxpool.Pool
	// PublicURL is echoed back in the register response's config.controlUrl
	// as the canonical control-plane origin. Empty → the agent keeps the
	// --control-url it was invoked with.
	PublicURL string
	// Bloco 9 flags. EnableObservedState gates writing observed_states from
	// heartbeats; EnableDesiredState gates serving desired state to the agent.
	// applyAllowed is ALWAYS false in this block regardless of these.
	EnableObservedState bool
	EnableDesiredState  bool
}

func (h *AgentsHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Post("/register", h.register)
	r.Post("/heartbeat", h.heartbeat)
	r.Get("/desired_state", h.desiredState)
	return r
}

// ---------- POST /v1/agents/register ----------

type agentRegisterReq struct {
	Token         string `json:"token"`
	Hostname      string `json:"hostname,omitempty"`
	OS            string `json:"os,omitempty"`
	Arch          string `json:"arch,omitempty"`
	AgentVersion  string `json:"agentVersion,omitempty"`
	DockerVersion string `json:"dockerVersion,omitempty"`
	CPUCores      *int   `json:"cpuCores,omitempty"`
	MemoryMb      *int64 `json:"memoryMb,omitempty"`
	DiskGb        *int64 `json:"diskGb,omitempty"`

	// v1.18+ Remote Hosts: install-agent.sh sends these AFTER joining
	// the Headscale tailnet + generating the SSH keypair. Pre-v1.18
	// agents omit them — fields stay empty and the host stays
	// is_remote=false (treated as a local-or-legacy observer).
	TailnetAddr string `json:"tailnetAddr,omitempty"`
	SSHPubkey   string `json:"sshPubkey,omitempty"`
	SSHUser     string `json:"sshUser,omitempty"` // default "synapse-deployer"
	SSHPort     *int   `json:"sshPort,omitempty"` // default 22
}

type agentConfigResp struct {
	ControlURL               string `json:"controlUrl,omitempty"`
	HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
	Mode                     string `json:"mode"`
}

type agentRegisterResp struct {
	HostID string `json:"hostId"`
	// AgentToken is the long-lived bearer the agent presents on heartbeat /
	// desired_state. Returned ONCE here; only its sha256 is stored.
	AgentID    string          `json:"agentId"`
	AgentToken string          `json:"agentToken"`
	Config     agentConfigResp `json:"config"`
}

const agentHeartbeatIntervalSeconds = 15

func (h *AgentsHandler) register(w http.ResponseWriter, r *http.Request) {
	var req agentRegisterReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(req.Token) == "" {
		writeError(w, http.StatusBadRequest, "missing_token", "Adoption token is required")
		return
	}
	tokenHash := auth.HashToken(strings.TrimSpace(req.Token))

	plain, agentHash, err := auth.GenerateTokenWithPrefix(auth.AgentTokenPrefix)
	if err != nil {
		logErr("generate agent token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to mint agent token")
		return
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		logErr("agent register begin", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to register agent")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Atomically claim the adoption token: only one caller can flip used_at
	// from NULL, and the WHERE clause rejects expired/used/revoked in the
	// same statement — no check-then-act race.
	var tokenHostID *string
	err = tx.QueryRow(r.Context(), `
		UPDATE host_adoption_tokens
		   SET used_at = now()
		 WHERE token_hash = $1
		   AND used_at IS NULL
		   AND revoked_at IS NULL
		   AND (expires_at IS NULL OR expires_at > now())
		RETURNING host_id
	`, tokenHash).Scan(&tokenHostID)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(r.Context())
		h.denyAdoptionToken(w, r.Context(), tokenHash)
		return
	}
	if err != nil {
		logErr("claim adoption token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to register agent")
		return
	}

	// Resolve the host the token was minted for. Unbound tokens (host_id
	// NULL) create a host from the reported hostname so `join` works even
	// for a token minted before the host row existed.
	hostID, err := h.resolveOrCreateHost(r.Context(), tx, tokenHostID, req)
	if err != nil {
		logErr("resolve host for agent", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to register agent")
		return
	}

	var agentID string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO host_agents (host_id, name, token_hash, status, connection_mode, last_seen_at)
		VALUES ($1, $2, $3, 'online', 'polling', now())
		RETURNING id
	`, hostID, agentName(req.Hostname), agentHash).Scan(&agentID)
	if err != nil {
		logErr("insert host_agent", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to register agent")
		return
	}

	if err := applyHostFacts(r.Context(), tx, hostID, req.AgentVersion, req.DockerVersion, req.CPUCores, req.MemoryMb, req.DiskGb); err != nil {
		logErr("apply host facts on register", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to register agent")
		return
	}

	// v1.18+ Remote Hosts: if the agent sent tailnet + SSH info, persist
	// it on the host row + flip is_remote=true. Backwards-compatible:
	// pre-v1.18 agents omit these fields and the host stays
	// is_remote=false (local-or-legacy observer mode). NULLIF preserves
	// the partial-update contract — an agent that sends one of the two
	// addressing fields but not the other doesn't wipe the persisted
	// value with an empty string.
	if strings.TrimSpace(req.TailnetAddr) != "" || strings.TrimSpace(req.SSHPubkey) != "" {
		sshUser := strings.TrimSpace(req.SSHUser)
		if sshUser == "" {
			sshUser = "synapse-deployer"
		}
		sshPort := 22
		if req.SSHPort != nil && *req.SSHPort > 0 {
			sshPort = *req.SSHPort
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE hosts
			   SET tailnet_addr = NULLIF($2, ''),
			       ssh_pubkey   = NULLIF($3, ''),
			       ssh_user     = $4,
			       ssh_port     = $5,
			       is_remote    = TRUE
			 WHERE id = $1
		`, hostID, strings.TrimSpace(req.TailnetAddr), strings.TrimSpace(req.SSHPubkey), sshUser, sshPort); err != nil {
			logErr("apply remote host fields on register", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to register agent")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		logErr("agent register commit", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to register agent")
		return
	}

	writeJSON(w, http.StatusCreated, agentRegisterResp{
		HostID:     hostID,
		AgentID:    agentID,
		AgentToken: plain,
		Config: agentConfigResp{
			ControlURL:               h.PublicURL,
			HeartbeatIntervalSeconds: agentHeartbeatIntervalSeconds,
			Mode:                     "observe-only",
		},
	})
}

// denyAdoptionToken inspects why the claim failed (best-effort, read-only)
// so the agent gets a clear reason instead of a generic 401. The diagnostic
// runs after the claiming tx rolled back; a token claimed in between only
// changes the message, never the security outcome.
func (h *AgentsHandler) denyAdoptionToken(w http.ResponseWriter, ctx context.Context, tokenHash string) {
	var usedAt, revokedAt, expiresAt *time.Time
	err := h.DB.QueryRow(ctx, `
		SELECT used_at, revoked_at, expires_at FROM host_adoption_tokens WHERE token_hash = $1
	`, tokenHash).Scan(&usedAt, &revokedAt, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusUnauthorized, "invalid_adoption_token", "Adoption token is not valid")
		return
	}
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_adoption_token", "Adoption token is not valid")
		return
	}
	switch {
	case revokedAt != nil:
		writeError(w, http.StatusUnauthorized, "adoption_token_revoked", "This adoption token has been revoked")
	case usedAt != nil:
		writeError(w, http.StatusUnauthorized, "adoption_token_used", "This adoption token has already been used")
	case expiresAt != nil && !expiresAt.After(time.Now()):
		writeError(w, http.StatusUnauthorized, "adoption_token_expired", "This adoption token has expired")
	default:
		writeError(w, http.StatusUnauthorized, "invalid_adoption_token", "Adoption token is not valid")
	}
}

// resolveOrCreateHost returns the bound host id, or creates a host from the
// agent's reported hostname when the token was unbound.
func (h *AgentsHandler) resolveOrCreateHost(ctx context.Context, tx pgx.Tx, tokenHostID *string, req agentRegisterReq) (string, error) {
	if tokenHostID != nil {
		return *tokenHostID, nil
	}
	name := strings.TrimSpace(req.Hostname)
	if name == "" {
		name = "agent-host"
	}
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO hosts (name, provider, status)
		VALUES ($1, 'unknown', 'online')
		RETURNING id
	`, name).Scan(&id)
	return id, err
}

func agentName(hostname string) string {
	hostname = strings.TrimSpace(hostname)
	if hostname == "" {
		return "synapse-agent"
	}
	return hostname
}

// ---------- POST /v1/agents/heartbeat ----------

type agentHeartbeatReq struct {
	// hostId/agentId are accepted (the agent sends them) but the authoritative
	// ids come from the bearer token — an agent can only update its OWN host.
	HostID        string          `json:"hostId,omitempty"`
	AgentID       string          `json:"agentId,omitempty"`
	Hostname      string          `json:"hostname,omitempty"`
	OS            string          `json:"os,omitempty"`
	Arch          string          `json:"arch,omitempty"`
	AgentVersion  string          `json:"agentVersion,omitempty"`
	DockerVersion string          `json:"dockerVersion,omitempty"`
	CPUCores      *int            `json:"cpuCores,omitempty"`
	MemoryMb      *int64          `json:"memoryMb,omitempty"`
	DiskGb        *int64          `json:"diskGb,omitempty"`
	Observed      json.RawMessage `json:"observed,omitempty"`
}

func (h *AgentsHandler) heartbeat(w http.ResponseWriter, r *http.Request) {
	agentID, hostID, ok := h.authenticateAgent(w, r)
	if !ok {
		return
	}
	var req agentHeartbeatReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	var observed []byte
	if len(req.Observed) > 0 {
		observed = []byte(req.Observed)
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		logErr("agent heartbeat begin", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to record heartbeat")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if _, err := tx.Exec(r.Context(), `
		UPDATE host_agents
		   SET last_seen_at = now(), status = 'online',
		       last_heartbeat_payload = $2, updated_at = now()
		 WHERE id = $1
	`, agentID, observed); err != nil {
		logErr("update host_agent heartbeat", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to record heartbeat")
		return
	}

	// host facts come from the heartbeat body; the host id comes from the
	// token, never the body (tenant/host isolation).
	if err := applyHostFacts(r.Context(), tx, hostID, req.AgentVersion, req.DockerVersion, req.CPUCores, req.MemoryMb, req.DiskGb); err != nil {
		logErr("apply host facts on heartbeat", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to record heartbeat")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		logErr("agent heartbeat commit", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to record heartbeat")
		return
	}

	// Record observed_states (Bloco 9). Best-effort + AFTER commit so a bad
	// observed payload never blocks host liveness. Writes only safe metadata.
	if h.EnableObservedState {
		if err := recordObservedStates(r.Context(), h.DB, hostID, &agentID, req); err != nil {
			logErr("record observed states", err)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"hostId": hostID,
	})
}

// ---------- GET /v1/agents/desired_state ----------

func (h *AgentsHandler) desiredState(w http.ResponseWriter, r *http.Request) {
	_, hostID, ok := h.authenticateAgent(w, r)
	if !ok {
		return
	}
	resources := []map[string]any{}
	if h.EnableDesiredState {
		states, err := loadActiveDesiredByHost(r.Context(), h.DB, hostID)
		if err != nil {
			logErr("agent desired_state load", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to load desired state")
			return
		}
		for _, d := range states {
			resources = append(resources, map[string]any{
				"desiredStateId": d.ID,
				"resourceType":   d.ResourceType,
				"resourceKey":    d.ResourceKey,
				"version":        d.Version,
				"desiredHash":    d.DesiredHash,
				"desired":        d.DesiredJSON,
			})
		}
	}
	// applyAllowed is ALWAYS false in Bloco 9 — the agent stays observe-only.
	// `version` is the count of resources (a cheap change-signal for the agent
	// to log "received N desired resources").
	writeJSON(w, http.StatusOK, map[string]any{
		"version":      len(resources),
		"mode":         "observe-only",
		"applyAllowed": false,
		"resources":    resources,
	})
}

// ---------- helpers ----------

// authenticateAgent resolves the agent token bearer to (agentID, hostID).
// Writes 401 + returns ok=false on any failure. Agent tokens live in
// host_agents (not access_tokens) and a revoked agent is rejected.
func (h *AgentsHandler) authenticateAgent(w http.ResponseWriter, r *http.Request) (agentID, hostID string, ok bool) {
	tok := agentBearer(r)
	if tok == "" {
		writeError(w, http.StatusUnauthorized, "missing_authorization", "Agent bearer token required")
		return "", "", false
	}
	hash := auth.HashToken(tok)
	err := h.DB.QueryRow(r.Context(), `
		SELECT id, host_id FROM host_agents
		 WHERE token_hash = $1 AND status <> 'revoked'
	`, hash).Scan(&agentID, &hostID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusUnauthorized, "invalid_agent_token", "Agent token is not valid")
		return "", "", false
	}
	if err != nil {
		logErr("agent token lookup", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to authenticate agent")
		return "", "", false
	}
	return agentID, hostID, true
}

func agentBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(h[len("Bearer "):])
}

// applyHostFacts updates the hosts row with the agent-reported facts +
// liveness. Only overwrites a fact when the agent actually reported it
// (COALESCE-style via NULLIF), so a heartbeat that omits a field doesn't wipe
// a previously-known value. Always bumps status=online + last_heartbeat_at.
func applyHostFacts(ctx context.Context, tx pgx.Tx, hostID, agentVersion, dockerVersion string, cpu *int, memMb, diskGb *int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE hosts
		   SET status = $2,
		       agent_version  = COALESCE(NULLIF($3, ''), agent_version),
		       docker_version = COALESCE(NULLIF($4, ''), docker_version),
		       cpu_cores = COALESCE($5, cpu_cores),
		       memory_mb = COALESCE($6, memory_mb),
		       disk_gb   = COALESCE($7, disk_gb),
		       last_heartbeat_at = now(),
		       updated_at = now()
		 WHERE id = $1
	`, hostID, models.HostStatusOnline, agentVersion, dockerVersion, cpu, memMb, diskGb)
	return err
}
