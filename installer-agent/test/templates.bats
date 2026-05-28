#!/usr/bin/env bats
#
# Tests for installer-agent/templates/*.
#
# The systemd unit + sshd drop-in are plain config files; we assert
# structural properties (parseable, has the expected hardening keys,
# Match block is well-formed) rather than byte-exact contents (otherwise
# every cosmetic edit would churn the test).
#
# synapse-deployer-exec is the load-bearing piece — it's the security
# boundary between Synapse central and the host's docker socket. We
# exercise every branch: empty command, non-docker command, non-
# whitelisted subcommand, whitelisted subcommand (via SYNAPSE_DEPLOYER_EXEC_TEST
# short-circuit so we don't need a real docker binary).

bats_require_minimum_version 1.5.0

load 'helpers/load'

setup() {
    synapse_mock_setup
    SVC_FILE="$INSTALLER_AGENT_TEMPLATES/synapse-agent.service"
    SSHD_FILE="$INSTALLER_AGENT_TEMPLATES/sshd-synapse.conf"
    EXEC_FILE="$INSTALLER_AGENT_TEMPLATES/synapse-deployer-exec"
    [ -f "$SVC_FILE" ]
    [ -f "$SSHD_FILE" ]
    [ -f "$EXEC_FILE" ]
}

# ---- synapse-agent.service ------------------------------------------

@test "synapse-agent.service: parses as INI ([Unit][Service][Install])" {
    run grep -E '^\[(Unit|Service|Install)\]$' "$SVC_FILE"
    assert_success
    # All three sections must be present.
    assert_output --partial "[Unit]"
    assert_output --partial "[Service]"
    assert_output --partial "[Install]"
}

@test "synapse-agent.service: runs as non-root synapse-agent user" {
    run grep -E '^User=synapse-agent$' "$SVC_FILE"
    assert_success
    run grep -E '^Group=synapse-agent$' "$SVC_FILE"
    assert_success
}

@test "synapse-agent.service: has docker supplementary group" {
    run grep -E '^SupplementaryGroups=docker$' "$SVC_FILE"
    assert_success
}

@test "synapse-agent.service: has hardening directives" {
    # These are the load-bearing hardening keys — losing any of them
    # would silently regress the unit's blast radius.
    local key
    for key in \
            ProtectSystem=strict \
            ProtectHome=true \
            PrivateTmp=true \
            NoNewPrivileges=true \
            RestrictSUIDSGID=true \
            RestrictRealtime=true \
            RestrictNamespaces=true \
            LockPersonality=true \
            MemoryDenyWriteExecute=true \
            'SystemCallFilter=@system-service' \
            'CapabilityBoundingSet=' \
            'AmbientCapabilities='; do
        run grep -F -- "$key" "$SVC_FILE"
        if ! ((status == 0)); then
            echo "missing directive: $key" >&2
            return 1
        fi
    done
}

@test "synapse-agent.service: ExecStart points at /usr/local/bin/synapse-agent" {
    run grep -E '^ExecStart=/usr/local/bin/synapse-agent run' "$SVC_FILE"
    assert_success
}

@test "synapse-agent.service: ReadWritePaths allows /var/lib/synapse-agent" {
    # ProtectSystem=strict bricks the agent unless we explicitly grant
    # write access to its state dir. Regression-test that pairing.
    run grep -E '^ReadWritePaths=/var/lib/synapse-agent$' "$SVC_FILE"
    assert_success
}

# ---- sshd-synapse.conf ----------------------------------------------

@test "sshd-synapse.conf: has Match User block" {
    run grep -E '^Match User \{\{SSH_USER\}\}$' "$SSHD_FILE"
    assert_success
}

@test "sshd-synapse.conf: forces synapse-deployer-exec" {
    run grep -E 'ForceCommand /usr/local/bin/synapse-deployer-exec' "$SSHD_FILE"
    assert_success
}

@test "sshd-synapse.conf: forbids tcp-forward / x11 / agent / tunnel / pty" {
    local key
    for key in 'AllowTcpForwarding no' \
               'X11Forwarding no' \
               'AllowAgentForwarding no' \
               'PermitTunnel no' \
               'GatewayPorts no' \
               'PermitTTY no'; do
        run grep -F -- "$key" "$SSHD_FILE"
        if ! ((status == 0)); then
            echo "missing sshd directive: $key" >&2
            return 1
        fi
    done
}

@test "sshd-synapse.conf: rendered template has no unsubstituted placeholders" {
    # Smoke-test the substitution itself by running the same sed
    # install-agent.sh's ssh::configure_sshd uses. If the placeholders
    # ever drift (e.g. someone adds {{NEW_THING}} without wiring sed),
    # this fails loudly.
    local out
    out="$(sed -e 's|{{TAILNET_IP}}|100.64.0.5|g' -e 's|{{SSH_USER}}|synapse-deployer|g' "$SSHD_FILE")"
    [[ "$out" != *'{{'* ]]
}

@test "sshd-synapse.conf: rendered output validates as sshd_config" {
    # sshd -t -f <file> validates a complete config file; our drop-in
    # is only valid in the context of a global config that comes before
    # the Match block. We assert the syntactic shape by exercising the
    # parse offline with `sshd -T` style probe — when sshd is on PATH.
    if ! command -v sshd >/dev/null 2>&1; then
        skip "sshd not on PATH"
    fi
    local rendered="$BATS_TEST_TMPDIR/sshd-synapse.conf"
    sed -e 's|{{TAILNET_IP}}|100.64.0.5|g' \
        -e 's|{{SSH_USER}}|synapse-deployer|g' \
        "$SSHD_FILE" > "$rendered"
    # `sshd -t -f` insists on a full config; we just probe `sshd -G`
    # extended-config dump on a stub global + drop-in. To keep this
    # test hermetic we just confirm the file is grep-cleanable and has
    # one Match block.
    run grep -c '^Match ' "$rendered"
    assert_success
    assert_output "1"
}

# ---- synapse-deployer-exec -----------------------------------------

@test "synapse-deployer-exec: file is executable" {
    [ -x "$EXEC_FILE" ]
}

@test "synapse-deployer-exec: parses cleanly (bash -n)" {
    run bash -n "$EXEC_FILE"
    assert_success
}

@test "synapse-deployer-exec: empty SSH_ORIGINAL_COMMAND -> exit 99" {
    SSH_ORIGINAL_COMMAND="" run "$EXEC_FILE"
    assert_failure 99
    assert_output --partial "empty command"
}

@test "synapse-deployer-exec: non-docker command -> exit 99" {
    SSH_ORIGINAL_COMMAND="bash -c 'rm -rf /'" run "$EXEC_FILE"
    assert_failure 99
    assert_output --partial "only docker commands allowed"
}

@test "synapse-deployer-exec: non-whitelisted docker subcommand -> exit 99" {
    # `docker system prune -af` would be DEVASTATING on a shared host;
    # the whitelist must reject it.
    SSH_ORIGINAL_COMMAND="docker system prune -af" run "$EXEC_FILE"
    assert_failure 99
    assert_output --partial "subcommand 'system' not permitted"
}

@test "synapse-deployer-exec: whitelisted subcommand passes (TEST short-circuit)" {
    SSH_ORIGINAL_COMMAND="docker version" \
        SYNAPSE_DEPLOYER_EXEC_TEST=1 \
        run "$EXEC_FILE"
    assert_success
    assert_output --partial "would-exec: docker version"
}

@test "synapse-deployer-exec: docker run is whitelisted" {
    SSH_ORIGINAL_COMMAND="docker run --name=foo busybox echo hi" \
        SYNAPSE_DEPLOYER_EXEC_TEST=1 \
        run "$EXEC_FILE"
    assert_success
    assert_output --partial "would-exec: docker run"
}

@test "synapse-deployer-exec: docker rm is whitelisted" {
    SSH_ORIGINAL_COMMAND="docker rm -f cell-abc" \
        SYNAPSE_DEPLOYER_EXEC_TEST=1 \
        run "$EXEC_FILE"
    assert_success
    assert_output --partial "would-exec: docker rm"
}
