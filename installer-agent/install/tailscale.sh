# installer-agent/install/tailscale.sh
# shellcheck shell=bash
#
# Tailscale install + join helpers.
#
# Public functions:
#   tailscale::install                     -> install tailscale via the
#                                             official one-liner (skip
#                                             when --no-tailscale-install
#                                             or already on PATH)
#   tailscale::join SERVER_URL AUTH_KEY    -> `tailscale up` against
#                                             Headscale
#   tailscale::ip                          -> echo the tailnet IPv4
#                                             (empty if not joined yet)
#   tailscale::wait_ready                  -> poll for 100.x.x.x
#                                             assignment from Headscale
#
# Callers MUST source installer-agent/install/ui.sh first.

# tailscale::install — ensure the `tailscale` CLI is on PATH. NO_TAILSCALE_INSTALL=1
# (set when the operator passes --no-tailscale-install) skips the install
# and hard-fails when the binary is missing.
tailscale::install() {
    if command -v tailscale >/dev/null 2>&1; then
        local v
        v="$(tailscale version 2>/dev/null | head -1 || echo unknown)"
        ui::ok "Tailscale already installed: $v"
    elif (( ${NO_TAILSCALE_INSTALL:-0} )); then
        ui::fail "Tailscale not installed and --no-tailscale-install was passed"
        return 2
    else
        ui::step "Installing Tailscale (https://tailscale.com/install.sh)"
        if ! curl -fsSL https://tailscale.com/install.sh | sh; then
            ui::fail "Tailscale install script failed"
            return 2
        fi
        if ! command -v tailscale >/dev/null 2>&1; then
            ui::fail "Tailscale install completed but binary not on PATH"
            return 2
        fi
        ui::ok "Tailscale installed: $(tailscale version 2>/dev/null | head -1 || echo unknown)"
    fi
    # `tailscale up` (tailscale::join) talks to a RUNNING tailscaled.
    # install.sh starts+enables it on a fresh box, but a host where the
    # binary was already present with the daemon STOPPED (reboot without
    # enable, a partial prior install, or a re-adoption after a wipe)
    # makes the join fail "failed to connect to local tailscaled". Ensure
    # the daemon is up + enabled (idempotent) and answering its localapi
    # before join. Best-effort: non-systemd inits fall through and join
    # surfaces the original error.
    if command -v systemctl >/dev/null 2>&1; then
        systemctl enable --now tailscaled >/dev/null 2>&1 || true
        local _i
        for _i in $(seq 1 10); do
            tailscale status 2>&1 | grep -q "failed to connect to local tailscaled" || break
            sleep 1
        done
    fi
    return 0
}

# tailscale::join SERVER_URL AUTH_KEY
# Bring the tailnet up. --reset wipes any prior state so re-running
# install-agent.sh on a host that was previously joined to a different
# tailnet redirects to the new control plane instead of refusing.
# --accept-routes lets this node receive subnet routes advertised by
# other nodes (Synapse central may advertise 10.x.x.x routes later).
# --hostname uses /etc/hostname so the node shows up in Headscale with
# a recognisable name.
#
# Token redaction: --auth-key is NEVER echoed; we log only the server URL
# + hostname. The tailscale binary itself does not log the key.
tailscale::join() {
    local server_url="$1" auth_key="$2"
    local host
    host="$(hostname 2>/dev/null || echo unknown)"
    ui::step "Joining Tailscale tailnet at $server_url (hostname: $host)"
    if ! tailscale up \
            --login-server="$server_url" \
            --auth-key="$auth_key" \
            --accept-routes \
            --hostname="$host" \
            --reset; then
        ui::fail "tailscale up failed (check headscale URL + pre-auth key)"
        return 2
    fi
    ui::ok "Tailscale up against $server_url"
}

# tailscale::ip — echo the IPv4 tailnet address (100.x.x.x), or empty.
tailscale::ip() {
    tailscale ip -4 2>/dev/null | head -1
}

# tailscale::wait_ready — poll for tailnet membership. Headscale typically
# assigns the IP within 1-2 seconds of `tailscale up` succeeding, but a
# slow network can take longer. 15s budget.
#
# Echoes the tailnet IPv4 on stdout when ready.
tailscale::wait_ready() {
    local i addr
    for (( i = 0; i < 15; i++ )); do
        addr="$(tailscale::ip)"
        if [[ -n "$addr" && "$addr" =~ ^100\. ]]; then
            ui::ok "Tailnet IP: $addr"
            printf '%s\n' "$addr"
            return 0
        fi
        sleep 1
    done
    ui::fail "Tailscale didn't get a tailnet IP within 15s"
    return 2
}
