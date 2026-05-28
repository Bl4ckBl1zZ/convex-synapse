# installer-agent/install/verify.sh
# shellcheck shell=bash
#
# Post-install verification: poll journalctl until the agent reports
# a successful heartbeat. 30s budget; the agent's heartbeat interval
# is 15s (see synapse/cmd/synapse-agent/main.go: defaultHeartbeatSeconds)
# so we get at most two attempts inside the budget.
#
# The agent logs `heartbeat ok` on success and `heartbeat error: ...`
# on failure (see beat() in synapse-agent/main.go). If the agent's log
# format ever changes, update HEARTBEAT_OK_PATTERN here AND the agent
# in lockstep.
#
# Callers MUST source installer-agent/install/ui.sh first.

# Sentinel string the agent emits on a 2xx heartbeat. Keep in sync with
# synapse/cmd/synapse-agent/main.go:beat().
readonly HEARTBEAT_OK_PATTERN='heartbeat ok'

verify::heartbeat() {
    ui::step "Waiting for synapse-agent heartbeat (up to 30s)"
    local i
    for (( i = 0; i < 30; i++ )); do
        if journalctl -u synapse-agent.service --since '60 seconds ago' --no-pager 2>/dev/null \
                | grep -qF "$HEARTBEAT_OK_PATTERN"; then
            ui::ok "Heartbeat received — host is online in Synapse"
            return 0
        fi
        # Also surface unit failures fast: if synapse-agent.service is
        # in failed state, no number of polls will recover it. Short-
        # circuit so the operator gets a precise error instead of a
        # 30s spinner.
        if systemctl is-failed --quiet synapse-agent.service 2>/dev/null; then
            ui::fail "synapse-agent.service entered failed state — run: journalctl -u synapse-agent -e"
            return 2
        fi
        sleep 1
    done
    ui::fail "No heartbeat received within 30s. Inspect logs: journalctl -u synapse-agent -e"
    return 2
}
