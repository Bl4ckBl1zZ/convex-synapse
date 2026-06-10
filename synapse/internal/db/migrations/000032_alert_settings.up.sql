-- v1.26+ — Instance alert settings, configurable from the dashboard admin
-- area. Drives the health worker's deployment-down notifications: email to
-- the owning team's admins (via the same Resend settings the invite path
-- uses) and/or a generic webhook POST (Slack / Discord / custom receivers).
--
-- Singleton: alerting is instance-wide, so at most one row exists (the id
-- column is pinned to true via the CHECK). When the row is ABSENT the
-- defaults apply: email alerts ON whenever email is configured, webhook
-- from the .env fallback (SYNAPSE_ALERT_WEBHOOK_URL). When PRESENT it wins
-- — same precedence model as email_settings (migration 000028).
--
-- webhook_url is stored in plaintext (it lives in the operator's own DB and
-- alerting must work without SYNAPSE_STORAGE_KEY), but the API only ever
-- returns a masked hint — see AlertSettingsHandler.

CREATE TABLE alert_settings (
    -- Singleton guard: only id=true is permitted, so the table holds at
    -- most one row. UPSERTs target ON CONFLICT (id).
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id = true),
    email_enabled BOOLEAN NOT NULL DEFAULT true,
    webhook_url TEXT NOT NULL DEFAULT '',
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
