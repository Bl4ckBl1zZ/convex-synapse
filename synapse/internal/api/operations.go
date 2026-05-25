package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/models"
)

// OperationsHandler exposes the read-only OperationRun endpoints (Bloco 9).
// Runs are created by the sync / drift / dry-run flows (never by heartbeats).
type OperationsHandler struct {
	DB       *pgxpool.Pool
	Projects *ProjectsHandler
}

func (h *OperationsHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/{runID}", h.getOperationRun)
	return r
}

// ---- shared helpers (used by desired_state / drift / dry-run) ----

// canonicalHash returns a deterministic sha256 of a JSON map. Go's json
// encoder sorts map keys, so the digest only changes when the content does.
func canonicalHash(m map[string]any) string {
	b, _ := json.Marshal(m)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// marshalJSONBMap encodes a map for a jsonb column; nil stays NULL.
func marshalJSONBMap(m map[string]any) []byte {
	if m == nil {
		return nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return b
}

func unmarshalJSONBMap(raw []byte) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return m
}

// opRunInput collects the scope of an operation run.
type opRunInput struct {
	Type         string
	TeamID       *string
	ProjectID    *string
	CellID       *string
	HostID       *string
	DeploymentID *string
	CreatedBy    *string
	Input        map[string]any
}

// startOperationRun inserts a running OperationRun and returns its id.
func startOperationRun(ctx context.Context, pool *pgxpool.Pool, in opRunInput) (string, error) {
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO operation_runs (type, team_id, project_id, cell_id, host_id, deployment_id,
		                            status, input_json, created_by_user_id, started_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8, now())
		RETURNING id
	`, in.Type, in.TeamID, in.ProjectID, in.CellID, in.HostID, in.DeploymentID,
		marshalJSONBMap(in.Input), in.CreatedBy).Scan(&id)
	return id, err
}

// finishOperationRun marks a run terminal with its result/plan/error.
func finishOperationRun(ctx context.Context, pool *pgxpool.Pool, id, status string, result, plan map[string]any, errStr string) {
	var errPtr *string
	if errStr != "" {
		errPtr = &errStr
	}
	if _, err := pool.Exec(ctx, `
		UPDATE operation_runs
		   SET status = $2, result_json = $3, plan_json = $4, error = $5,
		       finished_at = now(), updated_at = now()
		 WHERE id = $1
	`, id, status, marshalJSONBMap(result), marshalJSONBMap(plan), errPtr); err != nil {
		logErr("finish operation run", err)
	}
}

const operationRunColumns = `id, type, team_id, project_id, cell_id, host_id, deployment_id,
	status, input_json, plan_json, result_json, error, created_by_user_id,
	started_at, finished_at, created_at, updated_at`

func scanOperationRun(s scannable) (models.OperationRun, error) {
	var o models.OperationRun
	var input, plan, result []byte
	var errStr *string
	if err := s.Scan(&o.ID, &o.Type, &o.TeamID, &o.ProjectID, &o.CellID, &o.HostID, &o.DeploymentID,
		&o.Status, &input, &plan, &result, &errStr, &o.CreatedBy,
		&o.StartedAt, &o.FinishedAt, &o.CreatedAt, &o.UpdatedAt); err != nil {
		return models.OperationRun{}, err
	}
	o.InputJSON = unmarshalJSONBMap(input)
	o.PlanJSON = unmarshalJSONBMap(plan)
	o.ResultJSON = unmarshalJSONBMap(result)
	o.Error = derefStr(errStr)
	return o, nil
}

// ---- GET /v1/projects/{id}/operation_runs (mounted on ProjectsHandler) ----

type listOperationRunsResp struct {
	Items []models.OperationRun `json:"items"`
}

func (h *OperationsHandler) listProjectOperationRuns(w http.ResponseWriter, r *http.Request) {
	if h.Projects == nil {
		writeError(w, http.StatusServiceUnavailable, "not_configured", "ProjectsHandler not wired")
		return
	}
	p, _, _, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `SELECT `+operationRunColumns+` FROM operation_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`, p.ID)
	if err != nil {
		logErr("list operation runs", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list operation runs")
		return
	}
	defer rows.Close()
	items := make([]models.OperationRun, 0)
	for rows.Next() {
		o, err := scanOperationRun(rows)
		if err != nil {
			logErr("scan operation run", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to read operation runs")
			return
		}
		items = append(items, o)
	}
	if err := rows.Err(); err != nil {
		logErr("iterate operation runs", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read operation runs")
		return
	}
	writeJSON(w, http.StatusOK, listOperationRunsResp{Items: items})
}

// ---- GET /v1/operation_runs/{id} ----

func (h *OperationsHandler) getOperationRun(w http.ResponseWriter, r *http.Request) {
	uid, err := auth.UserID(r.Context())
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Not authenticated")
		return
	}
	id := chi.URLParam(r, "runID")
	o, err := scanOperationRun(h.DB.QueryRow(r.Context(), `SELECT `+operationRunColumns+` FROM operation_runs WHERE id::text = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "operation_run_not_found", "Operation run not found")
		return
	}
	if err != nil {
		logErr("load operation run", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load operation run")
		return
	}
	// RBAC: a project-scoped run is visible to project members; a run without a
	// project (host-only) requires instance-admin.
	if o.ProjectID != nil {
		var teamID string
		if o.TeamID != nil {
			teamID = *o.TeamID
		} else {
			_ = h.DB.QueryRow(r.Context(), `SELECT team_id FROM projects WHERE id = $1`, *o.ProjectID).Scan(&teamID)
		}
		if _, rerr := effectiveProjectRole(r.Context(), h.DB, *o.ProjectID, teamID, uid); errors.Is(rerr, pgx.ErrNoRows) {
			writeError(w, http.StatusForbidden, "forbidden", "You do not have access to this operation run")
			return
		}
	} else if !userIsInstanceAdmin(r.Context(), h.DB, uid) {
		writeError(w, http.StatusForbidden, "forbidden", "This operation run requires instance-admin")
		return
	}
	// Steps (planned/no_op in Bloco 9) ride along for the detail view.
	steps, err := loadOperationSteps(r.Context(), h.DB, o.ID)
	if err != nil {
		logErr("load operation steps", err)
		steps = []operationStepView{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"operationRun": o, "steps": steps})
}

type operationStepView struct {
	ID           string         `json:"id"`
	StepIndex    int            `json:"stepIndex"`
	Action       string         `json:"action"`
	ResourceType string         `json:"resourceType"`
	ResourceKey  string         `json:"resourceKey"`
	Status       string         `json:"status"`
	Reason       string         `json:"reason,omitempty"`
	Input        map[string]any `json:"input,omitempty"`
}

func loadOperationSteps(ctx context.Context, pool *pgxpool.Pool, runID string) ([]operationStepView, error) {
	rows, err := pool.Query(ctx, `
		SELECT id, step_index, action, resource_type, resource_key, status, reason, input_json
		  FROM operation_steps WHERE operation_run_id = $1 ORDER BY step_index ASC
	`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]operationStepView, 0)
	for rows.Next() {
		var s operationStepView
		var reason *string
		var input []byte
		if err := rows.Scan(&s.ID, &s.StepIndex, &s.Action, &s.ResourceType, &s.ResourceKey, &s.Status, &reason, &input); err != nil {
			return nil, err
		}
		s.Reason = derefStr(reason)
		s.Input = unmarshalJSONBMap(input)
		out = append(out, s)
	}
	return out, rows.Err()
}

// userIsInstanceAdmin is a shared helper for the EXISTS check.
func userIsInstanceAdmin(ctx context.Context, pool *pgxpool.Pool, uid string) bool {
	if uid == "" {
		return false
	}
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND is_instance_admin)`, uid).Scan(&ok); err != nil {
		return false
	}
	return ok
}
