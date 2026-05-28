-- v1.18.0 Phase 3: persist the per-host SSH private key encrypted at rest.
--
-- install-agent.sh generates an ed25519 keypair on the VPS, installs the
-- pubkey into /home/synapse-deployer/.ssh/authorized_keys, and sends the
-- PRIVKEY content to Synapse central over HTTPS (same trust boundary as
-- adoption_token). Synapse encrypts via crypto.SecretBox (same module +
-- key that encrypts HA Postgres URL) and stores the ciphertext here.
-- Decrypted on demand in-memory when SSHing to the remote host; never
-- logged in plaintext + never returned by the API.
--
-- Per-host key = blast-radius isolation. Compromise of one VPS leaks
-- only that VPS's deployment-management key; other hosts remain safe.
-- Rotation: re-run install-agent.sh --rotate-ssh-key (Phase 4 lifecycle
-- command; v1.18.0 ships re-register-from-scratch as the rotation path).

ALTER TABLE hosts
    ADD COLUMN ssh_privkey_encrypted BYTEA,
    ADD COLUMN ssh_privkey_fingerprint TEXT;

COMMENT ON COLUMN hosts.ssh_privkey_encrypted IS
    'AES-GCM(SecretBox) ciphertext of the per-host SSH ed25519 private key sent by install-agent.sh at register. NULL = legacy host (pre-Remote-Hosts) or self-host.';
COMMENT ON COLUMN hosts.ssh_privkey_fingerprint IS
    'SHA-256 fingerprint of the matching pubkey (`SHA256:base64...`). Operator-visible in the dashboard; safe to log.';
