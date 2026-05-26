-- v-site-origin — allow role='site' on deployment_domains.
--
-- A 'site' custom domain routes at the deployment's site proxy (Convex
-- port 3211, where HTTP actions live at their natural paths) instead of
-- the cloud listener (port 3210, role='api'). This is what unblocks an
-- app whose Better Auth / webhooks live on the site origin. See
-- docs/CONVEX_SITE_ORIGIN.md.
--
-- Additive: widens the existing CHECK to include 'site'. No data
-- migration needed — every existing row is 'api'/'dashboard' and stays
-- valid. The constraint name is the Postgres-generated default for the
-- inline CHECK created in migration 000012.
ALTER TABLE deployment_domains
    DROP CONSTRAINT deployment_domains_role_check,
    ADD CONSTRAINT deployment_domains_role_check
        CHECK (role IN ('api', 'dashboard', 'site'));
