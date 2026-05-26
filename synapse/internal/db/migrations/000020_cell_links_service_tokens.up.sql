-- Cell Control Plane — Bloco 7 (feat/cell-control-plane).
--
-- The service-to-service CONTRACT layer between Cells. This records *which*
-- Cells may talk, over *what* protocol, with *which* commands/events allowed,
-- and the credentials (service tokens) for that channel. It does NOT transport
-- any command payload — Synapse only registers + protects the channel.
--
-- A CellLink is intra-project for now (source + target in the same project);
-- the handler enforces that. Additive only.

CREATE TABLE cell_links (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id          UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_cell_id   UUID NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
    target_cell_id   UUID NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
    protocol         TEXT NOT NULL DEFAULT 'outbox'
                       CHECK (protocol IN ('http','convex_action','outbox','webhook','polling')),
    auth_mode        TEXT NOT NULL DEFAULT 'service_token'
                       CHECK (auth_mode IN ('service_token','mtls','none')),
    -- The contract surface. text[] (not jsonb) mirrors project_env_vars
    -- .deployment_types — pgx maps []string ↔ text[] natively.
    allowed_commands TEXT[] NOT NULL DEFAULT '{}',
    allowed_events   TEXT[] NOT NULL DEFAULT '{}',
    status           TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','disabled')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A Cell can't link to itself.
    CHECK (source_cell_id <> target_cell_id)
);

CREATE INDEX cell_links_source_idx ON cell_links (source_cell_id);
CREATE INDEX cell_links_target_idx ON cell_links (target_cell_id);
CREATE INDEX cell_links_project_idx ON cell_links (project_id);
-- At most one ACTIVE link per (source, target, protocol). Disabling a link
-- frees the slot so a fresh one can be created. The create handler surfaces
-- the 23505 as a 409 link_already_exists.
CREATE UNIQUE INDEX cell_links_active_uniq
    ON cell_links (source_cell_id, target_cell_id, protocol)
    WHERE status = 'active';

-- service_tokens: credentials for one CellLink. Stored as sha256 only
-- (token_hash); the plaintext syn_svc_ token is shown once at creation. Used
-- to authenticate the discovery endpoint as the link's source cell.
CREATE TABLE service_tokens (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cell_link_id   UUID NOT NULL REFERENCES cell_links(id) ON DELETE CASCADE,
    -- Denormalised from the link for cheap discovery lookups (the token
    -- authenticates AS source_cell_id). Kept in sync at create time; links
    -- are immutable on these columns.
    source_cell_id UUID NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
    target_cell_id UUID NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
    name           TEXT NOT NULL DEFAULT '',
    token_hash     TEXT NOT NULL UNIQUE,
    scopes         TEXT[] NOT NULL DEFAULT '{}',
    status         TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','revoked','expired')),
    expires_at     TIMESTAMPTZ,
    last_used_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX service_tokens_link_idx ON service_tokens (cell_link_id);
CREATE INDEX service_tokens_source_idx ON service_tokens (source_cell_id);
