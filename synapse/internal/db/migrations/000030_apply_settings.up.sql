-- v1.23+ — Instance Cell-Control-Plane APPLY settings, toggleable from the
-- dashboard instead of editing .env + restarting the host.
--
-- Singleton (id pinned to true via CHECK): apply config is instance-wide.
-- When the row is ABSENT the .env fallback (SYNAPSE_APPLY_ENABLED /
-- SYNAPSE_APPLY_DANGEROUS) applies; when PRESENT it wins. So a fresh install
-- keeps its env defaults, and the dashboard toggle takes over without a
-- restart — mirrors the email_settings (000028) pattern.
--
-- apply_dangerous gates Phase-2 stop/remove; it stays here for completeness
-- but the executor + apply handler still refuse those actions in this build.

CREATE TABLE apply_settings (
    id              BOOLEAN PRIMARY KEY DEFAULT true CHECK (id = true),
    apply_enabled   BOOLEAN NOT NULL DEFAULT false,
    apply_dangerous BOOLEAN NOT NULL DEFAULT false,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
