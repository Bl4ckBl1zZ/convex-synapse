-- v1.26+ — Per-deployment snapshot backups (the self-hosted answer to
-- Cloud's Backups page, which is paywalled at Pro and 404'd here as
-- not_supported_in_self_hosted).
--
-- A backup is a real Convex snapshot export (`npx convex export` against
-- the deployment with its admin key — the same consistent-archive
-- machinery upgrade_to_ha already uses), landed as a zip on the shared
-- `synapse-backups` Docker volume. Restore feeds it back with
-- `convex import --replace`. Export/restore are long async work, so they
-- ride the provisioning_jobs queue (new kinds below), never a handler
-- goroutine.
--
-- file_path is RELATIVE to the backups volume root
-- ("<deployment_id>/<backup_id>.zip") so the API container and the
-- transient CLI containers can mount the volume at different paths.

CREATE TABLE deployment_backups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'complete', 'failed')),
    file_path TEXT NOT NULL DEFAULT '',
    size_bytes BIGINT,
    error TEXT NOT NULL DEFAULT '',
    -- requested_by NULL = the daily scheduler (no human actor).
    requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    -- Stamped by the worker each time this archive is fed back via
    -- `convex import --replace` — the panel's "restored 2m ago" signal.
    restored_at TIMESTAMPTZ
);

CREATE INDEX deployment_backups_deployment_idx
    ON deployment_backups (deployment_id, created_at DESC);

-- Per-deployment backup policy. schedule='daily' has the sweeper enqueue
-- one backup per UTC day; retention bounds how many COMPLETE backups the
-- sweeper keeps per deployment (oldest pruned first, files included).
ALTER TABLE deployments
    ADD COLUMN backup_schedule TEXT NOT NULL DEFAULT 'none'
        CHECK (backup_schedule IN ('none', 'daily')),
    ADD COLUMN backup_retention INTEGER NOT NULL DEFAULT 7
        CHECK (backup_retention >= 1 AND backup_retention <= 90);

-- Queue plumbing: backup/restore jobs + the row they operate on.
ALTER TABLE provisioning_jobs
    DROP CONSTRAINT provisioning_jobs_kind_check;

ALTER TABLE provisioning_jobs
    ADD CONSTRAINT provisioning_jobs_kind_check
    CHECK (kind IN ('provision', 'upgrade_to_ha', 'reconcile', 'backup', 'restore'));

ALTER TABLE provisioning_jobs
    ADD COLUMN backup_id UUID REFERENCES deployment_backups(id) ON DELETE CASCADE;
