-- Bloco 10 — central-driven apply (reconcile execution).
--
-- The CCP can now EXECUTE a reconcile plan (create a missing deployment's
-- container, restart a stopped one), not just diagnose it. Execution reuses
-- the existing provisioning_jobs queue + provisioner.Worker — the same durable,
-- multi-node-safe path create_deployment uses — so the agent never gains
-- mutate powers (apply is central-driven). See docs/CCP_APPLY_PLAN.md.
--
-- This migration widens the queue to carry reconcile work. It is inert until
-- SYNAPSE_APPLY_ENABLED=true; no reconcile job is ever enqueued otherwise.

-- 1. Widen kind to allow 'reconcile'.
ALTER TABLE provisioning_jobs
    DROP CONSTRAINT provisioning_jobs_kind_check;

ALTER TABLE provisioning_jobs
    ADD CONSTRAINT provisioning_jobs_kind_check
    CHECK (kind IN ('provision', 'upgrade_to_ha', 'reconcile'));

-- 2. Reconcile linkage. NULL for non-reconcile jobs. operation_run_id /
--    operation_step_id tie the job back to the OperationRun ledger so the
--    worker writes terminal step status + result there. ON DELETE CASCADE:
--    if the run is removed the orphaned job rows go with it.
ALTER TABLE provisioning_jobs
    ADD COLUMN reconcile_action  TEXT
        CHECK (reconcile_action IS NULL OR
               reconcile_action IN ('create', 'restart', 'stop', 'remove')),
    ADD COLUMN operation_run_id  UUID REFERENCES operation_runs(id)  ON DELETE CASCADE,
    ADD COLUMN operation_step_id UUID REFERENCES operation_steps(id) ON DELETE CASCADE;

-- 3. Idempotency / single-flight: at most one un-finished reconcile job per
--    plan step. The unique partial index makes a duplicate in-flight reconcile
--    for the same step a constraint violation, not a double-apply (the apply
--    handler relies on this + WithRetryOnUniqueViolation).
CREATE UNIQUE INDEX provisioning_jobs_reconcile_step_inflight
    ON provisioning_jobs (operation_step_id)
    WHERE kind = 'reconcile' AND status IN ('pending', 'claimed');
