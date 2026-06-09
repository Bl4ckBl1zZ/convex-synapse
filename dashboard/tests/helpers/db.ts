// Direct-to-postgres helpers used by the test setup hooks. We bypass the
// API for cleanup so we can reset the DB without needing admin credentials.

import { Client } from "pg";

const DB_URL =
  process.env.SYNAPSE_DB_URL ||
  "postgres://synapse:synapse@localhost:5432/synapse";

const TABLES = [
  "audit_events",
  "provisioning_jobs",
  "deploy_keys",
  // Instance-wide singleton the admin-alerts spec writes through the REAL
  // backend (not mocked — alert settings need no SYNAPSE_STORAGE_KEY), so
  // it must be reset between tests.
  "alert_settings",
  // Cell Control Plane (feat/cell-control-plane). cells/cell_resources/
  // deployment_placements would CASCADE from deployments/projects/teams, but
  // hosts (+ host_agents/host_adoption_tokens) are only referenced via
  // ON DELETE SET NULL, so they must be truncated explicitly to keep test
  // isolation clean.
  "deployment_placements",
  "cell_resources",
  "cells",
  "host_adoption_tokens",
  "host_agents",
  "hosts",
  "deployments",
  "project_env_vars",
  "projects",
  "team_invites",
  "team_members",
  "teams",
  "access_tokens",
  "users",
];

export async function truncateAll(): Promise<void> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    // Do not RESTART IDENTITY here. The API process can still have
    // provisioner goroutines finishing jobs from a previous test; reusing
    // provisioning_jobs.id lets those stale goroutines mutate a new job row.
    await client.query(`TRUNCATE ${TABLES.join(", ")} CASCADE`);

    // v1.18 Remote Hosts made deployments.host_id NOT NULL — every
    // deployment now references the host it runs on, and the control-plane
    // self-host row is the implicit default. The synapse server backfills
    // that row at startup (cmd/server/main.go::backfillCells) but a TRUNCATE
    // wipes it; reinsert a matching row here so create_deployment can
    // resolve "(no host_id) → self-host" and direct INSERT seed helpers
    // (dashboard_picker, deployments, embed_unreachable, team_admin) can
    // pick it via `(SELECT id FROM hosts WHERE is_synapse_host LIMIT 1)`.
    await client.query(
      `INSERT INTO hosts (name, provider, region, status, is_synapse_host)
       VALUES ('current-host', 'self-hosted', '', 'online', true)
       ON CONFLICT DO NOTHING`,
    );
  } finally {
    await client.end();
  }
}

export async function listDeploymentNames(): Promise<string[]> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const r = await client.query<{ name: string }>(
      `SELECT name FROM deployments WHERE status <> 'deleted'`,
    );
    return r.rows.map((row) => row.name);
  } finally {
    await client.end();
  }
}
