-- v1.18.0 Phase 4: route deployment provisioning to a specific host.
--
-- Pre-v1.18 every Synapse-managed deployment ran on the same host as
-- the Synapse control plane itself (docker run via local /var/run/
-- docker.sock). v1.18 adds Remote Hosts: operators run install-agent.sh
-- on a VPS that joins the Headscale tailnet + configures sshd for
-- forced-command Docker dispatch. Synapse central then provisions Convex
-- containers there over SSH on the tailnet IP.
--
-- This migration adds deployments.host_id NOT NULL, backfilling existing
-- rows to the self-host row (the single hosts.is_synapse_host=true row
-- per the partial unique index in 000017). The provisioner worker (Phase
-- 4 routing) joins deployments → hosts on this column to decide local vs
-- SSH dispatch.

-- The self-host row is normally seeded by cells.Backfill on first server
-- boot. We can't rely on the boot order for migrations: a freshly-
-- upgraded install with EnableCells=false has deployments but no hosts
-- rows, which would fail the NOT NULL constraint below. Seed the row
-- here so the migration is self-sufficient. Idempotent via the partial
-- unique index hosts_one_synapse_host_idx.
INSERT INTO hosts (name, provider, region, status, is_synapse_host)
SELECT 'synapse-host', 'self-hosted', '', 'online', TRUE
 WHERE NOT EXISTS (SELECT 1 FROM hosts WHERE is_synapse_host = TRUE);

-- Add the column nullable first so the FK is satisfied before backfill.
ALTER TABLE deployments
    ADD COLUMN host_id UUID REFERENCES hosts(id) ON DELETE RESTRICT;

-- Backfill: every existing deployment lived on the self-host. The
-- INSERT above guarantees exactly one such row exists.
UPDATE deployments
   SET host_id = (SELECT id FROM hosts WHERE is_synapse_host = TRUE LIMIT 1)
 WHERE host_id IS NULL;

ALTER TABLE deployments ALTER COLUMN host_id SET NOT NULL;

CREATE INDEX deployments_host_idx ON deployments (host_id);
