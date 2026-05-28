DROP INDEX IF EXISTS deployments_host_idx;
ALTER TABLE deployments DROP COLUMN IF EXISTS host_id;
