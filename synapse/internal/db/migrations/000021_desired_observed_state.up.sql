-- Cell Control Plane — Bloco 9 (feat/cell-control-plane).
--
-- The intention / observation / drift / operation layer. This block MODELS,
-- OBSERVES, COMPARES, and PLANS — it never APPLIES anything to a host. All six
-- tables are created here; Bloco 9a wires desired_states / observed_states /
-- operation_runs, and 9b wires drift_reports / drift_items / operation_steps.
--
-- Additive only. No secrets are stored in desired_json / observed_json /
-- diff_json (the writers redact env vars, admin keys, DB URLs, tokens).

-- ============================================================
-- desired_states — what Synapse WANTS to exist on a host
-- ============================================================
CREATE TABLE desired_states (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID REFERENCES teams(id) ON DELETE CASCADE,
    project_id         UUID REFERENCES projects(id) ON DELETE CASCADE,
    cell_id            UUID REFERENCES cells(id) ON DELETE SET NULL,
    host_id            UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    resource_type      TEXT NOT NULL,
    resource_id        TEXT,
    -- Stable, human-readable key, e.g. "convex_deployment:<deploymentId>".
    resource_key       TEXT NOT NULL,
    desired_json       JSONB NOT NULL,
    -- Deterministic sha256 of the canonical desired_json; only changes when
    -- the desired payload actually changes (drives idempotent versioning).
    desired_hash       TEXT NOT NULL,
    version            INTEGER NOT NULL DEFAULT 1,
    status             TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','superseded','disabled')),
    source             TEXT NOT NULL DEFAULT 'placement'
                         CHECK (source IN ('placement','route','manual','system','imported')),
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX desired_states_host_idx ON desired_states (host_id);
CREATE INDEX desired_states_project_idx ON desired_states (project_id);
CREATE INDEX desired_states_cell_idx ON desired_states (cell_id);
-- At most one ACTIVE desired state per (host, resource_type, resource_key).
CREATE UNIQUE INDEX desired_states_active_uniq
    ON desired_states (host_id, resource_type, resource_key) WHERE status = 'active';

-- ============================================================
-- observed_states — what the agent REPORTED exists on a host
-- ============================================================
CREATE TABLE observed_states (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id       UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    agent_id      UUID REFERENCES host_agents(id) ON DELETE SET NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT,
    resource_key  TEXT NOT NULL,
    observed_json JSONB NOT NULL,
    observed_hash TEXT NOT NULL,
    observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    source        TEXT NOT NULL DEFAULT 'agent'
                    CHECK (source IN ('agent','server','import')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Exactly one current observed state per (host, resource_type, key); the
    -- heartbeat upserts via ON CONFLICT on this constraint.
    UNIQUE (host_id, resource_type, resource_key)
);
CREATE INDEX observed_states_host_idx ON observed_states (host_id);

-- ============================================================
-- operation_runs — audit-grade tracking of Synapse operations
-- ============================================================
CREATE TABLE operation_runs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type               TEXT NOT NULL,
    team_id            UUID REFERENCES teams(id) ON DELETE SET NULL,
    project_id         UUID REFERENCES projects(id) ON DELETE SET NULL,
    cell_id            UUID REFERENCES cells(id) ON DELETE SET NULL,
    host_id            UUID REFERENCES hosts(id) ON DELETE SET NULL,
    deployment_id      UUID REFERENCES deployments(id) ON DELETE SET NULL,
    status             TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    input_json         JSONB,
    plan_json          JSONB,
    result_json        JSONB,
    error              TEXT,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    started_at         TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operation_runs_project_idx ON operation_runs (project_id, created_at DESC);
CREATE INDEX operation_runs_host_idx ON operation_runs (host_id, created_at DESC);

-- ============================================================
-- operation_steps — planned/executed steps of an operation (9b)
-- ============================================================
CREATE TABLE operation_steps (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_run_id UUID NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
    step_index       INTEGER NOT NULL,
    action           TEXT NOT NULL,
    resource_type    TEXT NOT NULL,
    resource_key     TEXT NOT NULL,
    -- In Bloco 9 steps are only planned / skipped / no_op — never executed.
    status           TEXT NOT NULL DEFAULT 'planned'
                       CHECK (status IN ('planned','skipped','no_op','succeeded','failed')),
    reason           TEXT,
    input_json       JSONB,
    result_json      JSONB,
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operation_steps_run_idx ON operation_steps (operation_run_id, step_index);

-- ============================================================
-- drift_reports / drift_items — desired-vs-observed diff (9b)
-- ============================================================
CREATE TABLE drift_reports (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id          UUID REFERENCES hosts(id) ON DELETE CASCADE,
    project_id       UUID REFERENCES projects(id) ON DELETE CASCADE,
    cell_id          UUID REFERENCES cells(id) ON DELETE SET NULL,
    operation_run_id UUID REFERENCES operation_runs(id) ON DELETE SET NULL,
    status           TEXT NOT NULL DEFAULT 'clean'
                       CHECK (status IN ('clean','drifted','warning','failed')),
    summary_json     JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX drift_reports_host_idx ON drift_reports (host_id, created_at DESC);
CREATE INDEX drift_reports_project_idx ON drift_reports (project_id, created_at DESC);

CREATE TABLE drift_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    drift_report_id    UUID NOT NULL REFERENCES drift_reports(id) ON DELETE CASCADE,
    host_id            UUID REFERENCES hosts(id) ON DELETE SET NULL,
    cell_id            UUID REFERENCES cells(id) ON DELETE SET NULL,
    resource_type      TEXT NOT NULL,
    resource_key       TEXT NOT NULL,
    desired_state_id   UUID REFERENCES desired_states(id) ON DELETE SET NULL,
    observed_state_id  UUID REFERENCES observed_states(id) ON DELETE SET NULL,
    drift_status       TEXT NOT NULL
                         CHECK (drift_status IN ('in_sync','missing','drifted','unmanaged','orphaned','host_unreachable','ignored')),
    severity           TEXT NOT NULL DEFAULT 'info'
                         CHECK (severity IN ('info','warning','critical')),
    diff_json          JSONB,
    recommended_action TEXT NOT NULL DEFAULT 'none'
                         CHECK (recommended_action IN ('none','create','update','restart','stop','remove','investigate')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX drift_items_report_idx ON drift_items (drift_report_id);
