-- Revert Bloco 10 reconcile-job columns + the widened kind constraint.

DROP INDEX IF EXISTS provisioning_jobs_reconcile_step_inflight;

ALTER TABLE provisioning_jobs
    DROP COLUMN IF EXISTS operation_step_id,
    DROP COLUMN IF EXISTS operation_run_id,
    DROP COLUMN IF EXISTS reconcile_action;

ALTER TABLE provisioning_jobs
    DROP CONSTRAINT provisioning_jobs_kind_check;

ALTER TABLE provisioning_jobs
    ADD CONSTRAINT provisioning_jobs_kind_check
    CHECK (kind IN ('provision', 'upgrade_to_ha'));
