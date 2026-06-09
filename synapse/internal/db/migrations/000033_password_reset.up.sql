-- v1.25+ — Self-service password reset (forgot-password email flow).
--
-- password_reset_tokens follows the GitHub-PAT storage model used by
-- access_tokens / deploy_keys: the plaintext token (syn_reset_<random>)
-- exists only inside the email link; we persist the SHA-256 hex digest and
-- look it up by unique-index probe. Tokens are single-use (used_at) and
-- short-lived (expires_at, ~1h set by the handler). Rows CASCADE away with
-- the user.
--
-- users.password_changed_at backs refresh-token revocation: refresh JWTs
-- are stateless, so /v1/auth/refresh refuses tokens whose iat predates the
-- last password change instead of consulting a session table. NULL = never
-- changed (every refresh token is fine) — avoids invalidating existing
-- sessions when this migration lands.

CREATE TABLE password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
