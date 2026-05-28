-- v1.18.0+: extend hosts with remote-provisioning fields.
--
-- Pre-v1.18 every Synapse-managed deployment ran on the same host as
-- the Synapse control plane itself (docker run via local /var/run/
-- docker.sock). v1.18 introduces Remote Hosts: operators run
-- install-agent.sh on a VPS, which joins a Headscale-managed tailnet
-- AND configures sshd for forced-command Docker dispatch. Synapse
-- central then provisions Convex containers there over SSH on the
-- tailnet IP.
--
-- New columns:
--   - tailnet_addr: the 100.64.0.0/10 IP Headscale assigned the host.
--   - ssh_pubkey: pubkey the agent registered (ed25519). The matching
--     private key lives on the Synapse control plane host only. This
--     row is the ground truth of WHICH key Synapse should use for
--     this host (we rotate by replacing it on re-adopt).
--   - ssh_user: the dedicated non-root user the agent created
--     (default 'synapse-deployer'). Hardcoded today; column allows
--     forks to customise.
--   - ssh_port: defaults to 22; column allows operators on non-22
--     sshd to configure.
--   - is_remote: false for the self-host (Synapse runs here); true
--     for hosts added via install-agent.sh. Drives provisioner
--     dispatch (local docker socket vs SSH-to-tailnet-IP).
--
-- All columns are nullable / defaulted so existing rows (the
-- self-host inserted by 000017_hosts_agents) stay valid post-
-- migration. Phase 4 will UPDATE is_remote=false on the self-host
-- row explicitly.

ALTER TABLE hosts
    ADD COLUMN tailnet_addr TEXT,
    ADD COLUMN ssh_pubkey   TEXT,
    ADD COLUMN ssh_user     TEXT NOT NULL DEFAULT 'synapse-deployer',
    ADD COLUMN ssh_port     INT  NOT NULL DEFAULT 22,
    ADD COLUMN is_remote    BOOLEAN NOT NULL DEFAULT FALSE;

-- A tailnet IP belongs to AT MOST one host. NULL values are unrestricted
-- so the self-host (no tailnet membership) coexists with remote hosts.
CREATE UNIQUE INDEX hosts_tailnet_addr_uniq
    ON hosts (tailnet_addr)
    WHERE tailnet_addr IS NOT NULL;
