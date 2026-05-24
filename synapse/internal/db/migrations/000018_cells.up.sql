-- Cell Control Plane — Bloco 1 (feat/cell-control-plane).
--
-- A Cell is an operational unit within a Project. It groups the resources
-- (Convex deployments today) that make up one logical piece of a product:
--   - core           the main user-facing app of the product
--   - runtime         internal execution / processing
--   - integration     connectors / webhooks / syncs
--   - preview         throwaway branch/test environment
--   - enterprise-app  a fully isolated instance for one enterprise customer
--
-- A Cell is NOT a customer and NOT a deployment. A Deployment is a *resource*
-- that lives inside a Cell (via cell_resources, migration 000019). See
-- docs/CELLS.md (added in a later block).
--
-- Authorization piggybacks on the existing team_members / project_members
-- RBAC — a Cell is project-scoped, so whoever can edit the project can
-- create/edit its Cells. No new permission model.
--
-- Additive only: existing deployments/projects keep working untouched.

CREATE TABLE cells (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id               UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    project_id            UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    slug                  CITEXT NOT NULL,
    kind                  TEXT NOT NULL DEFAULT 'core'
                            CHECK (kind IN ('core','runtime','integration','preview','enterprise-app')),
    environment           TEXT NOT NULL DEFAULT 'prod'
                            CHECK (environment IN ('dev','staging','prod','preview')),
    region                TEXT NOT NULL DEFAULT '',
    isolation_tier        TEXT NOT NULL DEFAULT 'shared'
                            CHECK (isolation_tier IN ('shared','premium','dedicated','internal')),
    status                TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','inactive','draining','migrating','maintenance')),
    -- A Cell's primary Convex deployment + the host it runs on. Both
    -- nullable: a runtime/integration Cell can exist before any deployment
    -- is attached (acceptance criterion: "create Cell kind=runtime without a
    -- deployment yet"). ON DELETE SET NULL so deleting a deployment/host
    -- leaves the Cell intact (it just loses its primary pointer).
    primary_deployment_id UUID REFERENCES deployments(id) ON DELETE SET NULL,
    primary_host_id       UUID REFERENCES hosts(id) ON DELETE SET NULL,
    description           TEXT NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Slug is unique within a project (mirrors projects.slug per team). This
    -- is also what makes the startup backfill idempotent at the slug level.
    UNIQUE (project_id, slug)
);

CREATE INDEX cells_project_idx ON cells (project_id);
CREATE INDEX cells_team_idx ON cells (team_id);
CREATE INDEX cells_kind_idx ON cells (kind);
CREATE INDEX cells_environment_idx ON cells (environment);
CREATE INDEX cells_primary_host_idx ON cells (primary_host_id);
CREATE INDEX cells_primary_deployment_idx ON cells (primary_deployment_id);
