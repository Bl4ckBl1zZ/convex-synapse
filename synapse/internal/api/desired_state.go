package api

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/models"
)

// DesiredStateHandler owns the project-scoped desired-state endpoints (Bloco
// 9a): sync-from-placements (the derivation of intent) + listing. Host-scoped
// reads live on HostsHandler; the agent reads its own host's desired state via
// /v1/agents/desired_state. Nothing here applies anything.
type DesiredStateHandler struct {
	DB       *pgxpool.Pool
	Projects *ProjectsHandler
}

const desiredStateColumns = `id, team_id, project_id, cell_id, host_id, resource_type,
	resource_id, resource_key, desired_json, desired_hash, version, status, source,
	created_by_user_id, created_at, updated_at`

func scanDesiredState(s scannable) (models.DesiredState, error) {
	var d models.DesiredState
	var desired []byte
	if err := s.Scan(&d.ID, &d.TeamID, &d.ProjectID, &d.CellID, &d.HostID, &d.ResourceType,
		&d.ResourceID, &d.ResourceKey, &desired, &d.DesiredHash, &d.Version, &d.Status, &d.Source,
		&d.CreatedBy, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return models.DesiredState{}, err
	}
	d.DesiredJSON = unmarshalJSONBMap(desired)
	return d, nil
}

// ---- POST /v1/projects/{id}/desired_state/sync_from_placements ----

func (h *DesiredStateHandler) syncFromPlacements(w http.ResponseWriter, r *http.Request) {
	if h.Projects == nil {
		writeError(w, http.StatusServiceUnavailable, "not_configured", "ProjectsHandler not wired")
		return
	}
	p, _, role, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	// Mutating intent → project admin (or instance admin via team-admin role).
	if !canAdminProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "Syncing desired state requires project admin")
		return
	}
	uid, _ := auth.UserID(r.Context())
	var byUser *string
	if uid != "" {
		byUser = &uid
	}

	runID, err := startOperationRun(r.Context(), h.DB, opRunInput{
		Type:      models.OperationTypeSyncDesiredFromPlacements,
		TeamID:    &p.TeamID,
		ProjectID: &p.ID,
		CreatedBy: byUser,
		Input:     map[string]any{"projectId": p.ID},
	})
	if err != nil {
		logErr("start sync operation run", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to start sync")
		return
	}

	result, syncErr := syncDesiredFromPlacements(r.Context(), h.DB, p.ID, p.TeamID, byUser)
	if syncErr != nil {
		finishOperationRun(r.Context(), h.DB, runID, models.OperationStatusFailed, nil, nil, syncErr.Error())
		logErr("sync desired from placements", syncErr)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to sync desired state")
		return
	}
	finishOperationRun(r.Context(), h.DB, runID, models.OperationStatusSucceeded, result, nil, "")

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID: p.TeamID, ActorID: uid,
		Action: audit.ActionSyncDesiredFromPlacements, TargetType: audit.TargetProject, TargetID: p.ID,
		Metadata: result,
	})
	result["operationRunId"] = runID
	writeJSON(w, http.StatusOK, result)
}

// syncDesiredFromPlacements derives DesiredState rows from the project's
// deployment_placements. Idempotent: re-running with unchanged placements
// changes nothing; a placement that moved host supersedes the old active
// desired and creates a fresh one on the new host. Single transaction.
//
// Only placements WITH a host produce host-scoped desired states. No secrets
// are written — just placement intent + synapse.* labels.
func syncDesiredFromPlacements(ctx context.Context, pool *pgxpool.Pool, projectID, teamID string, byUser *string) (map[string]any, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT dp.deployment_id, dp.cell_id, dp.host_id, dp.desired_status, c.team_id
		  FROM deployment_placements dp JOIN cells c ON c.id = dp.cell_id
		 WHERE c.project_id = $1 AND dp.host_id IS NOT NULL
	`, projectID)
	if err != nil {
		return nil, err
	}
	type want struct {
		deploymentID, cellID, hostID, desiredStatus, cellTeamID string
	}
	var wants []want
	for rows.Next() {
		var wv want
		if err := rows.Scan(&wv.deploymentID, &wv.cellID, &wv.hostID, &wv.desiredStatus, &wv.cellTeamID); err != nil {
			rows.Close()
			return nil, err
		}
		wants = append(wants, wv)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	created, updated, unchanged := 0, 0, 0
	wantedKeys := map[string]bool{} // host|key
	for _, wv := range wants {
		resourceKey := models.ResourceTypeConvexDeployment + ":" + wv.deploymentID
		wantedKeys[wv.hostID+"|"+resourceKey] = true
		desired := map[string]any{
			"deploymentId":  wv.deploymentID,
			"cellId":        wv.cellID,
			"hostId":        wv.hostID,
			"desiredStatus": wv.desiredStatus,
			"managedBy":     "synapse",
			"labels": map[string]any{
				"synapse.managed":       "true",
				"synapse.project_id":    projectID,
				"synapse.cell_id":       wv.cellID,
				"synapse.deployment_id": wv.deploymentID,
			},
		}
		hash := canonicalHash(desired)

		var existingID, existingHash string
		var existingVersion int
		err := tx.QueryRow(ctx, `
			SELECT id, desired_hash, version FROM desired_states
			 WHERE host_id = $1 AND resource_type = $2 AND resource_key = $3 AND status = 'active'
		`, wv.hostID, models.ResourceTypeConvexDeployment, resourceKey).Scan(&existingID, &existingHash, &existingVersion)
		switch {
		case err == nil && existingHash == hash:
			unchanged++
			continue
		case err == nil:
			// Supersede the old active version, insert a new one.
			if _, err := tx.Exec(ctx, `UPDATE desired_states SET status = 'superseded', updated_at = now() WHERE id = $1`, existingID); err != nil {
				return nil, err
			}
			if err := insertDesired(ctx, tx, teamID, projectID, wv.cellID, wv.hostID, resourceKey, wv.deploymentID, desired, hash, existingVersion+1, byUser); err != nil {
				return nil, err
			}
			updated++
		case err == pgx.ErrNoRows:
			if err := insertDesired(ctx, tx, teamID, projectID, wv.cellID, wv.hostID, resourceKey, wv.deploymentID, desired, hash, 1, byUser); err != nil {
				return nil, err
			}
			created++
		default:
			return nil, err
		}
	}

	// Supersede orphaned active placement-sourced desired states: ones whose
	// (host, key) no longer corresponds to any current placement (e.g. the
	// deployment moved hosts, or the placement was removed).
	superseded := 0
	orphanRows, err := tx.Query(ctx, `
		SELECT id, host_id, resource_key FROM desired_states
		 WHERE project_id = $1 AND source = 'placement'
		   AND resource_type = $2 AND status = 'active'
	`, projectID, models.ResourceTypeConvexDeployment)
	if err != nil {
		return nil, err
	}
	var orphanIDs []string
	for orphanRows.Next() {
		var id, hostID, key string
		if err := orphanRows.Scan(&id, &hostID, &key); err != nil {
			orphanRows.Close()
			return nil, err
		}
		if !wantedKeys[hostID+"|"+key] {
			orphanIDs = append(orphanIDs, id)
		}
	}
	orphanRows.Close()
	if err := orphanRows.Err(); err != nil {
		return nil, err
	}
	for _, id := range orphanIDs {
		if _, err := tx.Exec(ctx, `UPDATE desired_states SET status = 'superseded', updated_at = now() WHERE id = $1`, id); err != nil {
			return nil, err
		}
		superseded++
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{
		"created":    created,
		"updated":    updated,
		"unchanged":  unchanged,
		"superseded": superseded,
		"total":      len(wants),
	}, nil
}

func insertDesired(ctx context.Context, tx pgx.Tx, teamID, projectID, cellID, hostID, resourceKey, deploymentID string, desired map[string]any, hash string, version int, byUser *string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO desired_states (team_id, project_id, cell_id, host_id, resource_type,
		                            resource_id, resource_key, desired_json, desired_hash,
		                            version, status, source, created_by_user_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', 'placement', $11)
	`, teamID, projectID, cellID, hostID, models.ResourceTypeConvexDeployment,
		deploymentID, resourceKey, marshalJSONBMap(desired), hash, version, byUser)
	return err
}

// ---- GET /v1/projects/{id}/desired_state ----

type listDesiredResp struct {
	Items []models.DesiredState `json:"items"`
}

func (h *DesiredStateHandler) listProjectDesired(w http.ResponseWriter, r *http.Request) {
	if h.Projects == nil {
		writeError(w, http.StatusServiceUnavailable, "not_configured", "ProjectsHandler not wired")
		return
	}
	p, _, _, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	items, err := loadActiveDesiredByProject(r.Context(), h.DB, p.ID)
	if err != nil {
		logErr("list project desired state", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list desired state")
		return
	}
	writeJSON(w, http.StatusOK, listDesiredResp{Items: items})
}

func loadActiveDesiredByProject(ctx context.Context, pool *pgxpool.Pool, projectID string) ([]models.DesiredState, error) {
	rows, err := pool.Query(ctx, `SELECT `+desiredStateColumns+` FROM desired_states WHERE project_id = $1 AND status = 'active' ORDER BY created_at ASC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]models.DesiredState, 0)
	for rows.Next() {
		d, err := scanDesiredState(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, d)
	}
	return items, rows.Err()
}

func loadActiveDesiredByHost(ctx context.Context, pool *pgxpool.Pool, hostID string) ([]models.DesiredState, error) {
	rows, err := pool.Query(ctx, `SELECT `+desiredStateColumns+` FROM desired_states WHERE host_id = $1 AND status = 'active' ORDER BY created_at ASC`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]models.DesiredState, 0)
	for rows.Next() {
		d, err := scanDesiredState(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, d)
	}
	return items, rows.Err()
}
