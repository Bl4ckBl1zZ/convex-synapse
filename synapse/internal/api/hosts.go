package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/db"
	"github.com/Iann29/synapse/internal/headscale"
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
// register / heartbeat / desired-state endpoints (consumed by the Go
// synapse-agent) live in agents.go (/v1/agents/{register,heartbeat,
// desired_state}); the host_agents / host_adoption_tokens tables back them.
type HostsHandler struct {
	DB *pgxpool.Pool
	// PublicURL is the control-plane origin baked into the agent join command
	// returned by createAdoptionToken. Empty → a "<your-synapse-url>"
	// placeholder is used. Wired from RouterDeps.PublicURL.
	PublicURL string
	// StaleAfter / OfflineAfter drive the computed effectiveStatus
	// (feat/cell-control-plane, Bloco 6.5). A host whose last heartbeat is
	// older than StaleAfter reads "stale"; older than OfflineAfter reads
	// "offline". Zero values fall back to 60s / 300s so tests (which don't
	// wire them) and unconfigured installs behave sensibly.
	StaleAfter   time.Duration
	OfflineAfter time.Duration
	// Bloco 9b — host-scoped drift recompute / latest / reconcile dry-run.
	// Mounted inside Routes() so they inherit the instance-admin gate.
	Drift *DriftHandler
	// Headscale + HeadscaleServerURL (v1.18+ Remote Hosts) drive the
	// /remote_setup bundle endpoint. Both nil/empty when the operator
	// didn't run setup.sh --enable-headscale on the control plane —
	// the handler 503s with remote_hosts_disabled in that case so the
	// dashboard renders a friendly hint instead of a generic failure.
	Headscale          *headscale.Client
	HeadscaleServerURL string
	// RemoteTeardown dispatches the box-side agent wipe over SSH when a
	// remote host is deleted (gap 4). nil = Remote Hosts SSH disabled (no
	// crypto / ssh client) → deleteHost records sshTeardown=skipped.
	// Production wiring (cmd/server) closes over the sshprov.Client + key
	// decrypt, mirroring DeploymentsHandler.RemoteDocker; tests inject a
	// recording fake. It returns a CLASSIFIED result so this handler stays
	// transport-agnostic — an exit-99 from a host whose wrapper predates
	// the teardown sentinel surfaces as "unsupported", not a hard failure.
	RemoteTeardown func(ctx context.Context, t RemoteTarget) (HostTeardownResult, error)
	// RemoteOpTimeout bounds a single remote teardown dispatch. Zero =
	// remoteOpTimeout default. Mirrors DeploymentsHandler.RemoteOpTimeout.
	RemoteOpTimeout time.Duration
}

// HostTeardownResult is the classified outcome of a best-effort remote
// agent teardown dispatched when a host is deleted. Status is one of
// "ok" | "unsupported" | "failed"; Detail is a human hint (empty on ok).
type HostTeardownResult struct {
	Status string
	Detail string
}

// remoteTimeout is the deadline for a single remote teardown dispatch.
func (h *HostsHandler) remoteTimeout() time.Duration {
	if h.RemoteOpTimeout > 0 {
		return h.RemoteOpTimeout
	}
	return remoteOpTimeout
}

// deregisterHeadscaleNode best-effort removes the host's node from the
// Headscale tailnet. The hosts row doesn't store the Headscale-assigned
// node id, so we match on the tailnet IP. Returns a status for the
// deleteHost cleanup summary ("ok" | "not_found" | "failed" | "skipped");
// never propagates an error — Headscale being down must not strand the row.
func (h *HostsHandler) deregisterHeadscaleNode(ctx context.Context, tailnetAddr string) string {
	if h.Headscale == nil || tailnetAddr == "" {
		return "skipped"
	}
	// List ALL nodes (empty user) and match by tailnet IP, rather than
	// filtering by the "synapse" user namespace: resolving that user by name
	// can fail ("user not found") on some Headscale versions even though the
	// node exists, which would strand the tailnet node. Matching by IP is
	// both robust and sufficient (tailnet IPs are unique).
	nodes, err := h.Headscale.ListNodes(ctx, "")
	if err != nil {
		logErr("headscale list nodes", err)
		return "failed"
	}
	for _, n := range nodes {
		for _, ip := range n.IPAddresses {
			if ip == tailnetAddr {
				if err := h.Headscale.DeleteNode(ctx, n.ID); err != nil {
					logErr("headscale delete node", err)
					return "failed"
				}
				return "ok"
			}
		}
	}
	return "not_found"
}

func (h *HostsHandler) staleAfter() time.Duration {
	if h.StaleAfter > 0 {
		return h.StaleAfter
	}
	return 60 * time.Second
}

func (h *HostsHandler) offlineAfter() time.Duration {
	if h.OfflineAfter > 0 {
		return h.OfflineAfter
	}
	return 300 * time.Second
}

// effectiveHostStatus is the honest, computed liveness of a host — distinct
// from the stored hosts.status (which is just the last heartbeat's signal).
//   - operator intent wins: a drained host always reads "draining".
//   - no heartbeat yet: the control-plane self-host is "online" (Synapse is
//     demonstrably up); any other host keeps its stored status (e.g. a
//     manually-created host stays "unknown" until an agent reports).
//   - otherwise: online ≤ staleAfter < stale ≤ offlineAfter < offline.
func effectiveHostStatus(hst models.Host, staleAfter, offlineAfter time.Duration, now time.Time) string {
	if hst.Status == models.HostStatusDraining {
		return models.HostStatusDraining
	}
	// The synapse self-host runs the control plane that is answering THIS
	// request, so it is alive by definition — a stale/absent agent heartbeat
	// must NOT mark the box that's serving the panel as offline. (This is
	// liveness only; drift trust is computed separately in drift.go and still
	// requires a real, fresh container scan, so this never causes false drift.)
	if hst.IsSynapseHost {
		return models.HostStatusOnline
	}
	if hst.LastHeartbeatAt == nil {
		return hst.Status
	}
	age := now.Sub(*hst.LastHeartbeatAt)
	switch {
	case age <= staleAfter:
		return models.HostStatusOnline
	case age <= offlineAfter:
		return models.HostStatusStale
	default:
		return models.HostStatusOffline
	}
}

// writeHost stamps the computed effectiveStatus and writes the host. Every
// host response goes through here so the field is always present + honest.
func (h *HostsHandler) writeHost(w http.ResponseWriter, status int, hst models.Host) {
	hst.EffectiveStatus = effectiveHostStatus(hst, h.staleAfter(), h.offlineAfter(), time.Now())
	writeJSON(w, status, hst)
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
		// POST /delete (not DELETE) matches the verb convention of the other
		// host mutations (drain / remote_setup) and stays curl/CLI-friendly.
		// Removal is registry-only — see deleteHost.
		r.Post("/delete", h.deleteHost)
		r.Post("/adoption_token", h.createAdoptionToken)
		// v1.18+ Remote Hosts: one-click bundle that mints a Synapse
		// adoption token AND a Headscale pre-auth key in a single call,
		// returning a copy-pasteable install-agent.sh one-liner. Lives in
		// remote_setup.go; gated by the same requireInstanceAdmin
		// middleware on this router. 503s when Headscale isn't wired.
		r.Post("/remote_setup", h.createRemoteSetup)
		r.Get("/agents", h.listHostAgents)
		// Bloco 9: host-scoped desired / observed state (instance-admin).
		r.Get("/desired_state", h.getHostDesiredState)
		r.Get("/observed_state", h.getHostObservedState)
		// Bloco 9b: host-scoped drift + reconcile dry-run (instance-admin via
		// the requireInstanceAdmin middleware on this router).
		if h.Drift != nil {
			r.Get("/drift/latest", h.Drift.latestHost)
			r.Post("/drift/recompute", h.Drift.recomputeHost)
			r.Post("/reconcile/dry_run", h.Drift.dryRunHost)
			r.Post("/reconcile/apply", h.Drift.applyHost)
		}
	})
	return r
}

// ---------- GET /v1/hosts/{hostID}/desired_state | observed_state ----------

func (h *HostsHandler) getHostDesiredState(w http.ResponseWriter, r *http.Request) {
	hst, ok := h.loadHost(w, r)
	if !ok {
		return
	}
	items, err := loadActiveDesiredByHost(r.Context(), h.DB, hst.ID)
	if err != nil {
		logErr("host desired state", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load desired state")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *HostsHandler) getHostObservedState(w http.ResponseWriter, r *http.Request) {
	hst, ok := h.loadHost(w, r)
	if !ok {
		return
	}
	items, err := loadObservedByHost(r.Context(), h.DB, hst.ID)
	if err != nil {
		logErr("host observed state", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load observed state")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// AgentAdminRoutes mounts the instance-admin agent-lifecycle endpoints at
// /v1/host_agents (feat/cell-control-plane, Bloco 6.5). Separate from Routes()
// because the path prefix differs; reuses the same instance-admin gate.
func (h *HostsHandler) AgentAdminRoutes() chi.Router {
	r := chi.NewRouter()
	r.Use(h.requireInstanceAdmin)
	r.Post("/{agentID}/revoke", h.revokeAgent)
	r.Post("/{agentID}/rotate_token", h.rotateAgentToken)
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
	is_synapse_host, is_remote, last_heartbeat_at, created_at, updated_at`

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
		&hst.IsSynapseHost, &hst.IsRemote, &hst.LastHeartbeatAt, &hst.CreatedAt, &hst.UpdatedAt,
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
	now := time.Now()
	staleAfter, offlineAfter := h.staleAfter(), h.offlineAfter()
	items := make([]models.Host, 0)
	for rows.Next() {
		hst, err := scanHost(rows)
		if err != nil {
			logErr("scan host", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to read hosts")
			return
		}
		hst.EffectiveStatus = effectiveHostStatus(hst, staleAfter, offlineAfter, now)
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
	h.writeHost(w, http.StatusCreated, hst)
}

// ---------- GET /v1/hosts/{hostID} ----------

func (h *HostsHandler) getHost(w http.ResponseWriter, r *http.Request) {
	hst, ok := h.loadHost(w, r)
	if !ok {
		return
	}
	h.writeHost(w, http.StatusOK, hst)
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
	h.writeHost(w, http.StatusOK, updated)
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
	h.writeHost(w, http.StatusOK, updated)
}

// ---------- POST /v1/hosts/{hostID}/delete ----------

// deleteHost removes a host from the control-plane registry. It is the
// terminal step of the host lifecycle that until now stopped at drain.
//
// Removal is REGISTRY-ONLY and deliberately narrow:
//   - The self-host (is_synapse_host) is never removable — it is the box the
//     control plane runs on and every legacy deployment is backfilled onto it.
//   - A host that still has live deployments is refused (409); the operator
//     must delete or move them first. We never cascade-destroy running Convex
//     backends from a host-delete call.
//   - A host with in-flight provisioning work is refused (409) so a worker
//     can't claim a deployment out from under the delete.
//
// What it does NOT do (honest scope): it does not deregister the host's
// Headscale tailnet node, and it does not SSH in to uninstall the agent /
// systemd unit / system users / SSH keys on a remote VPS. Those linger and
// must be cleaned manually — see docs/REMOTE_HOSTS.md. The lingering agent is
// harmless: once its host_agents row is gone (cascade) its heartbeats 401.
//
// FK behaviour on the surviving tables (see migrations): host_agents,
// host_adoption_tokens, desired_states, observed_states, drift_reports
// CASCADE away; cells.primary_host_id, deployment_placements.host_id,
// operation_runs.host_id, drift_items.host_id are SET NULL. Only
// deployments.host_id is ON DELETE RESTRICT (NOT NULL) — that is the FK that
// forces the zero-live-deployments precondition. Soft-deleted deployments
// (status='deleted') keep their host_id, so we reassign those history rows to
// the self-host inside the delete txn to satisfy RESTRICT without losing audit
// history.
func (h *HostsHandler) deleteHost(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	hst, ok := h.loadHost(w, r)
	if !ok {
		return
	}

	// Guard 1: never remove the box the control plane runs on.
	if hst.IsSynapseHost {
		writeError(w, http.StatusConflict, "cannot_remove_self_host",
			"The Synapse control-plane host cannot be removed")
		return
	}

	// Guard 2: refuse while live (non-deleted) deployments reference the host.
	// status='deleted' rows are excluded — they are history, handled in the txn.
	var liveCount int
	if err := h.DB.QueryRow(r.Context(), `
		SELECT count(*) FROM deployments WHERE host_id = $1 AND status <> 'deleted'
	`, hst.ID).Scan(&liveCount); err != nil {
		logErr("count host deployments", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to remove host")
		return
	}
	if liveCount > 0 {
		msg := "Host still has " + strconv.Itoa(liveCount) + " deployment(s)"
		if names := h.sampleDeploymentNames(r, hst.ID); len(names) > 0 {
			msg += " (e.g. " + strings.Join(names, ", ") + ")"
		}
		msg += ". Delete or move them before removing the host."
		writeError(w, http.StatusConflict, "host_has_deployments", msg)
		return
	}

	// Guard 3: refuse while a provisioning job is in flight for any of the
	// host's deployments. provisioning_jobs has no host_id; reach it via the
	// deployment join. 'pending'/'claimed' are the active states.
	var activeJobs int
	if err := h.DB.QueryRow(r.Context(), `
		SELECT count(*)
		  FROM provisioning_jobs j
		  JOIN deployments d ON d.id = j.deployment_id
		 WHERE d.host_id = $1 AND j.status IN ('pending', 'claimed')
	`, hst.ID).Scan(&activeJobs); err != nil {
		logErr("count host provisioning jobs", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to remove host")
		return
	}
	if activeJobs > 0 {
		writeError(w, http.StatusConflict, "host_has_pending_jobs",
			"Host has provisioning work in flight. Wait for it to finish before removing the host.")
		return
	}

	// Best-effort remote decommission (gap 4). For a remote host, wipe the
	// box BEFORE we drop the registry row — we still need its SSH
	// coordinates + tailnet addr here. Neither step blocks the delete: an
	// unreachable VPS or a Headscale hiccup must never strand the row.
	// ?skip_teardown=true is the escape hatch (pure registry delete), e.g.
	// when the operator plans to re-adopt the same box.
	cleanup := map[string]string{}
	if hst.IsRemote && r.URL.Query().Get("skip_teardown") != "true" {
		var (
			tailnetAddr string
			sshUser     string
			sshPort     int
		)
		if err := h.DB.QueryRow(r.Context(),
			`SELECT COALESCE(tailnet_addr, ''), COALESCE(ssh_user, ''), COALESCE(ssh_port, 22)
			   FROM hosts WHERE id = $1`, hst.ID,
		).Scan(&tailnetAddr, &sshUser, &sshPort); err != nil {
			logErr("load host ssh coords for teardown", err)
		}

		// (a) Box-side agent teardown over SSH.
		if h.RemoteTeardown == nil || tailnetAddr == "" {
			cleanup["sshTeardown"] = "skipped"
		} else {
			tctx, cancel := context.WithTimeout(r.Context(), h.remoteTimeout())
			res, _ := h.RemoteTeardown(tctx, RemoteTarget{
				HostID:      hst.ID,
				TailnetAddr: tailnetAddr,
				SSHUser:     sshUser,
				SSHPort:     sshPort,
			})
			cancel()
			if res.Status == "" {
				res.Status = "failed"
			}
			cleanup["sshTeardown"] = res.Status
		}

		// (b) Headscale node deregistration.
		hctx, cancel := context.WithTimeout(r.Context(), h.remoteTimeout())
		cleanup["headscale"] = h.deregisterHeadscaleNode(hctx, tailnetAddr)
		cancel()
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		logErr("begin delete host tx", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to remove host")
		return
	}
	defer tx.Rollback(r.Context())

	// Reassign soft-deleted deployments' history rows to the self-host so the
	// ON DELETE RESTRICT FK doesn't block the delete. (Live rows were already
	// refused above; only status='deleted' rows can remain here.)
	if _, err := tx.Exec(r.Context(), `
		UPDATE deployments
		   SET host_id = (SELECT id FROM hosts WHERE is_synapse_host = TRUE LIMIT 1)
		 WHERE host_id = $1 AND status = 'deleted'
	`, hst.ID); err != nil {
		logErr("reassign soft-deleted deployments", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to remove host")
		return
	}

	if _, err := tx.Exec(r.Context(), `DELETE FROM hosts WHERE id = $1`, hst.ID); err != nil {
		logErr("delete host", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to remove host")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		logErr("commit delete host", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to remove host")
		return
	}

	meta := map[string]any{"name": hst.Name, "isRemote": hst.IsRemote}
	if len(cleanup) > 0 {
		meta["cleanup"] = cleanup
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionDeleteHost,
		TargetType: audit.TargetHost,
		TargetID:   hst.ID,
		Metadata:   meta,
	})
	resp := map[string]any{"id": hst.ID, "status": "deleted"}
	if len(cleanup) > 0 {
		resp["cleanup"] = cleanup
	}
	writeJSON(w, http.StatusOK, resp)
}

// sampleDeploymentNames returns up to 5 live deployment names on a host, for a
// friendlier host_has_deployments message. Best-effort — a query error just
// yields no names (the count already proved there are some).
func (h *HostsHandler) sampleDeploymentNames(r *http.Request, hostID string) []string {
	rows, err := h.DB.Query(r.Context(), `
		SELECT name FROM deployments
		 WHERE host_id = $1 AND status <> 'deleted'
		 ORDER BY name LIMIT 5
	`, hostID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return names
		}
		names = append(names, n)
	}
	return names
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

// ---------- GET /v1/hosts/{hostID}/agents ----------

// hostAgentView is the safe, no-secrets projection of a host_agents row. It
// deliberately omits token_hash; the heartbeat payload is reduced to a tiny
// summary (docker availability + managed-container count) so we never echo an
// agent's raw observed blob back over the API.
type hostAgentView struct {
	ID             string                `json:"id"`
	HostID         string                `json:"hostId"`
	Status         string                `json:"status"`
	ConnectionMode string                `json:"connectionMode"`
	LastSeenAt     *time.Time            `json:"lastSeenAt,omitempty"`
	CreatedAt      time.Time             `json:"createdAt"`
	UpdatedAt      time.Time             `json:"updatedAt"`
	Observed       *agentObservedSummary `json:"observed,omitempty"`
}

type agentObservedSummary struct {
	DockerAvailable       bool `json:"dockerAvailable"`
	ManagedContainerCount int  `json:"managedContainerCount"`
}

type listHostAgentsResp struct {
	// AgentVersion is a host-level fact (all agents on a host report the same
	// running version); surfaced here so the agents view shows it without a
	// per-agent column. Empty until the first heartbeat.
	AgentVersion string          `json:"agentVersion,omitempty"`
	Items        []hostAgentView `json:"items"`
}

func (h *HostsHandler) listHostAgents(w http.ResponseWriter, r *http.Request) {
	hst, ok := h.loadHost(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, host_id, status, connection_mode, last_seen_at,
		       last_heartbeat_payload, created_at, updated_at
		  FROM host_agents
		 WHERE host_id = $1
		 ORDER BY created_at ASC
	`, hst.ID)
	if err != nil {
		logErr("list host agents", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list agents")
		return
	}
	defer rows.Close()
	items := make([]hostAgentView, 0)
	for rows.Next() {
		var v hostAgentView
		var payload []byte
		if err := rows.Scan(&v.ID, &v.HostID, &v.Status, &v.ConnectionMode, &v.LastSeenAt,
			&payload, &v.CreatedAt, &v.UpdatedAt); err != nil {
			logErr("scan host agent", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to read agents")
			return
		}
		v.Observed = summarizeObserved(payload)
		items = append(items, v)
	}
	if err := rows.Err(); err != nil {
		logErr("iterate host agents", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read agents")
		return
	}
	writeJSON(w, http.StatusOK, listHostAgentsResp{AgentVersion: hst.AgentVersion, Items: items})
}

// summarizeObserved reduces the agent's last_heartbeat_payload jsonb to a
// non-sensitive summary. Returns nil when there's no payload.
func summarizeObserved(raw []byte) *agentObservedSummary {
	if len(raw) == 0 {
		return nil
	}
	var p struct {
		DockerAvailable bool `json:"dockerAvailable"`
		// containers (Bloco 9 rich form) is preferred; synapseManagedContainers
		// is the older names-only form, kept as a fallback.
		Containers               []json.RawMessage `json:"containers"`
		SynapseManagedContainers []string          `json:"synapseManagedContainers"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	count := len(p.Containers)
	if count == 0 {
		count = len(p.SynapseManagedContainers)
	}
	return &agentObservedSummary{
		DockerAvailable:       p.DockerAvailable,
		ManagedContainerCount: count,
	}
}

// ---------- POST /v1/host_agents/{agentID}/revoke ----------

func (h *HostsHandler) revokeAgent(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	id := chi.URLParam(r, "agentID")
	var hostID string
	err := h.DB.QueryRow(r.Context(), `
		UPDATE host_agents SET status = 'revoked', updated_at = now()
		 WHERE id::text = $1
		RETURNING host_id
	`, id).Scan(&hostID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "agent_not_found", "Agent not found")
		return
	}
	if err != nil {
		logErr("revoke agent", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to revoke agent")
		return
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionRevokeHostAgent,
		TargetType: audit.TargetHostAgent,
		TargetID:   id,
		Metadata:   map[string]any{"hostId": hostID},
	})
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": models.HostAgentStatusRevoked})
}

// ---------- POST /v1/host_agents/{agentID}/rotate_token ----------

type rotateAgentTokenResp struct {
	// AgentToken is the freshly-minted bearer, shown ONCE. The previous
	// token's hash is overwritten, so it stops working immediately.
	ID         string `json:"id"`
	HostID     string `json:"hostId"`
	AgentToken string `json:"agentToken"`
}

func (h *HostsHandler) rotateAgentToken(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	id := chi.URLParam(r, "agentID")
	plain, hash, err := auth.GenerateTokenWithPrefix(auth.AgentTokenPrefix)
	if err != nil {
		logErr("generate rotated agent token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to rotate token")
		return
	}
	// Rotating also un-revokes (status→online) — operators rotate to recover a
	// leaked-but-needed agent. last_seen_at is left as-is.
	var hostID string
	err = h.DB.QueryRow(r.Context(), `
		UPDATE host_agents SET token_hash = $2, status = 'online', updated_at = now()
		 WHERE id::text = $1
		RETURNING host_id
	`, id, hash).Scan(&hostID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "agent_not_found", "Agent not found")
		return
	}
	if err != nil {
		logErr("rotate agent token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to rotate token")
		return
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionRotateHostAgentToken,
		TargetType: audit.TargetHostAgent,
		TargetID:   id,
		Metadata:   map[string]any{"hostId": hostID},
	})
	writeJSON(w, http.StatusOK, rotateAgentTokenResp{ID: id, HostID: hostID, AgentToken: plain})
}

// ---------- helpers ----------

func (h *HostsHandler) loadHost(w http.ResponseWriter, r *http.Request) (models.Host, bool) {
	// {hostID} accepts either the UUID or the host's (globally unique) name —
	// mirrors teams.go::resolveTeam's id-or-slug resolution so operators can
	// pass the friendly name on the CLI / in URLs.
	ref := chi.URLParam(r, "hostID")
	row := h.DB.QueryRow(r.Context(), `SELECT `+hostColumns+` FROM hosts WHERE id::text = $1 OR name = $1`, ref)
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
