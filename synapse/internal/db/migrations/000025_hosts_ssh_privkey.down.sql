ALTER TABLE hosts
    DROP COLUMN IF EXISTS ssh_privkey_fingerprint,
    DROP COLUMN IF EXISTS ssh_privkey_encrypted;
