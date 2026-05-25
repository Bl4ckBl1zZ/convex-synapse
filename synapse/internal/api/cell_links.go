package api

import (
	"context"
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

// CellLinksHandler powers the service-to-service contract layer between Cells
// (feat/cell-control-plane, Bloco 7). It registers WHO may talk, the protocol,
// the allowed command/event vocabulary, and the service tokens — it does NOT
// transport any command payload.
//
// Like CellsHandler it holds *ProjectsHandler so the project-scoped routes
// (GET/POST /v1/projects/{id}/cell_links) reuse loadProjectForRequest; the
// link-scoped routes resolve the owning project off the link row. The
// discovery endpoint is public (service-token bearer auth).
//
// Route surfaces:
//   - project-scoped (via ProjectsHandler.CellLinks):
//     GET/POST /v1/projects/{id}/cell_links
//   - link-scoped (/v1/cell_links):
//     GET/PATCH /v1/cell_links/{id}
//     POST      /v1/cell_links/{id}/disable
//     GET/POST  /v1/cell_links/{id}/service_tokens
//   - token-scoped (/v1/service_tokens):
//     POST /v1/service_tokens/{id}/revoke
//   - public discovery (/v1/internal/cell_links/discovery): service-token bearer
type CellLinksHandler struct {
	DB       *pgxpool.Pool
	Projects *ProjectsHandler
}

func (h *CellLinksHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Route("/{linkID}", func(r chi.Router) {
		r.Get("/", h.getCellLink)
		r.Patch("/", h.updateCellLink)
		r.Post("/disable", h.disableCellLink)
		r.Get("/service_tokens", h.listServiceTokens)
		r.Post("/service_tokens", h.createServiceToken)
	})
	return r
}

// ServiceTokenRoutes mounts /v1/service_tokens (token-scoped operations).
func (h *CellLinksHandler) ServiceTokenRoutes() chi.Router {
	r := chi.NewRouter()
	r.Post("/{tokenID}/revoke", h.revokeServiceToken)
	return r
}

const cellLinkSelect = `cl.id, cl.team_id, cl.project_id, cl.source_cell_id, cl.target_cell_id,
	cl.protocol, cl.auth_mode, cl.allowed_commands, cl.allowed_events, cl.status,
	(SELECT COUNT(*) FROM service_tokens st WHERE st.cell_link_id = cl.id AND st.status = 'active'),
	cl.created_at, cl.updated_at`

func scanCellLink(s scannable) (models.CellLink, error) {
	var l models.CellLink
	if err := s.Scan(&l.ID, &l.TeamID, &l.ProjectID, &l.SourceCellID, &l.TargetCellID,
		&l.Protocol, &l.AuthMode, &l.AllowedCommands, &l.AllowedEvents, &l.Status,
		&l.ServiceTokenCount, &l.CreatedAt, &l.UpdatedAt); err != nil {
		return models.CellLink{}, err
	}
	if l.AllowedCommands == nil {
		l.AllowedCommands = []string{}
	}
	if l.AllowedEvents == nil {
		l.AllowedEvents = []string{}
	}
	return l, nil
}

func loadCellLinkByID(ctx context.Context, pool *pgxpool.Pool, id string) (models.CellLink, error) {
	return scanCellLink(pool.QueryRow(ctx, `SELECT `+cellLinkSelect+` FROM cell_links cl WHERE cl.id::text = $1`, id))
}

// ---------- GET /v1/projects/{id}/cell_links ----------

type listCellLinksResp struct {
	Items []models.CellLink `json:"items"`
}

func (h *CellLinksHandler) listCellLinksByProject(w http.ResponseWriter, r *http.Request) {
	if h.Projects == nil {
		writeError(w, http.StatusServiceUnavailable, "not_configured", "ProjectsHandler not wired")
		return
	}
	p, _, _, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `SELECT `+cellLinkSelect+` FROM cell_links cl WHERE cl.project_id = $1 ORDER BY cl.created_at ASC`, p.ID)
	if err != nil {
		logErr("list cell links", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list cell links")
		return
	}
	defer rows.Close()
	items := make([]models.CellLink, 0)
	for rows.Next() {
		l, err := scanCellLink(rows)
		if err != nil {
			logErr("scan cell link", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to read cell links")
			return
		}
		items = append(items, l)
	}
	if err := rows.Err(); err != nil {
		logErr("iterate cell links", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read cell links")
		return
	}
	writeJSON(w, http.StatusOK, listCellLinksResp{Items: items})
}

// ---------- POST /v1/projects/{id}/cell_links ----------

type createCellLinkReq struct {
	SourceCellID    string   `json:"sourceCellId"`
	TargetCellID    string   `json:"targetCellId"`
	Protocol        string   `json:"protocol,omitempty"`
	AuthMode        string   `json:"authMode,omitempty"`
	AllowedCommands []string `json:"allowedCommands,omitempty"`
	AllowedEvents   []string `json:"allowedEvents,omitempty"`
}

func (h *CellLinksHandler) createCellLink(w http.ResponseWriter, r *http.Request) {
	if h.Projects == nil {
		writeError(w, http.StatusServiceUnavailable, "not_configured", "ProjectsHandler not wired")
		return
	}
	p, _, role, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to create cell links in this project")
		return
	}
	uid, _ := auth.UserID(r.Context())

	var req createCellLinkReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	req.SourceCellID = strings.TrimSpace(req.SourceCellID)
	req.TargetCellID = strings.TrimSpace(req.TargetCellID)
	if req.SourceCellID == "" || req.TargetCellID == "" {
		writeError(w, http.StatusBadRequest, "missing_cell", "sourceCellId and targetCellId are required")
		return
	}
	if req.SourceCellID == req.TargetCellID {
		writeError(w, http.StatusBadRequest, "self_link", "A cell cannot link to itself")
		return
	}

	// Both cells must live in THIS project (cross-project links are blocked).
	for _, id := range []string{req.SourceCellID, req.TargetCellID} {
		inProject, err := cellInProject(r.Context(), h.DB, id, p.ID)
		if err != nil {
			logErr("verify cell in project", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to verify cells")
			return
		}
		if !inProject {
			writeError(w, http.StatusBadRequest, "invalid_cell", "source and target cells must both belong to this project")
			return
		}
	}

	protocol := orDefault(req.Protocol, models.CellLinkProtocolOutbox)
	if !validCellLinkProtocol(protocol) {
		writeError(w, http.StatusBadRequest, "invalid_protocol", "protocol must be one of: http, convex_action, outbox, webhook, polling")
		return
	}
	authMode := orDefault(req.AuthMode, models.CellLinkAuthServiceToken)
	if !validCellLinkAuthMode(authMode) {
		writeError(w, http.StatusBadRequest, "invalid_auth_mode", "authMode must be one of: service_token, mtls, none")
		return
	}

	l, err := scanCellLink(h.DB.QueryRow(r.Context(), `
		INSERT INTO cell_links (team_id, project_id, source_cell_id, target_cell_id,
		                        protocol, auth_mode, allowed_commands, allowed_events)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING `+selfReturnCellLink, // see note below
		p.TeamID, p.ID, req.SourceCellID, req.TargetCellID, protocol, authMode,
		cleanStrings(req.AllowedCommands), cleanStrings(req.AllowedEvents),
	))
	if err != nil {
		if db.IsUniqueViolation(err) {
			writeError(w, http.StatusConflict, "link_already_exists", "An active link already exists for this source, target, and protocol")
			return
		}
		logErr("insert cell link", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to create cell link")
		return
	}

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID:     p.TeamID,
		ActorID:    uid,
		Action:     audit.ActionCreateCellLink,
		TargetType: audit.TargetCellLink,
		TargetID:   l.ID,
		Metadata:   map[string]any{"sourceCellId": l.SourceCellID, "targetCellId": l.TargetCellID, "protocol": l.Protocol},
	})
	writeJSON(w, http.StatusCreated, l)
}

// selfReturnCellLink is the RETURNING list for an INSERT into cell_links. It
// mirrors cellLinkSelect but without the `cl.` alias prefixes / subquery
// (RETURNING can't see a table alias, and a fresh link has 0 service tokens).
const selfReturnCellLink = `id, team_id, project_id, source_cell_id, target_cell_id,
	protocol, auth_mode, allowed_commands, allowed_events, status, 0, created_at, updated_at`

// ---------- GET/PATCH /v1/cell_links/{id} ----------

func (h *CellLinksHandler) getCellLink(w http.ResponseWriter, r *http.Request) {
	l, _, ok := h.loadCellLinkForRequest(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, l)
}

type updateCellLinkReq struct {
	AuthMode        *string   `json:"authMode,omitempty"`
	AllowedCommands *[]string `json:"allowedCommands,omitempty"`
	AllowedEvents   *[]string `json:"allowedEvents,omitempty"`
}

func (h *CellLinksHandler) updateCellLink(w http.ResponseWriter, r *http.Request) {
	l, role, ok := h.loadCellLinkForRequest(w, r)
	if !ok {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to edit this cell link")
		return
	}
	uid, _ := auth.UserID(r.Context())

	var req updateCellLinkReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if req.AuthMode != nil {
		if !validCellLinkAuthMode(*req.AuthMode) {
			writeError(w, http.StatusBadRequest, "invalid_auth_mode", "authMode must be one of: service_token, mtls, none")
			return
		}
		l.AuthMode = *req.AuthMode
	}
	if req.AllowedCommands != nil {
		l.AllowedCommands = cleanStrings(*req.AllowedCommands)
	}
	if req.AllowedEvents != nil {
		l.AllowedEvents = cleanStrings(*req.AllowedEvents)
	}

	updated, err := scanCellLink(h.DB.QueryRow(r.Context(), `
		UPDATE cell_links
		   SET auth_mode = $2, allowed_commands = $3, allowed_events = $4, updated_at = now()
		 WHERE id = $1
		RETURNING `+selfReturnCellLink,
		l.ID, l.AuthMode, l.AllowedCommands, l.AllowedEvents,
	))
	if err != nil {
		logErr("update cell link", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to update cell link")
		return
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID: updated.TeamID, ActorID: uid,
		Action: audit.ActionUpdateCellLink, TargetType: audit.TargetCellLink, TargetID: updated.ID,
	})
	// RETURNING gave 0 for the token count (no subquery in RETURNING); reload
	// so the response carries the real count.
	if reloaded, rerr := loadCellLinkByID(r.Context(), h.DB, updated.ID); rerr == nil {
		updated = reloaded
	}
	writeJSON(w, http.StatusOK, updated)
}

// ---------- POST /v1/cell_links/{id}/disable ----------

func (h *CellLinksHandler) disableCellLink(w http.ResponseWriter, r *http.Request) {
	l, role, ok := h.loadCellLinkForRequest(w, r)
	if !ok {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to disable this cell link")
		return
	}
	uid, _ := auth.UserID(r.Context())
	if _, err := h.DB.Exec(r.Context(), `UPDATE cell_links SET status = 'disabled', updated_at = now() WHERE id = $1`, l.ID); err != nil {
		logErr("disable cell link", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to disable cell link")
		return
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID: l.TeamID, ActorID: uid,
		Action: audit.ActionDisableCellLink, TargetType: audit.TargetCellLink, TargetID: l.ID,
	})
	reloaded, _ := loadCellLinkByID(r.Context(), h.DB, l.ID)
	writeJSON(w, http.StatusOK, reloaded)
}

// ---------- service tokens ----------

const serviceTokenColumns = `id, cell_link_id, source_cell_id, target_cell_id, name,
	scopes, status, expires_at, last_used_at, created_at, updated_at`

func scanServiceToken(s scannable) (models.ServiceToken, error) {
	var t models.ServiceToken
	if err := s.Scan(&t.ID, &t.CellLinkID, &t.SourceCellID, &t.TargetCellID, &t.Name,
		&t.Scopes, &t.Status, &t.ExpiresAt, &t.LastUsedAt, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return models.ServiceToken{}, err
	}
	if t.Scopes == nil {
		t.Scopes = []string{}
	}
	return t, nil
}

type listServiceTokensResp struct {
	Items []models.ServiceToken `json:"items"`
}

func (h *CellLinksHandler) listServiceTokens(w http.ResponseWriter, r *http.Request) {
	l, _, ok := h.loadCellLinkForRequest(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `SELECT `+serviceTokenColumns+` FROM service_tokens WHERE cell_link_id = $1 ORDER BY created_at ASC`, l.ID)
	if err != nil {
		logErr("list service tokens", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list service tokens")
		return
	}
	defer rows.Close()
	items := make([]models.ServiceToken, 0)
	for rows.Next() {
		t, err := scanServiceToken(rows)
		if err != nil {
			logErr("scan service token", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to read service tokens")
			return
		}
		items = append(items, t)
	}
	if err := rows.Err(); err != nil {
		logErr("iterate service tokens", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read service tokens")
		return
	}
	writeJSON(w, http.StatusOK, listServiceTokensResp{Items: items})
}

type createServiceTokenReq struct {
	Name      string     `json:"name,omitempty"`
	Scopes    []string   `json:"scopes,omitempty"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

func (h *CellLinksHandler) createServiceToken(w http.ResponseWriter, r *http.Request) {
	l, role, ok := h.loadCellLinkForRequest(w, r)
	if !ok {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to create service tokens for this link")
		return
	}
	uid, _ := auth.UserID(r.Context())

	var req createServiceTokenReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if req.ExpiresAt != nil && !req.ExpiresAt.After(time.Now()) {
		writeError(w, http.StatusBadRequest, "invalid_expires_at", "expiresAt must be in the future")
		return
	}

	plain, hash, err := auth.GenerateTokenWithPrefix(auth.ServiceTokenPrefix)
	if err != nil {
		logErr("generate service token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to generate token")
		return
	}

	var tok models.ServiceToken
	tok, err = scanServiceToken(h.DB.QueryRow(r.Context(), `
		INSERT INTO service_tokens (cell_link_id, source_cell_id, target_cell_id, name, token_hash, scopes, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING `+serviceTokenColumns,
		l.ID, l.SourceCellID, l.TargetCellID, strings.TrimSpace(req.Name), hash,
		cleanStrings(req.Scopes), req.ExpiresAt,
	))
	if err != nil {
		logErr("insert service token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to create service token")
		return
	}
	tok.Token = plain // shown once

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID: l.TeamID, ActorID: uid,
		Action: audit.ActionCreateServiceToken, TargetType: audit.TargetServiceToken, TargetID: tok.ID,
		Metadata: map[string]any{"cellLinkId": l.ID, "name": tok.Name},
	})
	writeJSON(w, http.StatusCreated, tok)
}

// ---------- POST /v1/service_tokens/{id}/revoke ----------

func (h *CellLinksHandler) revokeServiceToken(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserID(r.Context())
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Not authenticated")
		return
	}
	id := chi.URLParam(r, "tokenID")
	// Resolve the token → its link → project, for authorization.
	var linkID, projectID, teamID string
	err = h.DB.QueryRow(r.Context(), `
		SELECT st.cell_link_id, cl.project_id, cl.team_id
		  FROM service_tokens st JOIN cell_links cl ON cl.id = st.cell_link_id
		 WHERE st.id::text = $1
	`, id).Scan(&linkID, &projectID, &teamID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "service_token_not_found", "Service token not found")
		return
	}
	if err != nil {
		logErr("resolve service token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to resolve service token")
		return
	}
	role, rerr := effectiveProjectRole(r.Context(), h.DB, projectID, teamID, uid)
	if errors.Is(rerr, pgx.ErrNoRows) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have access to this service token")
		return
	}
	if rerr != nil {
		logErr("service token membership", rerr)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to verify access")
		return
	}
	if !enforceProjectAccess(w, r.Context(), projectID, teamID) {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to revoke this service token")
		return
	}

	if _, err := h.DB.Exec(r.Context(), `UPDATE service_tokens SET status = 'revoked', updated_at = now() WHERE id = $1`, id); err != nil {
		logErr("revoke service token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to revoke service token")
		return
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID: teamID, ActorID: uid,
		Action: audit.ActionRevokeServiceToken, TargetType: audit.TargetServiceToken, TargetID: id,
		Metadata: map[string]any{"cellLinkId": linkID},
	})
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": models.ServiceTokenStatusRevoked})
}

// ---------- GET /v1/internal/cell_links/discovery ----------

type discoveryTargetCell struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Environment string `json:"environment"`
}

type discoveryLink struct {
	LinkID          string              `json:"linkId"`
	TargetCellID    string              `json:"targetCellId"`
	TargetCell      discoveryTargetCell `json:"targetCell"`
	Protocol        string              `json:"protocol"`
	AuthMode        string              `json:"authMode"`
	AllowedCommands []string            `json:"allowedCommands"`
	AllowedEvents   []string            `json:"allowedEvents"`
	// Endpoint is intentionally null for now — Synapse doesn't invent routing
	// in this block. A later block may derive it from the target's route /
	// deployment.
	Endpoint *string `json:"endpoint"`
}

type discoveryResp struct {
	SourceCellID string          `json:"sourceCellId"`
	Links        []discoveryLink `json:"links"`
}

// Discovery authenticates a service token and returns the ACTIVE links from
// that token's source cell. Public route (no JWT); the bearer is a syn_svc_
// service token. Revoked / expired tokens fail with 401.
func (h *CellLinksHandler) Discovery(w http.ResponseWriter, r *http.Request) {
	tok := agentBearer(r) // generic "Bearer <token>" extractor (agents.go)
	if tok == "" {
		writeError(w, http.StatusUnauthorized, "missing_authorization", "Service token bearer required")
		return
	}
	hash := auth.HashToken(tok)
	var sourceCellID string
	err := h.DB.QueryRow(r.Context(), `
		UPDATE service_tokens
		   SET last_used_at = now()
		 WHERE token_hash = $1
		   AND status = 'active'
		   AND (expires_at IS NULL OR expires_at > now())
		RETURNING source_cell_id
	`, hash).Scan(&sourceCellID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Covers unknown, revoked, and expired tokens — all just "not valid".
		writeError(w, http.StatusUnauthorized, "invalid_service_token", "Service token is not valid")
		return
	}
	if err != nil {
		logErr("discovery token lookup", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to authenticate service token")
		return
	}

	rows, err := h.DB.Query(r.Context(), `
		SELECT cl.id, cl.target_cell_id, cl.protocol, cl.auth_mode,
		       cl.allowed_commands, cl.allowed_events,
		       c.name, c.kind, c.environment
		  FROM cell_links cl
		  JOIN cells c ON c.id = cl.target_cell_id
		 WHERE cl.source_cell_id = $1 AND cl.status = 'active'
		 ORDER BY cl.created_at ASC
	`, sourceCellID)
	if err != nil {
		logErr("discovery links", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load links")
		return
	}
	defer rows.Close()
	resp := discoveryResp{SourceCellID: sourceCellID, Links: []discoveryLink{}}
	for rows.Next() {
		var dl discoveryLink
		if err := rows.Scan(&dl.LinkID, &dl.TargetCellID, &dl.Protocol, &dl.AuthMode,
			&dl.AllowedCommands, &dl.AllowedEvents,
			&dl.TargetCell.Name, &dl.TargetCell.Kind, &dl.TargetCell.Environment); err != nil {
			logErr("scan discovery link", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to read links")
			return
		}
		dl.TargetCell.ID = dl.TargetCellID
		if dl.AllowedCommands == nil {
			dl.AllowedCommands = []string{}
		}
		if dl.AllowedEvents == nil {
			dl.AllowedEvents = []string{}
		}
		resp.Links = append(resp.Links, dl)
	}
	if err := rows.Err(); err != nil {
		logErr("iterate discovery links", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read links")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---------- helpers ----------

func (h *CellLinksHandler) loadCellLinkForRequest(w http.ResponseWriter, r *http.Request) (models.CellLink, string, bool) {
	uid, err := auth.UserID(r.Context())
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Not authenticated")
		return models.CellLink{}, "", false
	}
	id := chi.URLParam(r, "linkID")
	l, err := loadCellLinkByID(r.Context(), h.DB, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "cell_link_not_found", "Cell link not found")
		return models.CellLink{}, "", false
	}
	if err != nil {
		logErr("load cell link", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load cell link")
		return models.CellLink{}, "", false
	}
	role, err := effectiveProjectRole(r.Context(), h.DB, l.ProjectID, l.TeamID, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have access to this cell link")
		return models.CellLink{}, "", false
	}
	if err != nil {
		logErr("cell link membership", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to verify access")
		return models.CellLink{}, "", false
	}
	if !enforceProjectAccess(w, r.Context(), l.ProjectID, l.TeamID) {
		return models.CellLink{}, "", false
	}
	return l, role, true
}

// cellInProject reports whether the given cell exists AND belongs to projectID.
func cellInProject(ctx context.Context, pool *pgxpool.Pool, cellID, projectID string) (bool, error) {
	var pid string
	err := pool.QueryRow(ctx, `SELECT project_id FROM cells WHERE id::text = $1`, cellID).Scan(&pid)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return pid == projectID, nil
}

// cleanStrings trims, drops empties, and de-dupes (preserving order). Used for
// allowedCommands / allowedEvents / scopes from textarea-style input.
func cleanStrings(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func validCellLinkProtocol(s string) bool {
	switch s {
	case models.CellLinkProtocolHTTP, models.CellLinkProtocolConvexAction,
		models.CellLinkProtocolOutbox, models.CellLinkProtocolWebhook, models.CellLinkProtocolPolling:
		return true
	}
	return false
}

func validCellLinkAuthMode(s string) bool {
	switch s {
	case models.CellLinkAuthServiceToken, models.CellLinkAuthMTLS, models.CellLinkAuthNone:
		return true
	}
	return false
}
