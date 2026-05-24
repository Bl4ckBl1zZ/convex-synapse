package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/db"
	"github.com/Iann29/synapse/internal/models"
)

// HostsHandler exposes /v1/hosts — the Cell Control Plane's view of the
// machines (VPSs) deployments run on (feat/cell-control-plane).
//
// Hosts are instance-level infrastructure shared across teams, so every
// endpoint is gated to users.is_instance_admin — mirroring AdminHandler's
// gate (the canonical copy lives in admin.go::requireInstanceAdmin; this is a
// small self-contained duplicate so /v1/hosts stays a top-level resource
// rather than living under /v1/admin).
//
// Scope of this block: CRUD + drain + adoption-token. The agent-facing
// register / heartbeat / desired-state endpoints (consumed by the future Go
// synapse-agent) are intentionally NOT implemented yet — see the TODOs at the
// bottom of this file. The host_agents / host_adoption_tokens tables exist so
// the API is agent-ready.
type HostsHandler struct {
	DB *pgxpool.Pool
	// PublicURL is the control-plane origin baked into the agent join command
	// returned by createAdoptionToken. Empty → a "<your-synapse-url>"
	// placeholder is used. Wired from RouterDeps.PublicURL.
	PublicURL string
}

func (h *HostsHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Use(h.requireInstanceAdmin)
	r.Get("/", h.listHosts)
	r.Post("/", h.createHost)
	r.Route("/{hostID}", func(r chi.Router) {
		r.Get("/", h.getHost)
		r.Patch("/", h.updateHost)
		r.Post("/drain", h.drainHost)
		r.Post("/adoption_token", h.createAdoptionToken)
	})
	return r
}

// requireInstanceAdmin gates every /v1/hosts route. See
// admin.go::requireInstanceAdmin for the canonical narrative.
func (h *HostsHandler) requireInstanceAdmin(next http.Handler) http.Handler {
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
			logErr("hosts admin gate query", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to verify admin status")
			return
		}
		if !hasAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "Host endpoints require instance-admin role")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// hostColumns is the canonical SELECT list so list + get stay in sync.
const hostColumns = `id, name, provider, region, public_ip, private_ip, labels,
	status, agent_version, docker_version, cpu_cores, memory_mb, disk_gb,
	is_synapse_host, last_heartbeat_at, created_at, updated_at`

type scannable interface {
	Scan(dest ...any) error
}

func scanHost(s scannable) (models.Host, error) {
	var hst models.Host
	var publicIP, privateIP, agentVer, dockerVer *string
	var labelsRaw []byte
	if err := s.Scan(
		&hst.ID, &hst.Name, &hst.Provider, &hst.Region, &publicIP, &privateIP, &labelsRaw,
		&hst.Status, &agentVer, &dockerVer, &hst.CPUCores, &hst.MemoryMB, &hst.DiskGB,
		&hst.IsSynapseHost, &hst.LastHeartbeatAt, &hst.CreatedAt, &hst.UpdatedAt,
	); err != nil {
		return models.Host{}, err
	}
	hst.PublicIP = derefStr(publicIP)
	hst.PrivateIP = derefStr(privateIP)
	hst.AgentVersion = derefStr(agentVer)
	hst.DockerVersion = derefStr(dockerVer)
	hst.Labels = map[string]string{}
	if len(labelsRaw) > 0 {
		_ = json.Unmarshal(labelsRaw, &hst.Labels)
	}
	return hst, nil
}

// ---------- GET /v1/hosts ----------

type listHostsResp struct {
	Items []models.Host `json:"items"`
}

func (h *HostsHandler) listHosts(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(r.Context(), `SELECT `+hostColumns+` FROM hosts ORDER BY is_synapse_host DESC, created_at ASC`)
	if err != nil {
		logErr("list hosts", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list hosts")
		return
	}
	defer rows.Close()
	items := make([]models.Host, 0)
	for rows.Next() {
		hst, err := scanHost(rows)
		if err != nil {
			logErr("scan host", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to read hosts")
			return
		}
		items = append(items, hst)
	}
	if err := rows.Err(); err != nil {
		logErr("iterate hosts", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read hosts")
		return
	}
	writeJSON(w, http.StatusOK, listHostsResp{Items: items})
}

// ---------- POST /v1/hosts ----------

type createHostReq struct {
	Name      string            `json:"name"`
	Provider  string            `json:"provider,omitempty"`
	Region    string            `json:"region,omitempty"`
	PublicIP  string            `json:"publicIp,omitempty"`
	PrivateIP string            `json:"privateIp,omitempty"`
	Labels    map[string]string `json:"labels,omitempty"`
	CPUCores  *int              `json:"cpuCores,omitempty"`
	MemoryMB  *int64            `json:"memoryMb,omitempty"`
	DiskGB    *int64            `json:"diskGb,omitempty"`
}

func (h *HostsHandler) createHost(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	var req createHostReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "missing_name", "Host name is required")
		return
	}
	if len(req.Name) > 200 {
		writeError(w, http.StatusBadRequest, "invalid_name", "Host name is too long (max 200 chars)")
		return
	}
	provider := strings.TrimSpace(req.Provider)
	if provider == "" {
		provider = "unknown"
	}

	row := h.DB.QueryRow(r.Context(), `
		INSERT INTO hosts (name, provider, region, public_ip, private_ip, labels,
		                   status, cpu_cores, memory_mb, disk_gb)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING `+hostColumns,
		req.Name, provider, strings.TrimSpace(req.Region),
		nullStr(req.PublicIP), nullStr(req.PrivateIP), marshalLabels(req.Labels),
		models.HostStatusUnknown, req.CPUCores, req.MemoryMB, req.DiskGB,
	)
	hst, err := scanHost(row)
	if err != nil {
		if db.IsUniqueViolation(err) {
			writeError(w, http.StatusConflict, "host_name_taken", "A host with this name already exists")
			return
		}
		logErr("insert host", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to create host")
		return
	}

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionCreateHost,
		TargetType: audit.TargetHost,
		TargetID:   hst.ID,
		Metadata:   map[string]any{"name": hst.Name, "provider": hst.Provider, "region": hst.Region},
	})
	writeJSON(w, http.StatusCreated, hst)
}

// ---------- GET /v1/hosts/{hostID} ----------

func (h *HostsHandler) getHost(w http.ResponseWriter, r *http.Request) {
	hst, ok := h.loadHost(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, hst)
}

// ---------- PATCH /v1/hosts/{hostID} ----------

type updateHostReq struct {
	Name      *string            `json:"name,omitempty"`
	Provider  *string            `json:"provider,omitempty"`
	Region    *string            `json:"region,omitempty"`
	PublicIP  *string            `json:"publicIp,omitempty"`
	PrivateIP *string            `json:"privateIp,omitempty"`
	Status    *string            `json:"status,omitempty"`
	Labels    *map[string]string `json:"labels,omitempty"`
}

func (h *HostsHandler) updateHost(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	hst, ok := h.loadHost(w, r)
	if !ok {
		return
	}
	var req updateHostReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 200 {
			writeError(w, http.StatusBadRequest, "invalid_name", "Host name must be 1-200 chars")
			return
		}
		hst.Name = name
	}
	if req.Provider != nil {
		hst.Provider = strings.TrimSpace(*req.Provider)
	}
	if req.Region != nil {
		hst.Region = strings.TrimSpace(*req.Region)
	}
	if req.PublicIP != nil {
		hst.PublicIP = strings.TrimSpace(*req.PublicIP)
	}
	if req.PrivateIP != nil {
		hst.PrivateIP = strings.TrimSpace(*req.PrivateIP)
	}
	if req.Status != nil {
		if !validHostStatus(*req.Status) {
			writeError(w, http.StatusBadRequest, "invalid_status", "status must be one of: online, offline, draining, unknown")
			return
		}
		hst.Status = *req.Status
	}
	if req.Labels != nil {
		hst.Labels = *req.Labels
	}

	row := h.DB.QueryRow(r.Context(), `
		UPDATE hosts
		   SET name = $2, provider = $3, region = $4, public_ip = $5,
		       private_ip = $6, status = $7, labels = $8, updated_at = now()
		 WHERE id = $1
		RETURNING `+hostColumns,
		hst.ID, hst.Name, hst.Provider, hst.Region, nullStr(hst.PublicIP),
		nullStr(hst.PrivateIP), hst.Status, marshalLabels(hst.Labels),
	)
	updated, err := scanHost(row)
	if err != nil {
		if db.IsUniqueViolation(err) {
			writeError(w, http.StatusConflict, "host_name_taken", "A host with this name already exists")
			return
		}
		logErr("update host", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to update host")
		return
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionUpdateHost,
		TargetType: audit.TargetHost,
		TargetID:   updated.ID,
	})
	writeJSON(w, http.StatusOK, updated)
}

// ---------- POST /v1/hosts/{hostID}/drain ----------

func (h *HostsHandler) drainHost(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	hst, ok := h.loadHost(w, r)
	if !ok {
		return
	}
	row := h.DB.QueryRow(r.Context(), `
		UPDATE hosts SET status = $2, updated_at = now() WHERE id = $1
		RETURNING `+hostColumns,
		hst.ID, models.HostStatusDraining,
	)
	updated, err := scanHost(row)
	if err != nil {
		logErr("drain host", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to drain host")
		return
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionDrainHost,
		TargetType: audit.TargetHost,
		TargetID:   updated.ID,
	})
	writeJSON(w, http.StatusOK, updated)
}

// ---------- POST /v1/hosts/{hostID}/adoption_token ----------

type createAdoptionTokenReq struct {
	Name string `json:"name,omitempty"`
	// TTLSeconds defaults to 3600 (1h) and is capped at 7 days. Adoption
	// tokens are meant to be short-lived join credentials.
	TTLSeconds int `json:"ttlSeconds,omitempty"`
}

type adoptionTokenResp struct {
	// Token is the plaintext join secret. Returned ONCE at creation; only the
	// sha256 is stored. Treat like a password.
	Token       string     `json:"token"`
	ID          string     `json:"id"`
	HostID      string     `json:"hostId"`
	Name        string     `json:"name,omitempty"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	JoinCommand string     `json:"joinCommand"`
}

func (h *HostsHandler) createAdoptionToken(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	hst, ok := h.loadHost(w, r)
	if !ok {
		return
	}
	var req createAdoptionTokenReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	ttl := req.TTLSeconds
	if ttl <= 0 {
		ttl = 3600
	}
	if maxTTL := 7 * 24 * 3600; ttl > maxTTL {
		ttl = maxTTL
	}
	expires := time.Now().Add(time.Duration(ttl) * time.Second)

	plain, hash, err := auth.GenerateToken()
	if err != nil {
		logErr("generate adoption token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to generate token")
		return
	}

	var resp adoptionTokenResp
	var uidPtr *string
	if uid != "" {
		uidPtr = &uid
	}
	err = h.DB.QueryRow(r.Context(), `
		INSERT INTO host_adoption_tokens (host_id, token_hash, name, expires_at, created_by_user_id)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, expires_at
	`, hst.ID, hash, strings.TrimSpace(req.Name), expires, uidPtr).Scan(&resp.ID, &resp.ExpiresAt)
	if err != nil {
		logErr("insert adoption token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to create adoption token")
		return
	}
	resp.Token = plain
	resp.HostID = hst.ID
	resp.Name = strings.TrimSpace(req.Name)
	controlURL := h.PublicURL
	if controlURL == "" {
		controlURL = "<your-synapse-url>"
	}
	resp.JoinCommand = "synapse-agent join --control-url " + controlURL + " --token " + plain

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionCreateHostAdoptionToken,
		TargetType: audit.TargetHost,
		TargetID:   hst.ID,
		Metadata:   map[string]any{"tokenId": resp.ID},
	})
	writeJSON(w, http.StatusCreated, resp)
}

// ---------- helpers ----------

func (h *HostsHandler) loadHost(w http.ResponseWriter, r *http.Request) (models.Host, bool) {
	id := chi.URLParam(r, "hostID")
	row := h.DB.QueryRow(r.Context(), `SELECT `+hostColumns+` FROM hosts WHERE id::text = $1`, id)
	hst, err := scanHost(row)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "host_not_found", "Host not found")
		return models.Host{}, false
	}
	if err != nil {
		logErr("load host", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load host")
		return models.Host{}, false
	}
	return hst, true
}

func validHostStatus(s string) bool {
	switch s {
	case models.HostStatusOnline, models.HostStatusOffline, models.HostStatusDraining, models.HostStatusUnknown:
		return true
	}
	return false
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// marshalLabels turns the label map into a jsonb-ready []byte, never nil
// (so the NOT NULL DEFAULT '{}' column always gets a valid object).
func marshalLabels(labels map[string]string) []byte {
	if len(labels) == 0 {
		return []byte("{}")
	}
	raw, err := json.Marshal(labels)
	if err != nil {
		return []byte("{}")
	}
	return raw
}

// TODO(Bloco 6 — synapse-agent, Go @ synapse/cmd/synapse-agent):
//   - POST /v1/agent/register     — agent presents an adoption token, we
//     create/attach the host_agents row + mint a long-lived agent token,
//     mark the adoption token used_at.
//   - POST /v1/agent/heartbeat    — agent token auth; updates hosts.status,
//     agent_version, docker_version, cpu/mem/disk, last_heartbeat_at, and
//     host_agents.last_seen_at + last_heartbeat_payload.
//   - GET  /v1/agent/desired_state — returns the desired_states rows for the
//     agent's host (desired_states table arrives in a later block).
// These are deliberately out of scope for this block; the tables + the
// operator-facing adoption-token mint above are ready for them.
