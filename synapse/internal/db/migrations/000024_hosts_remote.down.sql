DROP INDEX IF EXISTS hosts_tailnet_addr_uniq;
ALTER TABLE hosts
    DROP COLUMN IF EXISTS is_remote,
    DROP COLUMN IF EXISTS ssh_port,
    DROP COLUMN IF EXISTS ssh_user,
    DROP COLUMN IF EXISTS ssh_pubkey,
    DROP COLUMN IF EXISTS tailnet_addr;
