package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/models"
	"github.com/Iann29/synapse/internal/provisioner"
)

// Bloco 10 — central-driven apply (reconcile execution). These endpoints turn a
// drift plan into real container work, enqueued on the existing provisioning
// queue and executed by provisioner.Worker (never by the agent). Off by default
// (SYNAPSE_APPLY_ENABLED). Full design + guardrails: docs/CCP_APPLY_PLAN.md.
//
//   POST /v1/projects/{id}/reconcile/apply   (project-admin)
//   POST /v1/cells/{id}/reconcile/apply      (project-admin on the cell's project)
//   POST /v1/hosts/{ref}/reconcile/apply     (instance-admin)

type applyReq struct {
	// ForceDangerous + Confirm gate Phase-2 stop/remove. Inert in Phase 1
	// (those actions are always skipped). Kept so the wire shape is stable.
	ForceDangerous bool     `json:"force_dangerous"`
	Confirm        string   `json:"confirm"`
	// Only optionally restricts apply to a subset of deployment ids.
	Only []string `json:"only"`
}

func (h *DriftHandler) applyProject(w http.ResponseWriter, r *http.Request) {
	p, _, role, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	if !canAdminProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "Reconcile apply requires project admin")
		return
	}
	h.doApply(w, r, driftScope{kind: scopeProject, projectID: p.ID, teamID: p.TeamID})
}

func (h *DriftHandler) applyCell(w http.ResponseWriter, r *http.Request) {
	c, role, ok := h.Cells.loadCellForRequest(w, r)
	if !ok {
		return
	}
	if !canAdminProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "Reconcile apply requires project admin")
		return
	}
	h.doApply(w, r, driftScope{kind: scopeCell, cellID: c.ID, projectID: c.ProjectID, teamID: c.TeamID})
}

func (h *DriftHandler) applyHost(w http.ResponseWriter, r *http.Request) {
	hst, ok := h.Hosts.loadHost(w, r)
	if !ok {
		return
	}
	h.doApply(w, r, driftScope{kind: scopeHost, hostID: hst.ID})
}

// doApply is the shared apply core. It (G1) refuses unless apply is enabled,
// (G3) recomputes drift fresh so it acts on current reality, then builds an
// OperationRun + steps and enqueues a reconcile job per applicable step — all
// in ONE transaction so the worker can't see (and prematurely finalize) a
// half-enqueued run. Non-applicable steps are recorded skipped/no_op with a
// reason. Returns 202 with the run id; the worker finalizes the run.
func (h *DriftHandler) doApply(w http.ResponseWriter, r *http.Request, scope driftScope) {
	// G1 — gate. 404 (not 403) so a disabled instance is indistinguishable
	// from one that never had the feature.
	if !h.ApplyEnabled {
		writeError(w, http.StatusNotFound, "not_found", "Reconcile apply is not enabled on this instance")
		return
	}

	uid, _ := auth.UserID(r.Context())
	actor := uid

	var req applyReq
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req) // tolerate an empty body
	}
	onlySet := make(map[string]bool, len(req.Only))
	for _, id := range req.Only {
		onlySet[strings.TrimSpace(id)] = true
	}

	ctx := r.Context()

	// G3 — fresh recompute. We act on the world as it is NOW, not on the plan
	// the operator looked at; a deployment that stopped drifting becomes a
	// no_op rather than a blind action.
	items, _, err := h.computeDrift(ctx, scope)
	if err != nil {
		logErr("apply: recompute drift", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to compute drift")
		return
	}
	steps := buildPlanSteps(items)

	tx, err := h.DB.Begin(ctx)
	if err != nil {
		logErr("apply: begin tx", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to start apply")
		return
	}
	defer tx.Rollback(ctx)

	in := scope.opRunInput(models.OperationTypeReconcileApply, &actor)
	var runID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO operation_runs (type, team_id, project_id, cell_id, host_id, deployment_id,
		                            status, input_json, created_by_user_id, started_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8, now())
		RETURNING id
	`, in.Type, in.TeamID, in.ProjectID, in.CellID, in.HostID, in.DeploymentID,
		marshalJSONBMap(in.Input), in.CreatedBy).Scan(&runID); err != nil {
		logErr("apply: insert operation_run", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to start apply")
		return
	}

	queued, skipped, noOp, dangerousSkipped := 0, 0, 0, 0
	for i, s := range steps {
		depID := strings.TrimPrefix(s.ResourceKey, "convex_deployment:")
		stepStatus, reason, enqueue := h.decideApplyStep(ctx, tx, s, depID, onlySet)

		var stepID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO operation_steps
				(operation_run_id, step_index, action, resource_type, resource_key, status, reason)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id
		`, runID, i, s.Action, s.ResourceType, s.ResourceKey, stepStatus, reason).Scan(&stepID); err != nil {
			logErr("apply: insert operation_step", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to start apply")
			return
		}

		if enqueue {
			if _, err := provisioner.EnqueueReconcile(ctx, tx, depID, s.Action, runID, stepID, h.HealthcheckViaNetwork); err != nil {
				logErr("apply: enqueue reconcile", err)
				writeError(w, http.StatusInternalServerError, "internal", "Failed to enqueue reconcile work")
				return
			}
			queued++
			continue
		}
		switch {
		case stepStatus == models.OperationStepStatusNoOp:
			noOp++
		case s.Dangerous:
			dangerousSkipped++
		default:
			skipped++
		}
	}

	summary := map[string]any{
		"queued": queued, "skipped": skipped, "noOp": noOp, "dangerousSkipped": dangerousSkipped,
	}

	// If nothing was enqueued there's no worker to finalize the run — close it
	// out here as succeeded. Otherwise leave it 'running'; the worker's rollup
	// finalizes it once the last reconcile job completes.
	status := models.OperationStatusRunning
	if queued == 0 {
		status = models.OperationStatusSucceeded
		if _, err := tx.Exec(ctx, `
			UPDATE operation_runs
			   SET status = 'succeeded', result_json = $2, finished_at = now(), updated_at = now()
			 WHERE id = $1
		`, runID, marshalJSONBMap(summary)); err != nil {
			logErr("apply: finalize empty run", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to finalize apply")
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		logErr("apply: commit", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to start apply")
		return
	}

	// G10 — audit. Best-effort; never fails the request.
	h.auditDrift(ctx, actor, scope, "reconcileApplyStarted",
		map[string]any{"operationRunId": runID, "queued": queued, "skipped": skipped, "noOp": noOp})

	writeJSON(w, http.StatusAccepted, map[string]any{
		"operationRunId": runID,
		"status":         status,
		"summary":        summary,
	})
}

// decideApplyStep classifies a plan step into the operation_step status it
// should land in and whether to enqueue a reconcile job. Enqueued steps stay
// 'planned' (the linked job + run status carry progress). Encodes guardrails
// G5 (busy), G6 (dangerous), G7 (adopted).
func (h *DriftHandler) decideApplyStep(ctx context.Context, tx pgx.Tx, s planStep, depID string, onlySet map[string]bool) (status, reason string, enqueue bool) {
	// Already-in-sync items are no_op, never touched.
	if s.Status == models.OperationStepStatusNoOp {
		return models.OperationStepStatusNoOp, s.Reason, false
	}
	// G6 — dangerous (stop/remove) is Phase 2. Always skipped in this build,
	// even with SYNAPSE_APPLY_DANGEROUS, until the executor wires those paths.
	if s.Dangerous {
		return models.OperationStepStatusSkipped,
			"data-affecting action — not enabled (Phase 2)", false
	}
	// Only create/restart are auto-applicable. investigate/unmanaged/orphaned
	// are operator decisions.
	if s.Action != models.RecommendedActionCreate && s.Action != models.RecommendedActionRestart {
		return models.OperationStepStatusSkipped, "no automatic action for this drift", false
	}
	// Optional allow-list.
	if len(onlySet) > 0 && !onlySet[depID] {
		return models.OperationStepStatusSkipped, "not selected", false
	}
	// G7 — never reconcile an adopted deployment; and the row must exist.
	var adopted bool
	if err := tx.QueryRow(ctx, `SELECT adopted FROM deployments WHERE id = $1`, depID).Scan(&adopted); err != nil {
		return models.OperationStepStatusSkipped, "deployment not found", false
	}
	if adopted {
		return models.OperationStepStatusSkipped, "adopted deployment — not reconciled", false
	}
	// G5 — single-flight: don't reconcile a deployment with work already in
	// flight (would race the Convex single-writer lease).
	var busy int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM provisioning_jobs
		 WHERE deployment_id = $1 AND status IN ('pending', 'claimed')
	`, depID).Scan(&busy); err != nil {
		return models.OperationStepStatusSkipped, "could not check in-flight work", false
	}
	if busy > 0 {
		return models.OperationStepStatusSkipped, "deployment has work in flight", false
	}
	return models.OperationStepStatusPlanned, "", true
}
