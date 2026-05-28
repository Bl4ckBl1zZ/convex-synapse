# installer-agent/install/ssh.sh
# shellcheck shell=bash
#
# SSH plumbing for the synapse-deployer remote-exec channel.
#
# Public functions:
#   ssh::generate_keypair   -> ed25519 keypair under $INSTALL_DIR; echoes
#                              the public key on stdout (NEVER the private)
#   ssh::configure_sshd     -> sshd_config.d drop-in + sshd -t + reload
#   ssh::install_deployer_exec -> drop the forced-command wrapper into
#                              /usr/local/bin
#   ssh::install_authorized_keys -> write ~$SSH_USER/.ssh/authorized_keys
#                              with the forced-command + restricted clause
#
# Caller invariants (must be set BEFORE sourcing or calling):
#   $INSTALL_DIR                   — agent install dir (default /etc/synapse-agent)
#   $INSTALLER_AGENT_TEMPLATES     — path to installer-agent/templates
#   $SSH_USER                      — deployer username (default synapse-deployer)
#
# Callers MUST source installer-agent/install/ui.sh first.

# ssh::generate_keypair — idempotent ed25519 keypair. The PRIVATE key
# stays on this host (mode 0600) — Synapse central never sees it. We
# echo only the PUBLIC key, which the backend persists in hosts.ssh_pubkey
# (so Synapse central knows whose pubkey signed a connect).
#
# Lives in $INSTALL_DIR/synapse_deployer_ed25519 so the operator can
# rotate by running `--rotate-ssh-key` (Phase 4 lifecycle command).
ssh::generate_keypair() {
    local key_path="$INSTALL_DIR/synapse_deployer_ed25519"
    if [[ -f "$key_path" ]]; then
        ui::ok "Reusing existing SSH key: $key_path"
    else
        install -d -m 0700 "$INSTALL_DIR"
        # -N '' = no passphrase (the wrapper enforces auth, not the key).
        # -C    = comment for `ssh-keygen -l` legibility, NOT a secret.
        ssh-keygen -t ed25519 -N '' -f "$key_path" \
            -C "synapse-deployer@$(hostname 2>/dev/null || echo unknown)" >/dev/null
        chmod 0600 "$key_path"
        chmod 0644 "$key_path.pub"
        ui::ok "Generated SSH ed25519 keypair: $key_path"
    fi
    # Echo pubkey to stdout — NEVER the private key.
    cat "$key_path.pub"
}

# ssh::privkey_content — echo the PEM-encoded private key for the
# synapse-deployer account on stdout. Caller captures the value into
# a jq --arg invocation so the multi-line PEM gets JSON-escaped
# safely (literal "\n" in JSON, not raw newlines that would break
# parsing).
#
# Sent ONCE at register time to Synapse central over HTTPS. The disk
# copy stays at mode 0600 in $INSTALL_DIR so the operator can recover
# / rotate later; thereafter the key lives only encrypted-at-rest on
# Synapse central (crypto.SecretBox, BYTEA column on the hosts row).
#
# NEVER echo this to a log file or terminal beyond the immediate
# curl pipeline — the caller must `unset` any shell variable holding
# the content right after the POST returns.
ssh::privkey_content() {
    local key_path="$INSTALL_DIR/synapse_deployer_ed25519"
    if [[ ! -f "$key_path" ]]; then
        ui::fail "SSH private key missing at $key_path — run ssh::generate_keypair first"
        return 2
    fi
    cat "$key_path"
}

# ssh::configure_sshd <tailnet_ip>
# Render the drop-in with the tailnet IP baked in (informational; sshd
# doesn't bind on it — see template comment), validate sshd config, reload.
ssh::configure_sshd() {
    local tailnet_ip="$1"
    local ssh_user="${SSH_USER:-synapse-deployer}"
    local drop_in=/etc/ssh/sshd_config.d/synapse-deployer.conf
    install -d -m 0755 /etc/ssh/sshd_config.d
    sed \
        -e "s|{{TAILNET_IP}}|$tailnet_ip|g" \
        -e "s|{{SSH_USER}}|$ssh_user|g" \
        "$INSTALLER_AGENT_TEMPLATES/sshd-synapse.conf" > "$drop_in"
    chmod 0644 "$drop_in"
    # Validate config; abort loud if a future template change breaks parsing.
    if ! sshd -t 2>&1; then
        ui::fail "sshd -t rejected $drop_in — refusing to reload sshd"
        return 2
    fi
    # `systemctl reload sshd` works on Debian/Ubuntu (unit is sshd.service);
    # `systemctl reload ssh` on some Debian-derived setups. Try both.
    if systemctl reload sshd >/dev/null 2>&1; then
        :
    elif systemctl reload ssh >/dev/null 2>&1; then
        :
    else
        ui::warn "Could not reload sshd via systemctl — run 'systemctl reload sshd' manually"
    fi
    ui::ok "Configured sshd drop-in: $drop_in"
}

# ssh::install_deployer_exec — drop the forced-command wrapper.
ssh::install_deployer_exec() {
    install -m 0755 \
        "$INSTALLER_AGENT_TEMPLATES/synapse-deployer-exec" \
        /usr/local/bin/synapse-deployer-exec
    ui::ok "Installed /usr/local/bin/synapse-deployer-exec"
}

# ssh::install_authorized_keys <pubkey>
# Write authorized_keys for $SSH_USER with the forced-command + restrict
# clause. Even with a stolen private key, the only thing an attacker can
# do is invoke synapse-deployer-exec, which itself only allows whitelisted
# Docker subcommands.
#
# PHASE 2 NOTE: we don't yet know Synapse central's tailnet IP (the
# agent registers BEFORE the backend tells us where central lives). So
# authorized_keys ships without a `from=` clause — we rely on:
#   (a) forced-command + restrict (no shell, no port-forward),
#   (b) the deployer-exec wrapper's docker-subcommand whitelist,
#   (c) the sshd drop-in (no PTY, no agent-forward, no tunnel).
# Phase 3 will replace this with a `from=<central-tailnet-ip>` clause
# populated from the /v1/agents/register response.
ssh::install_authorized_keys() {
    local pubkey="$1"
    local ssh_user="${SSH_USER:-synapse-deployer}"
    local home="/home/$ssh_user"
    local auth="$home/.ssh/authorized_keys"

    install -d -m 0700 -o "$ssh_user" -g "$ssh_user" "$home/.ssh"
    cat > "$auth" <<EOF
# synapse-deployer pubkey — managed by install-agent.sh, do not edit.
# Forced-command wrapper: every incoming SSH command is replaced with
# /usr/local/bin/synapse-deployer-exec, which enforces a Docker
# subcommand whitelist before exec.
command="/usr/local/bin/synapse-deployer-exec",restrict,no-pty $pubkey
EOF
    chmod 0600 "$auth"
    chown "$ssh_user:$ssh_user" "$auth"
    ui::ok "Authorized synapse-deployer pubkey with forced-command"
}
