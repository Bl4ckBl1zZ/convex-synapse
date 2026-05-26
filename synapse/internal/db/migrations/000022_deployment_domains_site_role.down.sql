-- Revert to the api/dashboard-only CHECK. Remove any 'site' rows first
-- so the narrower constraint can be re-added (idempotent rollback).
DELETE FROM deployment_domains WHERE role = 'site';

ALTER TABLE deployment_domains
    DROP CONSTRAINT deployment_domains_role_check,
    ADD CONSTRAINT deployment_domains_role_check
        CHECK (role IN ('api', 'dashboard'));
