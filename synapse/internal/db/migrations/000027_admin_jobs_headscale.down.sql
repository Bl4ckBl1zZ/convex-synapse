-- Revert: shrink admin_jobs.kind back to v1.4's single-value whitelist.
-- Any 'configure_headscale' rows that survived the migration window
-- block the down-migration so we don't silently orphan them.

ALTER TABLE admin_jobs DROP CONSTRAINT IF EXISTS admin_jobs_kind_check;

ALTER TABLE admin_jobs
    ADD CONSTRAINT admin_jobs_kind_check
    CHECK (kind IN ('reconfigure_host_domain'));
