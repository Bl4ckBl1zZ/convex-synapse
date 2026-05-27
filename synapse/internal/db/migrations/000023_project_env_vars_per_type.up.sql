-- v1.17.1+: split project_env_vars.deployment_types[] into individual
-- rows so different deployment_types can carry different values for
-- the same name (e.g. BETTER_AUTH_SECRET=dev-secret for dev,
-- =prod-secret for prod). Pre-v1.17.1 the UNIQUE(project_id, name)
-- constraint forced one value per name across all selected types --
-- it didn't match the Convex Cloud per-deployment model operators
-- expect, and after v1.17 (function-runtime env-var push) operators
-- hit it immediately on real Better Auth / Stripe setups.
--
-- Migration is additive: add deployment_type column, expand each
-- multi-type row into N rows, swap the UNIQUE constraint, drop the
-- old array column. Backup-restorable via the down migration
-- (collapses N rows back to one with deployment_types built from
-- grouping; lossy when different types carried different values
-- post-v1.17.1, but that's emergency rollback territory).

-- Drop the old constraint first so the expansion INSERT below doesn't
-- collide with itself (multiple rows under the same (project_id, name)
-- become legitimate now).
ALTER TABLE project_env_vars DROP CONSTRAINT IF EXISTS project_env_vars_project_id_name_key;

ALTER TABLE project_env_vars ADD COLUMN deployment_type TEXT;

-- For rows whose old deployment_types array had >1 entries, INSERT
-- N-1 copies (one per extra type). The slice [2:] skips the first
-- entry -- the original row will be updated to carry that one below.
INSERT INTO project_env_vars (project_id, name, value, deployment_types, deployment_type, updated_at)
SELECT project_id, name, value, '{}'::TEXT[], t, updated_at
  FROM project_env_vars,
       LATERAL unnest(deployment_types[2:array_length(deployment_types, 1)]) AS t
 WHERE array_length(deployment_types, 1) > 1
   AND deployment_type IS NULL;

-- Every row (original + extras above) now needs deployment_type set
-- from the first entry of its array (or the only entry, for rows that
-- had a single-type array). The extras we just INSERTed already have
-- the column populated via SELECT -- so this UPDATE only touches the
-- pre-existing rows. NULL guards either side.
UPDATE project_env_vars
   SET deployment_type = deployment_types[1]
 WHERE deployment_type IS NULL;

ALTER TABLE project_env_vars ALTER COLUMN deployment_type SET NOT NULL;
ALTER TABLE project_env_vars ADD CONSTRAINT project_env_vars_dep_type_chk
    CHECK (deployment_type IN ('dev', 'prod', 'preview', 'custom'));

ALTER TABLE project_env_vars ADD CONSTRAINT project_env_vars_per_type_uniq
    UNIQUE (project_id, name, deployment_type);

ALTER TABLE project_env_vars DROP COLUMN deployment_types;
