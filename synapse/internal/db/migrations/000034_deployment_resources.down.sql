ALTER TABLE deployments
    DROP COLUMN IF EXISTS cpus,
    DROP COLUMN IF EXISTS memory_mb;
