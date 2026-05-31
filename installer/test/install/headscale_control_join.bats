#!/usr/bin/env bats
# installer/test/install/headscale_control_join.bats
#
# v1.19.9 — control-plane tailnet join hardening. A real two-VPS smoke
# exposed three bugs the bats suite couldn't see before (it never boots
# a real Headscale / Caddy / tailscaled):
#
#   - bootstrap ran `join_control_plane` BEFORE installing the Caddy
#     headscale block, so the control plane's own `tailscale up` raced a
#     Caddy that wasn't yet routing headscale.<domain> and hung.
#   - the refuse-clobber guard fired on ANY 100.x IP, mislabeling a
#     half-joined control plane as "a different control plane".
#   - the control plane couldn't reach its OWN public IP (NAT hairpin),
#     so the map-poll failed and the node stayed offline.
#
# These tests pin the fixed contract: ordering, slash-normalized
# login-server matching, the 100.x fallback, and the /etc/hosts pin.

bats_require_minimum_version 1.5.0

load '../helpers/load'

setup() {
    synapse_mock_setup
    # shellcheck source=../../install/ui.sh
    source "$INSTALLER_DIR/install/ui.sh"
    # shellcheck source=../../install/secrets.sh
    source "$INSTALLER_DIR/install/secrets.sh"
    # shellcheck source=../../lib/detect.sh
    source "$INSTALLER_DIR/lib/detect.sh"
    # shellcheck source=../../install/caddy.sh
    source "$INSTALLER_DIR/install/caddy.sh"
    # shellcheck source=../../install/headscale.sh
    source "$INSTALLER_DIR/install/headscale.sh"
    UI_NO_COLOR=1
    INSTALLER_TEMPLATES="$INSTALLER_DIR/templates"
    export INSTALLER_TEMPLATES
}

# ---- _current_login_server -----------------------------------------

@test "_current_login_server: parses LoginServer and trims trailing slash" {
    cat >"$SYN_MOCK_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "status --json" ]] && echo '{"CurrentTailnet":{"LoginServer":"https://headscale.example.com/"}}'
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/tailscale"
    run headscale::_current_login_server
    [ "$status" -eq 0 ]
    [ "$output" = "https://headscale.example.com" ]
}

@test "_current_login_server: empty when status JSON omits the field" {
    cat >"$SYN_MOCK_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "status --json" ]] && echo '{}'
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/tailscale"
    run headscale::_current_login_server
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

# ---- _control_already_joined ---------------------------------------

@test "_control_already_joined: true when bound server matches (slash-normalized)" {
    cat >"$SYN_MOCK_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "status --json" ]] && echo '{"CurrentTailnet":{"LoginServer":"https://hs.example.com/"}}'
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/tailscale"
    run headscale::_control_already_joined "https://hs.example.com"
    [ "$status" -eq 0 ]
}

@test "_control_already_joined: false when bound to a DIFFERENT server" {
    cat >"$SYN_MOCK_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "status --json" ]] && echo '{"CurrentTailnet":{"LoginServer":"https://other.example.com"}}'
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/tailscale"
    run headscale::_control_already_joined "https://hs.example.com"
    [ "$status" -ne 0 ]
}

@test "_control_already_joined: falls back to 100.x membership when login-server unreadable" {
    # The exact case that mislabeled a freshly-joined control plane:
    # status JSON can't tell us the login-server (node mid-connect /
    # offline) but a 100.x IP is present → treat as already a member.
    cat >"$SYN_MOCK_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "status --json") echo '{}' ;;
  "ip -4")         echo "100.64.0.2" ;;
esac
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/tailscale"
    run headscale::_control_already_joined "https://hs.example.com"
    [ "$status" -eq 0 ]
}

# ---- _ensure_local_hosts_entry (NAT hairpin workaround) ------------

@test "_ensure_local_hosts_entry: pins host to 127.0.0.1 and is idempotent" {
    local hf="$BATS_TEST_TMPDIR/hosts"
    : >"$hf"
    SYNAPSE_HOSTS_FILE="$hf" headscale::_ensure_local_hosts_entry "https://hs.example.com"
    run grep -cE '^127\.0\.0\.1[[:space:]]+hs\.example\.com' "$hf"
    [ "$output" = "1" ]
    # Re-run: no duplicate line.
    SYNAPSE_HOSTS_FILE="$hf" headscale::_ensure_local_hosts_entry "https://hs.example.com"
    run grep -cE '^127\.0\.0\.1[[:space:]]+hs\.example\.com' "$hf"
    [ "$output" = "1" ]
}

@test "_ensure_local_hosts_entry: NO-OP for a non-https (no-TLS) server URL" {
    local hf="$BATS_TEST_TMPDIR/hosts"
    : >"$hf"
    SYNAPSE_HOSTS_FILE="$hf" headscale::_ensure_local_hosts_entry "http://1.2.3.4:8080"
    [ ! -s "$hf" ]
}

# ---- bootstrap ordering (the headline v1.19.9 fix) -----------------

@test "bootstrap: installs the Caddy headscale block BEFORE joining the control plane" {
    # Record the order the two steps run in. The join's `tailscale up`
    # needs Caddy already fronting headscale.<domain>; running the join
    # first (pre-1.19.9) hung the control plane on the control-key fetch.
    local order="$BATS_TEST_TMPDIR/order"
    : >"$order"
    eval 'headscale::_resolve_server_url() { printf "https://headscale.example.com"; }'
    eval 'secrets::set_env_var() { :; }'
    eval 'secrets::ensure_env_var() { :; }'
    eval 'secrets::env_get() { :; }'
    eval 'headscale::ensure_database() { :; }'
    eval 'headscale::render_config() { :; }'
    eval 'headscale::_start() { :; }'
    eval 'headscale::_wait_healthy() { :; }'
    eval 'headscale::ensure_user() { :; }'
    eval 'headscale::ensure_api_key() { :; }'
    eval "caddy::install_headscale_block() { echo caddy >>'$order'; }"
    eval "headscale::join_control_plane() { echo join >>'$order'; }"
    INSTALL_DIR="$BATS_TEST_TMPDIR" run headscale::bootstrap
    [ "$status" -eq 0 ]
    run cat "$order"
    [ "${lines[0]}" = "caddy" ]
    [ "${lines[1]}" = "join" ]
}

@test "bootstrap: SYNAPSE_SKIP_CONTROL_TAILSCALE=1 skips the join but still installs Caddy" {
    local order="$BATS_TEST_TMPDIR/order"
    : >"$order"
    eval 'headscale::_resolve_server_url() { printf "https://headscale.example.com"; }'
    eval 'secrets::set_env_var() { :; }'
    eval 'secrets::ensure_env_var() { :; }'
    eval 'secrets::env_get() { :; }'
    eval 'headscale::ensure_database() { :; }'
    eval 'headscale::render_config() { :; }'
    eval 'headscale::_start() { :; }'
    eval 'headscale::_wait_healthy() { :; }'
    eval 'headscale::ensure_user() { :; }'
    eval 'headscale::ensure_api_key() { :; }'
    eval "caddy::install_headscale_block() { echo caddy >>'$order'; }"
    eval "headscale::join_control_plane() { echo join >>'$order'; }"
    SYNAPSE_SKIP_CONTROL_TAILSCALE=1 INSTALL_DIR="$BATS_TEST_TMPDIR" run headscale::bootstrap
    [ "$status" -eq 0 ]
    run grep -c caddy "$order"
    [ "$output" = "1" ]
    run grep -c join "$order"
    [ "$output" = "0" ]
}

# ---- _install_tailscale ensures tailscaled is running (#9) ----------

@test "_install_tailscale: starts tailscaled when binary present but daemon stopped" {
    # Regression for the v1.21.x 2-VPS smoke: a host with the tailscale
    # binary already installed but tailscaled STOPPED (reboot without
    # enable, partial prior install, a reconfigure after a wipe) made
    # join_control_plane's `tailscale up` fail "failed to connect to
    # local tailscaled". _install_tailscale must ensure the daemon is up.
    local calls="$BATS_TEST_TMPDIR/systemctl.calls"
    : >"$calls"
    cat >"$SYN_MOCK_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  version) echo "1.99.0" ;;
  status)  echo "Logged out." ;;
esac
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/tailscale"
    cat >"$SYN_MOCK_BIN/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$calls"
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/systemctl"
    run headscale::_install_tailscale
    [ "$status" -eq 0 ]
    run grep -F "enable --now tailscaled" "$calls"
    [ "$status" -eq 0 ]
}
