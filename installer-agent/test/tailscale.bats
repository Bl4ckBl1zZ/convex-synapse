#!/usr/bin/env bats
# installer-agent/test/tailscale.bats
#
# Unit tests for installer-agent/install/tailscale.sh.
#
# #9 (v1.21.x 2-VPS smoke): tailscale::install returned early when the
# binary was present and NEVER ensured tailscaled was RUNNING — so a host
# with the binary installed but the daemon stopped (reboot without
# enable, a partial prior install, or a re-adoption after a wipe) failed
# the join with "failed to connect to local tailscaled". install MUST
# ensure the daemon is up + answering before tailscale::join runs.

bats_require_minimum_version 1.5.0

load 'helpers/load'

setup() {
    synapse_mock_setup
    # shellcheck source=../install/ui.sh
    source "$INSTALLER_AGENT_DIR/install/ui.sh"
    # shellcheck source=../install/tailscale.sh
    source "$INSTALLER_AGENT_DIR/install/tailscale.sh"
    UI_NO_COLOR=1
}

@test "tailscale::install: starts tailscaled when binary present but daemon stopped" {
    local calls="$BATS_TEST_TMPDIR/systemctl.calls"
    : >"$calls"
    # tailscale binary present; `status` answers (no "failed to connect")
    # so the daemon-readiness poll breaks immediately.
    cat >"$SYN_MOCK_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  version) echo "1.99.0" ;;
  status)  echo "Logged out." ;;
esac
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/tailscale"
    # systemctl records its argv so we can assert the daemon was enabled.
    cat >"$SYN_MOCK_BIN/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$calls"
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/systemctl"
    run tailscale::install
    [ "$status" -eq 0 ]
    run grep -F "enable --now tailscaled" "$calls"
    [ "$status" -eq 0 ]
}
