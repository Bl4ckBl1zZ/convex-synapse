#!/usr/bin/env bats
#
# Smoke tests for install-agent.sh — the v1.18 Remote Hosts one-liner.
#
# Strategy mirrors installer/test/install/setup.bats: don't try to
# bring up a real tailnet / Tailscale install / SSH daemon (way too
# slow and DinD-flaky for unit CI). Exercise the parts that ARE
# testable in isolation:
#   - --help / --version output
#   - parse_flags branches
#   - missing-flag errors in --non-interactive mode
#   - bash -n + shellcheck cleanliness of every shipped .sh
#
# End-to-end install gets exercised by the real-VPS smoke run on PRs
# touching this tree.

bats_require_minimum_version 1.5.0

load 'helpers/load'

setup() {
    synapse_mock_setup
    [ -x "$INSTALL_AGENT_SCRIPT" ]
}

# ---- --version / --help / unknown flag -----------------------------

@test "install-agent.sh --version: prints installer version" {
    run "$INSTALL_AGENT_SCRIPT" --version
    assert_success
    assert_output --partial "install-agent.sh"
    # Match X.Y.Z without pinning a specific value — tracking
    # INSTALL_AGENT_VERSION here would just churn on every release.
    assert_output --regexp '[0-9]+\.[0-9]+\.[0-9]+'
}

@test "install-agent.sh --help: lists every flag" {
    run "$INSTALL_AGENT_SCRIPT" --help
    assert_success
    assert_output --partial "--control-url"
    assert_output --partial "--headscale-auth"
    assert_output --partial "--adoption-token"
    assert_output --partial "--agent-version"
    assert_output --partial "--install-dir"
    assert_output --partial "--ssh-user"
    assert_output --partial "--no-tailscale-install"
    assert_output --partial "--non-interactive"
    assert_output --partial "--no-bootstrap"
}

@test "install-agent.sh unknown flag -> exit 2 + usage on stderr" {
    run --separate-stderr "$INSTALL_AGENT_SCRIPT" --not-a-real-flag
    assert_failure 2
    [[ "$stderr" == *"unknown flag"* ]]
}

# ---- missing-flag handling -----------------------------------------
#
# In --non-interactive mode any of the three required secrets being
# absent must hard-fail with a precise message before we ever touch
# the network. We pass --no-bootstrap so the curl|bash detection
# doesn't try to clone the repo on a CI runner without git.

@test "no flags + --non-interactive -> missing --control-url" {
    run --separate-stderr "$INSTALL_AGENT_SCRIPT" --no-bootstrap --non-interactive
    assert_failure 2
    [[ "$stderr" == *"missing required flag --control-url"* ]]
}

@test "--control-url only + --non-interactive -> missing --headscale-auth" {
    run --separate-stderr "$INSTALL_AGENT_SCRIPT" \
        --no-bootstrap --non-interactive \
        --control-url=https://example.com
    assert_failure 2
    [[ "$stderr" == *"missing required flag --headscale-auth"* ]]
}

@test "--control-url + --headscale-auth + --non-interactive -> missing --adoption-token" {
    run --separate-stderr "$INSTALL_AGENT_SCRIPT" \
        --no-bootstrap --non-interactive \
        --control-url=https://example.com \
        --headscale-auth=tskey-secret
    assert_failure 2
    [[ "$stderr" == *"missing required flag --adoption-token"* ]]
}

# ---- parse_flags exposure under __SETUP_NO_MAIN --------------------

@test "source: __SETUP_NO_MAIN skips main, exposes helpers" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        type parse_flags >/dev/null
        type usage >/dev/null
        type on_err >/dev/null
        type on_exit >/dev/null
        type acquire_lock >/dev/null
        type needs_bootstrap >/dev/null
        type bootstrap >/dev/null
        echo OK
    "
    assert_success
    assert_output --partial "OK"
}

@test "parse_flags: --control-url= sets CONTROL_URL" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        parse_flags --control-url=https://synapse.example.com/
        echo \"CONTROL_URL=\$CONTROL_URL\"
    "
    assert_success
    # Trailing slash is stripped so /v1/... appends cleanly.
    assert_output --partial "CONTROL_URL=https://synapse.example.com"
}

@test "parse_flags: --install-dir= overrides default" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        parse_flags --install-dir=/var/lib/synapse-agent
        echo \"DIR=\$INSTALL_DIR\"
    "
    assert_success
    assert_output --partial "DIR=/var/lib/synapse-agent"
}

@test "parse_flags: --ssh-user= overrides default" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        parse_flags --ssh-user=deploy
        echo \"USER=\$SSH_USER\"
    "
    assert_success
    assert_output --partial "USER=deploy"
}

@test "parse_flags: --no-tailscale-install sets flag" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        parse_flags --no-tailscale-install
        echo \"NTI=\$NO_TAILSCALE_INSTALL\"
    "
    assert_success
    assert_output --partial "NTI=1"
}

@test "parse_flags: --no-bootstrap sets NO_BOOTSTRAP=1" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        parse_flags --no-bootstrap
        echo \"NB=\$NO_BOOTSTRAP\"
    "
    assert_success
    assert_output --partial "NB=1"
}

@test "parse_flags: defaults are sensible" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        parse_flags
        echo \"DIR=\$INSTALL_DIR USER=\$SSH_USER NTI=\$NO_TAILSCALE_INSTALL NB=\$NO_BOOTSTRAP\"
    "
    assert_success
    assert_output --partial "DIR=/etc/synapse-agent"
    assert_output --partial "USER=synapse-deployer"
    assert_output --partial "NTI=0"
    assert_output --partial "NB=0"
}

# ---- bootstrap detection -------------------------------------------

@test "needs_bootstrap: false when installer-agent/ exists alongside" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        if needs_bootstrap '$REPO_ROOT'; then
            echo BOOTSTRAP_NEEDED
        else
            echo BOOTSTRAP_SKIPPED
        fi
    "
    assert_success
    assert_output --partial "BOOTSTRAP_SKIPPED"
}

@test "needs_bootstrap: true when installer-agent/ is missing" {
    local empty_dir="$BATS_TEST_TMPDIR/no-installer-agent"
    mkdir -p "$empty_dir"
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        if needs_bootstrap '$empty_dir'; then
            echo BOOTSTRAP_NEEDED
        else
            echo BOOTSTRAP_SKIPPED
        fi
    "
    assert_success
    assert_output --partial "BOOTSTRAP_NEEDED"
}

@test "needs_bootstrap: true for empty-string dir (curl|bash case)" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        if needs_bootstrap ''; then
            echo BOOTSTRAP_NEEDED
        else
            echo BOOTSTRAP_SKIPPED
        fi
    "
    assert_success
    assert_output --partial "BOOTSTRAP_NEEDED"
}

@test "bootstrap_target_dir: returns /tmp path with pid suffix" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        bootstrap_target_dir
    "
    assert_success
    assert_output --regexp '^/tmp/convex-synapse-agent-bootstrap-[0-9]+$'
}

# ---- bash -n (parse-only) -------------------------------------------

@test "install-agent.sh parses cleanly (bash -n)" {
    run bash -n "$INSTALL_AGENT_SCRIPT"
    assert_success
}

@test "every installer-agent/install/*.sh parses cleanly" {
    for f in "$INSTALLER_AGENT_DIR"/install/*.sh; do
        run bash -n "$f"
        assert_success
    done
}

# ---- shellcheck -----------------------------------------------------
#
# Skips when shellcheck isn't on PATH so CI without the linter still
# runs the rest of the suite. The main `bats + shellcheck` job in
# .github/workflows installs shellcheck explicitly.

@test "install-agent.sh passes shellcheck -x" {
    if ! command -v shellcheck >/dev/null 2>&1; then
        skip "shellcheck not on PATH"
    fi
    run shellcheck -x "$INSTALL_AGENT_SCRIPT"
    assert_success
}

@test "every installer-agent/install/*.sh passes shellcheck" {
    if ! command -v shellcheck >/dev/null 2>&1; then
        skip "shellcheck not on PATH"
    fi
    for f in "$INSTALLER_AGENT_DIR"/install/*.sh; do
        run shellcheck -x "$f"
        assert_success
    done
}

# ---- ui::redact -----------------------------------------------------

@test "ui::redact: strips agentToken JSON" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        source '$INSTALLER_AGENT_DIR/install/ui.sh'
        printf '%s' '{\"agentToken\":\"sk_live_abc123\"}' | ui::redact
    "
    assert_success
    assert_output --partial "<redacted>"
    refute_output --partial "sk_live_abc123"
}

@test "ui::redact: strips --auth-key= CLI snippets" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        source '$INSTALLER_AGENT_DIR/install/ui.sh'
        printf '%s' 'tailscale up --auth-key=tskey-secret-xyz --hostname=foo' | ui::redact
    "
    assert_success
    assert_output --partial "<redacted>"
    refute_output --partial "tskey-secret-xyz"
}
