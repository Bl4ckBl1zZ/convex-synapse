-- Cell Control Plane — Bloco 1 (feat/cell-control-plane).
--
-- Two layers that connect Cells to concrete resources:
--
--   cell_resources       the LOGICAL membership — "deployment X belongs to
--                        Cell Y as its primary resource". The first-class
--                        resource type is convex_deployment; the rest are
--                        reserved for later blocks.
--
--   deployment_placements the PHYSICAL placement — "deployment X runs on host
--                        Z, here's its container/port/url, and here's the
--                        desired-vs-observed runtime state". This is a layer
--                        ON TOP of the deployments table; it does NOT replace
--                        deployments.container_id / host_port (those stay
--                        authoritative for the existing provisioner + health
--                        worker). Desired/observed reconciliation grows in a
--                        later block — for now the columns exist and the
--                        backfill seeds them from current reality.
--
-- Note on "routes": Synapse already has a Route layer — deployment_domains +
-- the proxy/TLS subsystem. We deliberately do NOT add a new routes table.
-- deployment_placements.route_id is reserved to point at a deployment_domains
-- row later; nullable + no FK for now to avoid coupling during backfill.

CREATE TABLE cell_resources (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cell_id       UUID NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL
                    CHECK (resource_type IN ('convex_deployment','app_route','storage_scope','secrets_scope','worker_pool','custom')),
    -- Opaque reference into the relevant table. For convex_deployment it's
    -- deployments.id (a UUID stored as text). Not FK'd because the target
    -- table varies by resource_type; deletion hygiene for deployments rides
    -- on deployment_placements (ON DELETE CASCADE) + a future reconcile pass.
    resource_id   TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'primary'
                    CHECK (role IN ('primary','secondary','backup','internal')),
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cell_id, resource_type, resource_id)
);

CREATE INDEX cell_resources_cell_idx ON cell_resources (cell_id);

-- A given Convex deployment belongs to at most one Cell. This is the
-- idempotency key the startup backfill checks ("does this deployment already
-- have a Cell?") and what stops attach-deployment from binding the same
-- deployment to two Cells (the handler surfaces the 23505 as a 409).
CREATE UNIQUE INDEX cell_resources_convex_deployment_idx
    ON cell_resources (resource_id)
    WHERE resource_type = 'convex_deployment';

CREATE TABLE deployment_placements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id       UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    cell_id             UUID NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
    -- Nullable: adopted (external) deployments don't run on a host the
    -- control plane manages, so host_id stays NULL for them.
    host_id             UUID REFERENCES hosts(id) ON DELETE SET NULL,
    desired_status      TEXT NOT NULL DEFAULT 'running'
                          CHECK (desired_status IN ('running','stopped','absent')),
    observed_status     TEXT NOT NULL DEFAULT 'unknown'
                          CHECK (observed_status IN ('running','stopped','failed','unknown')),
    docker_container_id TEXT,
    internal_port       INTEGER,
    public_url          TEXT,
    -- Reserved: future link to a deployment_domains row (the existing
    -- custom-domain/proxy layer is the Route concept). Nullable, no FK yet.
    route_id            UUID,
    volume_ref          TEXT,
    last_applied_at     TIMESTAMPTZ,
    last_observed_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One placement per deployment (a deployment runs in exactly one Cell at
    -- a time). Keeps the backfill idempotent and the model simple; moving a
    -- deployment between Cells is an UPDATE, not a second row.
    UNIQUE (deployment_id)
);

CREATE INDEX deployment_placements_deployment_idx ON deployment_placements (deployment_id);
CREATE INDEX deployment_placements_cell_idx ON deployment_placements (cell_id);
CREATE INDEX deployment_placements_host_idx ON deployment_placements (host_id);
