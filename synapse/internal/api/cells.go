package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/db"
	"github.com/Iann29/synapse/internal/models"
)

// CellsHandler exposes the Cell endpoints (feat/cell-control-plane).
//
// Cells are project-scoped, so authorization rides on the existing
// team_members / project_members RBAC. Like TopologyHandler, this handler
// holds a *ProjectsHandler so the project-scoped routes (GET/POST
// /v1/projects/{id}/cells) can reuse loadProjectForRequest; the top-level
// routes (/v1/cells/{cellID}/...) resolve the owning project off the cell row
// and gate via effectiveProjectRole directly.
//
// Two route surfaces:
//   - project-scoped (mounted by ProjectsHandler.Routes via h.Cells):
//     GET  /v1/projects/{id}/cells          listCellsByProject
//     POST /v1/projects/{id}/cells          createCell
//   - cell-scoped (mounted at /v1/cells):
//     GET    /v1/cells/{cellID}
//     PATCH  /v1/cells/{cellID}
//     POST   /v1/cells/{cellID}/drain
//     POST   /v1/cells/{cellID}/attach_deployment
//     POST   /v1/cells/{cellID}/attach_host
//     GET    /v1/cells/{cellID}/resources
type CellsHandler struct {
	DB       *pgxpool.Pool
	Projects *ProjectsHandler
}

func (h *CellsHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Route("/{cellID}", func(r chi.Router) {
		r.Get("/", h.getCell)
		r.Patch("/", h.updateCell)
		r.Post("/drain", h.drainCell)
		r.Post("/attach_deployment", h.attachDeployment)
		r.Post("/attach_host", h.attachHost)
		r.Get("/resources", h.listCellResources)
	})
	return r
}

const cellColumns = `id, team_id, project_id, name, slug, kind, environment,
	region, isolation_tier, status, primary_deployment_id, primary_host_id,
	description, created_at, updated_at`

func scanCell(s scannable) (models.Cell, error) {
	var c models.Cell
	var primDep, primHost *string
	if err := s.Scan(
		&c.ID, &c.TeamID, &c.ProjectID, &c.Name, &c.Slug, &c.Kind, &c.Environment,
		&c.Region, &c.IsolationTier, &c.Status, &primDep, &primHost,
		&c.Description, &c.CreatedAt, &c.UpdatedAt,
	); err != nil {
		return models.Cell{}, err
	}
	c.PrimaryDeploymentID = primDep
	c.PrimaryHostID = primHost
	return c, nil
}

func loadCellByID(ctx context.Context, pool *pgxpool.Pool, id string) (models.Cell, error) {
	return scanCell(pool.QueryRow(ctx, `SELECT `+cellColumns+` FROM cells WHERE id::text = $1`, id))
}

// ---------- GET /v1/projects/{id}/cells ----------

type listCellsResp struct {
	Items []models.Cell `json:"items"`
}

func (h *CellsHandler) listCellsByProject(w http.ResponseWriter, r *http.Request) {
	if h.Projects == nil {
		writeError(w, http.StatusServiceUnavailable, "not_configured", "ProjectsHandler not wired")
		return
	}
	p, _, _, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `SELECT `+cellColumns+` FROM cells WHERE project_id = $1 ORDER BY created_at ASC`, p.ID)
	if err != nil {
		logErr("list cells", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list cells")
		return
	}
	defer rows.Close()
	items := make([]models.Cell, 0)
	for rows.Next() {
		c, err := scanCell(rows)
		if err != nil {
			logErr("scan cell", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to read cells")
			return
		}
		items = append(items, c)
	}
	if err := rows.Err(); err != nil {
		logErr("iterate cells", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read cells")
		return
	}
	writeJSON(w, http.StatusOK, listCellsResp{Items: items})
}

// ---------- POST /v1/projects/{id}/cells ----------

type createCellReq struct {
	Name          string `json:"name"`
	Slug          string `json:"slug,omitempty"`
	Kind          string `json:"kind,omitempty"`
	Environment   string `json:"environment,omitempty"`
	Region        string `json:"region,omitempty"`
	IsolationTier string `json:"isolationTier,omitempty"`
	Description   string `json:"description,omitempty"`
}

func (h *CellsHandler) createCell(w http.ResponseWriter, r *http.Request) {
	if h.Projects == nil {
		writeError(w, http.StatusServiceUnavailable, "not_configured", "ProjectsHandler not wired")
		return
	}
	p, team, role, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to create cells in this project")
		return
	}
	uid, _ := auth.UserID(r.Context())

	var req createCellReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "missing_name", "Cell name is required")
		return
	}
	if len(req.Name) > 200 {
		writeError(w, http.StatusBadRequest, "invalid_name", "Cell name is too long (max 200 chars)")
		return
	}

	kind := orDefault(req.Kind, models.CellKindCore)
	if !validCellKind(kind) {
		writeError(w, http.StatusBadRequest, "invalid_kind", "kind must be one of: core, runtime, integration, preview, enterprise-app")
		return
	}
	env := orDefault(req.Environment, models.CellEnvProd)
	if !validCellEnv(env) {
		writeError(w, http.StatusBadRequest, "invalid_environment", "environment must be one of: dev, staging, prod, preview")
		return
	}
	tier := orDefault(req.IsolationTier, models.CellTierShared)
	if !validCellTier(tier) {
		writeError(w, http.StatusBadRequest, "invalid_isolation_tier", "isolationTier must be one of: shared, premium, dedicated, internal")
		return
	}
	region := strings.TrimSpace(req.Region)
	if region == "" && team.DefaultRegion != "" && team.DefaultRegion != "self-hosted" {
		region = team.DefaultRegion
	}

	baseSlug := slugify(req.Slug)
	if req.Slug == "" {
		baseSlug = slugify(req.Name)
	}

	// SELECT-then-INSERT with retry on the (project_id, slug) unique
	// constraint — same allocator pattern as createDeployment. fn re-picks
	// the slug each attempt so a racing writer (or a manual collision) is
	// recovered instead of surfaced as a 500.
	var cell models.Cell
	attempt := 0
	err := db.WithRetryOnUniqueViolation(r.Context(), 6, func() error {
		candidate := baseSlug
		switch {
		case attempt == 1:
			candidate = withSuffix(baseSlug, 2)
		case attempt >= 2:
			candidate = withRandomSuffix(baseSlug)
		}
		attempt++
		c, err := scanCell(h.DB.QueryRow(r.Context(), `
			INSERT INTO cells (team_id, project_id, name, slug, kind, environment,
			                   region, isolation_tier, status, description)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			RETURNING `+cellColumns,
			p.TeamID, p.ID, req.Name, candidate, kind, env, region, tier,
			models.CellStatusActive, strings.TrimSpace(req.Description),
		))
		if err != nil {
			return err
		}
		cell = c
		return nil
	})
	if err != nil {
		logErr("insert cell", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to create cell")
		return
	}

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID:     p.TeamID,
		ActorID:    uid,
		Action:     audit.ActionCreateCell,
		TargetType: audit.TargetCell,
		TargetID:   cell.ID,
		Metadata:   map[string]any{"name": cell.Name, "kind": cell.Kind, "environment": cell.Environment},
	})
	writeJSON(w, http.StatusCreated, cell)
}

// ---------- GET /v1/cells/{cellID} ----------

func (h *CellsHandler) getCell(w http.ResponseWriter, r *http.Request) {
	cell, _, ok := h.loadCellForRequest(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, cell)
}

// ---------- PATCH /v1/cells/{cellID} ----------

type updateCellReq struct {
	Name          *string `json:"name,omitempty"`
	Description   *string `json:"description,omitempty"`
	Status        *string `json:"status,omitempty"`
	Region        *string `json:"region,omitempty"`
	IsolationTier *string `json:"isolationTier,omitempty"`
}

func (h *CellsHandler) updateCell(w http.ResponseWriter, r *http.Request) {
	cell, role, ok := h.loadCellForRequest(w, r)
	if !ok {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to edit this cell")
		return
	}
	uid, _ := auth.UserID(r.Context())

	var req updateCellReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 200 {
			writeError(w, http.StatusBadRequest, "invalid_name", "Cell name must be 1-200 chars")
			return
		}
		cell.Name = name
	}
	if req.Description != nil {
		cell.Description = strings.TrimSpace(*req.Description)
	}
	if req.Status != nil {
		if !validCellStatus(*req.Status) {
			writeError(w, http.StatusBadRequest, "invalid_status", "status must be one of: active, inactive, draining, migrating, maintenance")
			return
		}
		cell.Status = *req.Status
	}
	if req.Region != nil {
		cell.Region = strings.TrimSpace(*req.Region)
	}
	if req.IsolationTier != nil {
		if !validCellTier(*req.IsolationTier) {
			writeError(w, http.StatusBadRequest, "invalid_isolation_tier", "isolationTier must be one of: shared, premium, dedicated, internal")
			return
		}
		cell.IsolationTier = *req.IsolationTier
	}

	updated, err := scanCell(h.DB.QueryRow(r.Context(), `
		UPDATE cells
		   SET name = $2, description = $3, status = $4, region = $5,
		       isolation_tier = $6, updated_at = now()
		 WHERE id = $1
		RETURNING `+cellColumns,
		cell.ID, cell.Name, cell.Description, cell.Status, cell.Region, cell.IsolationTier,
	))
	if err != nil {
		logErr("update cell", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to update cell")
		return
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID:     updated.TeamID,
		ActorID:    uid,
		Action:     audit.ActionUpdateCell,
		TargetType: audit.TargetCell,
		TargetID:   updated.ID,
	})
	writeJSON(w, http.StatusOK, updated)
}

// ---------- POST /v1/cells/{cellID}/drain ----------

func (h *CellsHandler) drainCell(w http.ResponseWriter, r *http.Request) {
	cell, role, ok := h.loadCellForRequest(w, r)
	if !ok {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to drain this cell")
		return
	}
	uid, _ := auth.UserID(r.Context())
	updated, err := scanCell(h.DB.QueryRow(r.Context(), `
		UPDATE cells SET status = $2, updated_at = now() WHERE id = $1
		RETURNING `+cellColumns,
		cell.ID, models.CellStatusDraining,
	))
	if err != nil {
		logErr("drain cell", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to drain cell")
		return
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID:     updated.TeamID,
		ActorID:    uid,
		Action:     audit.ActionDrainCell,
		TargetType: audit.TargetCell,
		TargetID:   updated.ID,
	})
	writeJSON(w, http.StatusOK, updated)
}

// ---------- POST /v1/cells/{cellID}/attach_deployment ----------

type attachDeploymentReq struct {
	DeploymentName string `json:"deploymentName"`
	Role           string `json:"role,omitempty"`
}

type attachDeploymentResp struct {
	Cell      models.Cell                `json:"cell"`
	Placement models.DeploymentPlacement `json:"placement"`
}

func (h *CellsHandler) attachDeployment(w http.ResponseWriter, r *http.Request) {
	cell, role, ok := h.loadCellForRequest(w, r)
	if !ok {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to attach deployments to this cell")
		return
	}
	uid, _ := auth.UserID(r.Context())

	var req attachDeploymentReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	req.DeploymentName = strings.TrimSpace(req.DeploymentName)
	if req.DeploymentName == "" {
		writeError(w, http.StatusBadRequest, "missing_deployment", "deploymentName is required")
		return
	}
	resourceRole := orDefault(req.Role, models.CellResourceRolePrimary)
	if !validCellResourceRole(resourceRole) {
		writeError(w, http.StatusBadRequest, "invalid_role", "role must be one of: primary, secondary, backup, internal")
		return
	}

	dep, _, _, err := loadDeployment(r.Context(), h.DB, req.DeploymentName)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "deployment_not_found", "Deployment not found")
		return
	}
	if err != nil {
		logErr("load deployment for attach", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load deployment")
		return
	}
	if dep.ProjectID != cell.ProjectID {
		writeError(w, http.StatusBadRequest, "deployment_wrong_project", "Deployment belongs to a different project than this cell")
		return
	}

	// Placement host: the cell's primary host, unless the deployment is
	// adopted (external — not on a host we manage).
	var placementHostID *string
	if cell.PrimaryHostID != nil && !dep.Adopted {
		placementHostID = cell.PrimaryHostID
	}
	var hostPort *int
	if dep.HostPort > 0 {
		hp := dep.HostPort
		hostPort = &hp
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		logErr("attach begin tx", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to attach deployment")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	_, err = tx.Exec(r.Context(), `
		INSERT INTO cell_resources (cell_id, resource_type, resource_id, role)
		VALUES ($1, $2, $3, $4)
	`, cell.ID, models.CellResourceConvexDeployment, dep.ID, resourceRole)
	if err != nil {
		if db.IsUniqueViolation(err) {
			writeError(w, http.StatusConflict, "deployment_already_attached", "This deployment is already attached to a cell")
			return
		}
		logErr("insert cell_resource", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to attach deployment")
		return
	}

	var placement models.DeploymentPlacement
	placement, err = scanPlacement(tx.QueryRow(r.Context(), `
		INSERT INTO deployment_placements (deployment_id, cell_id, host_id,
		                                   desired_status, observed_status,
		                                   docker_container_id, internal_port,
		                                   public_url, last_observed_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
		ON CONFLICT (deployment_id) DO UPDATE
		   SET cell_id = EXCLUDED.cell_id,
		       host_id = EXCLUDED.host_id,
		       observed_status = EXCLUDED.observed_status,
		       docker_container_id = EXCLUDED.docker_container_id,
		       internal_port = EXCLUDED.internal_port,
		       public_url = EXCLUDED.public_url,
		       last_observed_at = now(),
		       updated_at = now()
		RETURNING `+placementColumns,
		dep.ID, cell.ID, placementHostID, models.PlacementDesiredRunning,
		observedFromStatus(dep.Status), nullStr(dep.ContainerID), hostPort, nullStr(dep.DeploymentURL),
	))
	if err != nil {
		logErr("upsert placement", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to record placement")
		return
	}

	// Point the cell's primary_deployment_id at this deployment when the
	// attach is primary or the cell has no primary yet.
	if resourceRole == models.CellResourceRolePrimary || cell.PrimaryDeploymentID == nil {
		if _, err := tx.Exec(r.Context(), `UPDATE cells SET primary_deployment_id = $2, updated_at = now() WHERE id = $1`, cell.ID, dep.ID); err != nil {
			logErr("set primary deployment", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to set primary deployment")
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		logErr("attach commit", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to attach deployment")
		return
	}

	updated, err := loadCellByID(r.Context(), h.DB, cell.ID)
	if err != nil {
		logErr("reload cell post-attach", err)
		writeError(w, http.StatusInternalServerError, "internal", "Deployment attached but failed to reload cell")
		return
	}

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID:     cell.TeamID,
		ActorID:    uid,
		Action:     audit.ActionAttachDeploymentToCell,
		TargetType: audit.TargetCell,
		TargetID:   cell.ID,
		Metadata:   map[string]any{"deployment": dep.Name, "role": resourceRole},
	})
	writeJSON(w, http.StatusOK, attachDeploymentResp{Cell: updated, Placement: placement})
}

// ---------- POST /v1/cells/{cellID}/attach_host ----------

type attachHostReq struct {
	// HostID accepts either a host UUID or a host name, for CLI ergonomics
	// (`synapse cells attach-host <cell> <host-name>`).
	HostID string `json:"hostId"`
}

func (h *CellsHandler) attachHost(w http.ResponseWriter, r *http.Request) {
	cell, role, ok := h.loadCellForRequest(w, r)
	if !ok {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to attach a host to this cell")
		return
	}
	uid, _ := auth.UserID(r.Context())

	var req attachHostReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	req.HostID = strings.TrimSpace(req.HostID)
	if req.HostID == "" {
		writeError(w, http.StatusBadRequest, "missing_host", "hostId is required")
		return
	}
	var hostID string
	err := h.DB.QueryRow(r.Context(), `SELECT id FROM hosts WHERE id::text = $1 OR name = $1`, req.HostID).Scan(&hostID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "host_not_found", "Host not found")
		return
	}
	if err != nil {
		logErr("resolve host for attach", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to resolve host")
		return
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		logErr("attach host begin tx", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to attach host")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if _, err := tx.Exec(r.Context(), `UPDATE cells SET primary_host_id = $2, updated_at = now() WHERE id = $1`, cell.ID, hostID); err != nil {
		logErr("set primary host", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to attach host")
		return
	}
	// Backfill host_id onto this cell's placements that don't have one yet.
	// We don't clobber a placement that's already pinned to a host — moving a
	// running deployment between hosts is a desired-state operation (later
	// block), not a side effect of attach_host.
	if _, err := tx.Exec(r.Context(), `UPDATE deployment_placements SET host_id = $2, updated_at = now() WHERE cell_id = $1 AND host_id IS NULL`, cell.ID, hostID); err != nil {
		logErr("backfill placement host", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to attach host")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		logErr("attach host commit", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to attach host")
		return
	}

	updated, err := loadCellByID(r.Context(), h.DB, cell.ID)
	if err != nil {
		logErr("reload cell post-attach-host", err)
		writeError(w, http.StatusInternalServerError, "internal", "Host attached but failed to reload cell")
		return
	}
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID:     cell.TeamID,
		ActorID:    uid,
		Action:     audit.ActionUpdateCell,
		TargetType: audit.TargetCell,
		TargetID:   cell.ID,
		Metadata:   map[string]any{"primaryHostId": hostID},
	})
	writeJSON(w, http.StatusOK, updated)
}

// ---------- GET /v1/cells/{cellID}/resources ----------

const placementColumns = `id, deployment_id, cell_id, host_id, desired_status,
	observed_status, docker_container_id, internal_port, public_url, route_id,
	volume_ref, last_applied_at, last_observed_at, created_at, updated_at`

func scanPlacement(s scannable) (models.DeploymentPlacement, error) {
	var p models.DeploymentPlacement
	var hostID, containerID, publicURL, routeID, volumeRef *string
	if err := s.Scan(
		&p.ID, &p.DeploymentID, &p.CellID, &hostID, &p.DesiredStatus,
		&p.ObservedStatus, &containerID, &p.InternalPort, &publicURL, &routeID,
		&volumeRef, &p.LastAppliedAt, &p.LastObservedAt, &p.CreatedAt, &p.UpdatedAt,
	); err != nil {
		return models.DeploymentPlacement{}, err
	}
	p.HostID = hostID
	p.RouteID = routeID
	p.DockerContainerID = derefStr(containerID)
	p.PublicURL = derefStr(publicURL)
	p.VolumeRef = derefStr(volumeRef)
	return p, nil
}

type cellResourcesResp struct {
	Resources  []models.CellResource        `json:"resources"`
	Placements []models.DeploymentPlacement `json:"placements"`
}

func (h *CellsHandler) listCellResources(w http.ResponseWriter, r *http.Request) {
	cell, _, ok := h.loadCellForRequest(w, r)
	if !ok {
		return
	}

	resRows, err := h.DB.Query(r.Context(), `
		SELECT id, cell_id, resource_type, resource_id, role, created_at, updated_at
		  FROM cell_resources WHERE cell_id = $1 ORDER BY created_at ASC
	`, cell.ID)
	if err != nil {
		logErr("list cell resources", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list resources")
		return
	}
	defer resRows.Close()
	resources := make([]models.CellResource, 0)
	for resRows.Next() {
		var cr models.CellResource
		if err := resRows.Scan(&cr.ID, &cr.CellID, &cr.ResourceType, &cr.ResourceID, &cr.Role, &cr.CreatedAt, &cr.UpdatedAt); err != nil {
			logErr("scan cell resource", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to read resources")
			return
		}
		resources = append(resources, cr)
	}
	if err := resRows.Err(); err != nil {
		logErr("iterate cell resources", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read resources")
		return
	}

	placeRows, err := h.DB.Query(r.Context(), `SELECT `+placementColumns+` FROM deployment_placements WHERE cell_id = $1 ORDER BY created_at ASC`, cell.ID)
	if err != nil {
		logErr("list placements", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list placements")
		return
	}
	defer placeRows.Close()
	placements := make([]models.DeploymentPlacement, 0)
	for placeRows.Next() {
		p, err := scanPlacement(placeRows)
		if err != nil {
			logErr("scan placement", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to read placements")
			return
		}
		placements = append(placements, p)
	}
	if err := placeRows.Err(); err != nil {
		logErr("iterate placements", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read placements")
		return
	}
	writeJSON(w, http.StatusOK, cellResourcesResp{Resources: resources, Placements: placements})
}

// ---------- helpers ----------

// loadCellForRequest resolves /v1/cells/{cellID}, then authorises the caller
// against the cell's owning project via the existing project RBAC. Returns
// the cell + the caller's effective project role.
func (h *CellsHandler) loadCellForRequest(w http.ResponseWriter, r *http.Request) (models.Cell, string, bool) {
	uid, err := auth.UserID(r.Context())
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Not authenticated")
		return models.Cell{}, "", false
	}
	id := chi.URLParam(r, "cellID")
	cell, err := loadCellByID(r.Context(), h.DB, id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "cell_not_found", "Cell not found")
		return models.Cell{}, "", false
	}
	if err != nil {
		logErr("load cell", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load cell")
		return models.Cell{}, "", false
	}
	role, err := effectiveProjectRole(r.Context(), h.DB, cell.ProjectID, cell.TeamID, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have access to this cell")
		return models.Cell{}, "", false
	}
	if err != nil {
		logErr("cell membership", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to verify access")
		return models.Cell{}, "", false
	}
	if !enforceProjectAccess(w, r.Context(), cell.ProjectID, cell.TeamID) {
		return models.Cell{}, "", false
	}
	return cell, role, true
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return strings.TrimSpace(v)
}

func observedFromStatus(deploymentStatus string) string {
	switch deploymentStatus {
	case models.DeploymentStatusRunning:
		return models.PlacementObservedRunning
	case models.DeploymentStatusStopped:
		return models.PlacementObservedStopped
	case models.DeploymentStatusFailed:
		return models.PlacementObservedFailed
	default:
		return models.PlacementObservedUnknown
	}
}

func validCellKind(s string) bool {
	switch s {
	case models.CellKindCore, models.CellKindRuntime, models.CellKindIntegration, models.CellKindPreview, models.CellKindEnterpriseApp:
		return true
	}
	return false
}

func validCellEnv(s string) bool {
	switch s {
	case models.CellEnvDev, models.CellEnvStaging, models.CellEnvProd, models.CellEnvPreview:
		return true
	}
	return false
}

func validCellTier(s string) bool {
	switch s {
	case models.CellTierShared, models.CellTierPremium, models.CellTierDedicated, models.CellTierInternal:
		return true
	}
	return false
}

func validCellStatus(s string) bool {
	switch s {
	case models.CellStatusActive, models.CellStatusInactive, models.CellStatusDraining, models.CellStatusMigrating, models.CellStatusMaintenance:
		return true
	}
	return false
}

func validCellResourceRole(s string) bool {
	switch s {
	case models.CellResourceRolePrimary, models.CellResourceRoleSecondary, models.CellResourceRoleBackup, models.CellResourceRoleInternal:
		return true
	}
	return false
}
