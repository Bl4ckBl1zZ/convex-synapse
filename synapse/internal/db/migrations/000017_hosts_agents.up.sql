-- Cell Control Plane — Bloco 1 (feat/cell-control-plane).
--
-- Hosts model the physical/virtual machines (VPSs) the control plane knows
-- about. Today Synapse runs on exactly one VPS and topology.go synthesises a
-- single "host" card from env + geo. These tables turn that synthetic host
-- real and make room for agent-adopted VPSs in a later block.
--
-- IMPORTANT: this migration is purely additive. It does not touch the
-- existing deployments / projects / teams tables, so every current
-- deployment keeps working unchanged.

-- ============================================================
-- hosts — a machine the control plane can place deployments on
-- ============================================================

CREATE TABLE hosts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    provider        TEXT NOT NULL DEFAULT 'unknown',
    region          TEXT NOT NULL DEFAULT '',
    public_ip       TEXT,
    private_ip      TEXT,
    -- Free-form operator labels (e.g. {"tier":"prod","rack":"a1"}).
    labels          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (status IN ('online','offline','draining','unknown')),
    agent_version   TEXT,
    docker_version  TEXT,
    cpu_cores       INTEGER,
    memory_mb       BIGINT,
    disk_gb         BIGINT,
    -- is_synapse_host marks THE host the control plane process itself runs
    -- on. The startup backfill upserts exactly one such row; the partial
    -- unique index below guarantees there is never more than one. This is
    -- what topology.go's synthetic "isPrimary" host becomes (Bloco 8).
    is_synapse_host BOOLEAN NOT NULL DEFAULT false,
    last_heartbeat_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (name)
);

CREATE INDEX hosts_status_idx ON hosts (status);
CREATE INDEX hosts_last_heartbeat_idx ON hosts (last_heartbeat_at);
CREATE UNIQUE INDEX hosts_one_synapse_host_idx ON hosts (is_synapse_host) WHERE is_synapse_host;

-- ============================================================
-- host_agents — the agent process running on a host
-- ============================================================
--
-- The synapse-agent binary itself lands in a later block (Bloco 6, Go,
-- synapse/cmd/synapse-agent). We model the table + the adoption-token flow
-- now so the DB/API are agent-ready. token_hash is the sha256 of an opaque
-- bearer the agent presents on every call; the plaintext is shown once at
-- registration and never stored.

CREATE TABLE host_agents (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id                UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    name                   TEXT NOT NULL DEFAULT '',
    token_hash             TEXT NOT NULL UNIQUE,
    status                 TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','online','offline','revoked')),
    connection_mode        TEXT NOT NULL DEFAULT 'polling'
                             CHECK (connection_mode IN ('polling','websocket')),
    last_seen_at           TIMESTAMPTZ,
    last_heartbeat_payload JSONB,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX host_agents_host_idx ON host_agents (host_id);

-- ============================================================
-- host_adoption_tokens — short-lived join credentials for a VPS
-- ============================================================
--
-- An operator mints one of these, then runs on the VPS:
--   synapse-agent join --control-url https://… --token <token>
-- The token is hashed at rest (GitHub-PAT model); shown once at creation.
-- host_id is nullable so a token can be minted before the host row exists
-- (the agent's first contact creates it) OR bound to a pre-created host.

CREATE TABLE host_adoption_tokens (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id            UUID REFERENCES hosts(id) ON DELETE CASCADE,
    token_hash         TEXT NOT NULL UNIQUE,
    name               TEXT NOT NULL DEFAULT '',
    expires_at         TIMESTAMPTZ,
    used_at            TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX host_adoption_tokens_host_idx ON host_adoption_tokens (host_id);
CREATE INDEX host_adoption_tokens_expires_idx ON host_adoption_tokens (expires_at);
