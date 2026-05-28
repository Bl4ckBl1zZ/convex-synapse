# installer-agent/test/helpers/load.bash
# shellcheck shell=bash
#
# Sourced from every .bats file in installer-agent/test/. Mirrors
# installer/test/helpers/load.bash but points at the agent installer
# tree:
#
#   INSTALLER_AGENT_DIR        -> installer-agent/
#   INSTALL_AGENT_SCRIPT       -> install-agent.sh at repo root
#   INSTALLER_AGENT_TEMPLATES  -> installer-agent/templates/
#
# The PATH-shadow mock helpers (synapse_mock_setup, mock_cmd, unmock_cmd)
# are intentionally identical to the main installer's so test authors
# moving between trees don't have to context-switch.

bats_load_library bats-support
bats_load_library bats-assert
bats_load_library bats-file

# BATS_TEST_DIRNAME is the dir holding the .bats file. helpers/ lives
# two levels under installer-agent/.
INSTALLER_AGENT_DIR="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
# shellcheck disable=SC2034
REPO_ROOT="$(cd "$INSTALLER_AGENT_DIR/.." && pwd)"
# shellcheck disable=SC2034
INSTALL_AGENT_SCRIPT="$REPO_ROOT/install-agent.sh"
# shellcheck disable=SC2034
INSTALLER_AGENT_TEMPLATES="$INSTALLER_AGENT_DIR/templates"

synapse_mock_setup() {
    SYN_MOCK_BIN="$BATS_TEST_TMPDIR/mock-bin"
    SYN_MOCK_CALLS="$BATS_TEST_TMPDIR/mock-calls"
    mkdir -p "$SYN_MOCK_BIN" "$SYN_MOCK_CALLS"
    PATH="$SYN_MOCK_BIN:$PATH"
}

mock_cmd() {
    local name="$1" rc="${2:-0}" out="${3:-}"
    local out_file="$SYN_MOCK_BIN/.${name}.out"
    if [[ -n "$out" ]]; then
        printf '%s\n' "$out" >"$out_file"
    else
        : >"$out_file"
    fi
    cat >"$SYN_MOCK_BIN/$name" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >>"$SYN_MOCK_CALLS/$name"
cat "$out_file"
exit $rc
EOF
    chmod +x "$SYN_MOCK_BIN/$name"
}

unmock_cmd() {
    rm -f "$SYN_MOCK_BIN/$1" "$SYN_MOCK_BIN/.${1}.out"
}
