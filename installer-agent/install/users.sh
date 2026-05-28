# installer-agent/install/users.sh
# shellcheck shell=bash
#
# Create the two system users install-agent.sh needs:
#
#   synapse-agent     — runs the observer binary (systemd unit). Group
#                       `docker` to read /var/run/docker.sock (ps/inspect
#                       are read-only; the agent never mutates).
#   $SSH_USER         — SSH ForceCommand target ("synapse-deployer" by
#                       default). Receives docker commands over SSH from
#                       Synapse central via the synapse-deployer-exec
#                       wrapper. Has a real $HOME for ~/.ssh/authorized_keys.
#
# Both are idempotent: re-running install-agent.sh on a host that already
# has the users is a no-op (no error).
#
# Callers MUST source installer-agent/install/ui.sh first and set $SSH_USER.

users::ensure() {
    local ssh_user="${SSH_USER:-synapse-deployer}"

    # ----- synapse-agent -----------------------------------------------
    if id synapse-agent >/dev/null 2>&1; then
        ui::ok "User synapse-agent already exists"
    else
        # --system: low uid, no aging.
        # --no-create-home: the agent's state lives in /var/lib/synapse-agent
        #   which we create explicitly with the right ownership.
        # --shell /sbin/nologin: never used for interactive login.
        useradd --system \
            --no-create-home \
            --shell /sbin/nologin \
            --home-dir /var/lib/synapse-agent \
            --user-group \
            synapse-agent
        ui::ok "Created user synapse-agent"
    fi
    # `docker` group may not exist if Docker was installed via snap (rare on
    # server distros, but real); usermod -aG fails in that case — tolerate it,
    # the agent will surface "permission denied on /var/run/docker.sock" at
    # heartbeat time and the operator will fix the group themselves.
    if getent group docker >/dev/null 2>&1; then
        usermod -aG docker synapse-agent
    else
        ui::warn "Docker group missing — synapse-agent won't be able to read docker.sock"
    fi
    install -d -m 0750 -o synapse-agent -g synapse-agent /var/lib/synapse-agent

    # ----- $SSH_USER (synapse-deployer) --------------------------------
    if id "$ssh_user" >/dev/null 2>&1; then
        ui::ok "User $ssh_user already exists"
    else
        # --create-home: needs ~/.ssh/authorized_keys.
        # --shell /bin/bash: ForceCommand still works with a real shell;
        #   sshd execs the forced command instead of $SHELL anyway, but a
        #   real shell makes pubkey-only debugging (`su - synapse-deployer`)
        #   work for the operator.
        useradd --system \
            --create-home \
            --shell /bin/bash \
            --home-dir "/home/$ssh_user" \
            --user-group \
            "$ssh_user"
        ui::ok "Created user $ssh_user"
    fi
    if getent group docker >/dev/null 2>&1; then
        usermod -aG docker "$ssh_user"
    fi
}
