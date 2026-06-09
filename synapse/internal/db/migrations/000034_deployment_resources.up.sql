-- v1.25+ — Per-deployment resource limits (the self-hosted answer to
-- Cloud's deployment classes). NULL = unlimited, which is exactly the
-- pre-migration behavior: existing deployments keep running uncapped and
-- nothing is rewritten on upgrade.
--
-- cpus is fractional (0.5 = half a core) and maps to Docker's NanoCPUs
-- (cpus * 1e9); memory_mb maps to Resources.Memory (mb * 1024 * 1024).
-- Limits are applied at container-create time (Provision/Recreate), so a
-- resize goes through the recreate path — plain restarts keep whatever
-- HostConfig the container was created with.

ALTER TABLE deployments
    ADD COLUMN cpus NUMERIC(5,2) CHECK (cpus IS NULL OR (cpus >= 0.1 AND cpus <= 64)),
    ADD COLUMN memory_mb INTEGER CHECK (memory_mb IS NULL OR (memory_mb >= 128 AND memory_mb <= 1048576));
