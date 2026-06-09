ALTER TABLE provisioning_jobs DROP COLUMN IF EXISTS backup_id;

ALTER TABLE provisioning_jobs
    DROP CONSTRAINT provisioning_jobs_kind_check;
ALTER TABLE provisioning_jobs
    ADD CONSTRAINT provisioning_jobs_kind_check
    CHECK (kind IN ('provision', 'upgrade_to_ha', 'reconcile'));

ALTER TABLE deployments
    DROP COLUMN IF EXISTS backup_schedule,
    DROP COLUMN IF EXISTS backup_retention;

DROP TABLE IF EXISTS deployment_backups;
