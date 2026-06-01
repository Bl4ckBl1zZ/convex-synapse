-- v1.22+ — Instance transactional-email settings (Resend), configurable
-- from the dashboard instead of editing .env on the host. The Resend API
-- key is encrypted at rest with the AES-GCM SecretBox (SYNAPSE_STORAGE_KEY)
-- — the same envelope dns_credentials and HA storage secrets use. A stolen
-- DB without the key yields no usable key.
--
-- Singleton: email config is instance-wide, so at most one row exists (the
-- id column is pinned to true via the CHECK). When the row is ABSENT, the
-- .env fallback (SYNAPSE_RESEND_API_KEY + SYNAPSE_EMAIL_FROM) applies; when
-- PRESENT it wins. This lets v1.22.0 .env installs keep working while the
-- dashboard path takes over without a restart.

CREATE TABLE email_settings (
    -- Singleton guard: only id=true is permitted, so the table holds at
    -- most one row. UPSERTs target ON CONFLICT (id).
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id = true),
    -- Whitelist of supported providers; add a value via a follow-up
    -- migration when a new provider lands.
    provider TEXT NOT NULL DEFAULT 'resend' CHECK (provider IN ('resend')),
    api_key_encrypted BYTEA NOT NULL,
    from_address TEXT NOT NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
