-- Reverse the per-type split: collapse N rows under (project_id, name)
-- back into one with deployment_types[]. LOSSY when post-v1.17.1
-- operators set different values per type for the same name (we keep
-- the first row's value, drop the others) -- the v1.17.1 release notes
-- call this out so operators don't roll back lightly.

ALTER TABLE project_env_vars ADD COLUMN deployment_types TEXT[];

-- Aggregate types per (project_id, name) into the new array column on
-- a single row per group; collect the lexicographically first value.
WITH ranked AS (
  SELECT id,
         project_id,
         name,
         FIRST_VALUE(value) OVER (PARTITION BY project_id, name ORDER BY deployment_type) AS first_value,
         array_agg(deployment_type) OVER (PARTITION BY project_id, name) AS agg_types,
         ROW_NUMBER() OVER (PARTITION BY project_id, name ORDER BY deployment_type) AS rn
    FROM project_env_vars
)
UPDATE project_env_vars pev
   SET value = ranked.first_value,
       deployment_types = ranked.agg_types
  FROM ranked
 WHERE pev.id = ranked.id AND ranked.rn = 1;

-- Delete the duplicate rows we just aggregated into the survivor.
DELETE FROM project_env_vars pev
 WHERE EXISTS (
   SELECT 1 FROM project_env_vars other
    WHERE other.project_id = pev.project_id
      AND other.name = pev.name
      AND other.id <> pev.id
      AND other.deployment_types IS NOT NULL
 );

ALTER TABLE project_env_vars ALTER COLUMN deployment_types SET NOT NULL;
ALTER TABLE project_env_vars ALTER COLUMN deployment_types SET DEFAULT '{dev,prod,preview}';

ALTER TABLE project_env_vars DROP CONSTRAINT project_env_vars_per_type_uniq;
ALTER TABLE project_env_vars DROP CONSTRAINT project_env_vars_dep_type_chk;
ALTER TABLE project_env_vars ADD CONSTRAINT project_env_vars_project_id_name_key UNIQUE (project_id, name);
ALTER TABLE project_env_vars DROP COLUMN deployment_type;
