-- v1.19.0 — extend admin_jobs.kind to include 'configure_headscale'.
--
-- v1.4 introduced admin_jobs with kind='reconfigure_host_domain' for the
-- /v1/admin/host_domain flow. v1.19 adds a second host-side job kind so
-- the dashboard can drive Headscale / Remote Hosts enablement from
-- Admin → Remote Hosts without the operator SSH'ing to the box.
--
-- The synapse-updater daemon dispatches each kind to the matching
-- setup.sh entry point (--reconfigure for host_domain;
-- --configure-headscale for headscale). Daemon-side dispatcher also
-- whitelists the same set, so a row with an unknown kind goes nowhere.

ALTER TABLE admin_jobs DROP CONSTRAINT IF EXISTS admin_jobs_kind_check;

ALTER TABLE admin_jobs
    ADD CONSTRAINT admin_jobs_kind_check
    CHECK (kind IN ('reconfigure_host_domain', 'configure_headscale'));
