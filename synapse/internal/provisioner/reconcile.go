package provisioner

import (
	"context"
	"encoding/json"
	"log/slog"
	"runtime/debug"
	"time"

	"github.com/Iann29/synapse/internal/models"
)

// runReconcile executes one Bloco 10 reconcile job: bring a deployment's
// container into line with desired state, writing the outcome to the linked
// operation_step and rolling up the operation_run. Phase 1 handles
// create + restart (no data loss). stop/remove are refused defensively here —
// the apply handler never enqueues them in Phase 1, but the worker is the last
// line of defence if one ever slips through.
//
// Safety properties (see docs/CCP_APPLY_PLAN.md §6):
//   - G4 idempotency: create only fires from a non-running state, claimed
//     atomically; an already-running deployment becomes a no_op.
//   - G7 adopted: a deployment we didn't provision is never reconciled.
//   - failures are isolated per step; the run rolls up from live DB state so
//     concurrent step completions converge without coordination.
func (w *Worker) runReconcile(ctx context.Context, logger *slog.Logger, j claimedJob) {
	// Panic shield — a bad reconcile never kills the worker.
	defer func() {
		if rec := recover(); rec != nil {
			logger.Error("provisioner: reconcile panicked",
				"job_id", j.JobID, "deployment", j.Name, "panic", rec,
				"stack", string(debug.Stack()))
			w.failReconcile(j, "panic in reconcile worker")
		}
	}()

	logger = logger.With(
		"reconcile_action", j.ReconcileAction,
		"deployment", j.Name,
		"operation_run", j.OperationRunID,
		"operation_step", j.OperationStepID)

	// G7 — never reconcile an adopted deployment (we don't own its container).
	if j.Adopted {
		logger.Info("provisioner: reconcile skipped (adopted deployment)")
		w.skipReconcile(j, "adopted deployment — reconcile refused")
		return
	}
	// Never act on a deleted deployment.
	if j.DeploymentStatus == models.DeploymentStatusDeleted {
		w.skipReconcile(j, "deployment is deleted")
		return
	}

	switch j.ReconcileAction {
	case "create":
		w.reconcileCreate(ctx, logger, j)
	case "restart":
		w.reconcileRestart(ctx, logger, j)
	case "stop", "remove":
		// Phase 2 — data-affecting. The apply handler must never enqueue
		// these in Phase 1; if one ever slips through, do nothing.
		logger.Warn("provisioner: dangerous reconcile action refused", "action", j.ReconcileAction)
		w.skipReconcile(j, "action '"+j.ReconcileAction+"' is not enabled in this build")
	default:
		w.failReconcile(j, "unknown reconcile action: "+j.ReconcileAction)
	}
}

// reconcileCreate provisions a missing deployment's container from its existing
// deployments row (which holds the admin key / instance secret / storage). It
// reuses the exact provision machinery runJob uses.
func (w *Worker) reconcileCreate(ctx context.Context, logger *slog.Logger, j claimedJob) {
	// G4 idempotency: atomically claim the deployment into 'provisioning'.
	// We claim from ANY state except 'provisioning' (a create is already in
	// flight) and 'deleted'/adopted — NOT just failed/stopped. The control-
	// plane row's status can be a stale 'running' while the container is gone
	// (that's exactly what "missing" drift means), so the row status is not a
	// reliable idempotency signal. Real idempotency comes from the apply
	// handler only enqueuing create for freshly-classified 'missing' items
	// (G3) + the single-flight index (G5); if a container did reappear,
	// Provision fails on the name collision — a clean failed step, never a
	// data-losing double. 0 rows → already provisioning/deleted/adopted → no_op.
	tag, err := w.DB.Exec(ctx, `
		UPDATE deployments
		   SET status = 'provisioning', last_deploy_at = now()
		 WHERE id = $1
		   AND adopted = false
		   AND status NOT IN ('provisioning', 'deleted')
	`, j.DeploymentID)
	if err != nil {
		w.failReconcile(j, "claim for create: "+err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		var status string
		_ = w.DB.QueryRow(ctx, `SELECT status FROM deployments WHERE id = $1`, j.DeploymentID).Scan(&status)
		logger.Info("provisioner: reconcile create no-op", "deployment_status", status)
		w.noOpReconcile(j, "deployment already "+status+"; nothing to create")
		return
	}

	dispatcher := w.dockerForJob(j, logger)
	if dispatcher == nil {
		// dockerForJob already markFailed'd the job + flipped the deployment
		// to 'failed'. Mirror into the ledger (idempotent re-mark).
		w.failReconcile(j, "remote host dispatch unavailable")
		return
	}

	info, err := dispatcher.Provision(ctx, w.buildSpec(ctx, j))
	if err != nil {
		logger.Error("provisioner: reconcile create provision failed", "err", err)
		w.failReconcile(j, "provision: "+err.Error())
		return
	}
	if _, _, err := w.markProvisionRunning(ctx, j, info); err != nil {
		w.failReconcile(j, "mark running: "+err.Error())
		return
	}
	logger.Info("provisioner: reconcile create succeeded")
	w.succeedReconcile(j, "container created")
}

// reconcileRestart bounces an existing-but-not-running container in place.
func (w *Worker) reconcileRestart(ctx context.Context, logger *slog.Logger, j claimedJob) {
	dispatcher := w.dockerForJob(j, logger)
	if dispatcher == nil {
		w.failReconcile(j, "remote host dispatch unavailable")
		return
	}
	if err := dispatcher.Restart(ctx, j.Name); err != nil {
		logger.Error("provisioner: reconcile restart failed", "err", err)
		w.failReconcile(j, "restart: "+err.Error())
		return
	}
	// Reflect running in the row (best-effort; the health worker reconciles
	// status independently). Guard against racing a delete.
	if _, err := w.DB.Exec(ctx, `
		UPDATE deployments
		   SET status = 'running', last_deploy_at = now()
		 WHERE id = $1 AND status <> 'deleted'
	`, j.DeploymentID); err != nil {
		w.failReconcile(j, "mark running: "+err.Error())
		return
	}
	logger.Info("provisioner: reconcile restart succeeded")
	w.succeedReconcile(j, "container restarted")
}

// ---- ledger helpers: write the operation_step + roll up the operation_run ----

func (w *Worker) succeedReconcile(j claimedJob, msg string) {
	w.markDone(j.JobID)
	w.writeReconcileStep(j.OperationStepID, "succeeded", "", map[string]any{"message": msg})
	w.rollupReconcileRun(j.OperationRunID)
}

func (w *Worker) skipReconcile(j claimedJob, reason string) {
	w.markDone(j.JobID)
	w.writeReconcileStep(j.OperationStepID, "skipped", reason, nil)
	w.rollupReconcileRun(j.OperationRunID)
}

func (w *Worker) noOpReconcile(j claimedJob, reason string) {
	w.markDone(j.JobID)
	w.writeReconcileStep(j.OperationStepID, "no_op", reason, nil)
	w.rollupReconcileRun(j.OperationRunID)
}

func (w *Worker) failReconcile(j claimedJob, errStr string) {
	// markFailed marks the job failed AND flips a still-'provisioning'
	// deployment to 'failed'. Idempotent if dockerForJob already did it.
	w.markFailed(j.JobID, j.DeploymentID, errStr)
	w.writeReconcileStep(j.OperationStepID, "failed", errStr, nil)
	w.rollupReconcileRun(j.OperationRunID)
}

// writeReconcileStep records a terminal operation_step status. Steps stay
// 'planned' while in-flight (operation_steps.status has no queued/running
// value) — the linked provisioning_jobs row + the run status carry progress.
func (w *Worker) writeReconcileStep(stepID, status, errStr string, result map[string]any) {
	if stepID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var resultJSON []byte
	if result != nil {
		resultJSON, _ = json.Marshal(result)
	}
	var errPtr *string
	if errStr != "" {
		errPtr = &errStr
	}
	if _, err := w.DB.Exec(ctx, `
		UPDATE operation_steps
		   SET status = $1, result_json = $2, error = $3, updated_at = now()
		 WHERE id = $4
	`, status, resultJSON, errPtr, stepID); err != nil {
		slog.Default().Error("provisioner: write reconcile step", "step_id", stepID, "err", err)
	}
}

// rollupReconcileRun recomputes the operation_run aggregate from live DB state.
// It is a pure function of the current rows, so concurrent step completions
// converge: while any linked reconcile job is still pending/claimed the run
// stays 'running'; once all are terminal the run is finalized 'succeeded'
// (or 'failed' if any step failed). The status guard makes the finalize
// idempotent under the last-two-jobs race.
func (w *Worker) rollupReconcileRun(runID string) {
	if runID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var inflight int
	if err := w.DB.QueryRow(ctx, `
		SELECT count(*) FROM provisioning_jobs
		 WHERE operation_run_id = $1 AND kind = 'reconcile'
		   AND status IN ('pending', 'claimed')
	`, runID).Scan(&inflight); err != nil {
		slog.Default().Error("provisioner: rollup inflight query", "run_id", runID, "err", err)
		return
	}
	if inflight > 0 {
		if _, err := w.DB.Exec(ctx, `
			UPDATE operation_runs SET status = 'running', updated_at = now()
			 WHERE id = $1 AND status = 'queued'
		`, runID); err != nil {
			slog.Default().Error("provisioner: rollup mark running", "run_id", runID, "err", err)
		}
		return
	}

	var succeeded, failed, skipped, noOp, total int
	if err := w.DB.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status = 'succeeded'),
		       count(*) FILTER (WHERE status = 'failed'),
		       count(*) FILTER (WHERE status = 'skipped'),
		       count(*) FILTER (WHERE status = 'no_op'),
		       count(*)
		  FROM operation_steps WHERE operation_run_id = $1
	`, runID).Scan(&succeeded, &failed, &skipped, &noOp, &total); err != nil {
		slog.Default().Error("provisioner: rollup step counts", "run_id", runID, "err", err)
		return
	}

	final := "succeeded"
	if failed > 0 {
		final = "failed"
	}
	result, _ := json.Marshal(map[string]any{
		"succeeded": succeeded, "failed": failed,
		"skipped": skipped, "noOp": noOp, "total": total,
	})
	if _, err := w.DB.Exec(ctx, `
		UPDATE operation_runs
		   SET status = $1, result_json = $2, finished_at = now(), updated_at = now()
		 WHERE id = $3 AND status IN ('queued', 'running')
	`, final, result, runID); err != nil {
		slog.Default().Error("provisioner: rollup finalize", "run_id", runID, "err", err)
	}
}
