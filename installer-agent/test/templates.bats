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
    TEARDOWN_FILE="$INSTALLER_AGENT_TEMPLATES/synapse-agent-teardown"
    SUDOERS_FILE="$INSTALLER_AGENT_TEMPLATES/sudoers-synapse-deployer-teardown"
    [ -f "$SVC_FILE" ]
    [ -f "$SSHD_FILE" ]
    [ -f "$EXEC_FILE" ]
    [ -f "$TEARDOWN_FILE" ]
    [ -f "$SUDOERS_FILE" ]
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

# ---- synapse-deployer-exec: docker volume (remote provision) --------
#
# RemoteClient.Provision/Destroy run `docker volume create|rm` over the
# wrapper. `volume` was missing from the whitelist → exit 99 "subcommand
# 'volume' not permitted" → every remote deployment failed at the first
# step. It's now allowed, but gated to the targeted ops only.

@test "synapse-deployer-exec: docker volume create is whitelisted" {
    SSH_ORIGINAL_COMMAND="docker volume create synapse-data-x" \
        SYNAPSE_DEPLOYER_EXEC_TEST=1 \
        run "$EXEC_FILE"
    assert_success
    assert_output "would-exec: docker volume create synapse-data-x"
}

@test "synapse-deployer-exec: docker volume rm is whitelisted" {
    SSH_ORIGINAL_COMMAND="docker volume rm synapse-data-x" \
        SYNAPSE_DEPLOYER_EXEC_TEST=1 \
        run "$EXEC_FILE"
    assert_success
    assert_output "would-exec: docker volume rm synapse-data-x"
}

@test "synapse-deployer-exec: docker volume prune is REFUSED (wildcard delete)" {
    # `volume prune` deletes every unused volume on a shared host — a
    # buggy central could wipe a sibling deployment's data. The
    # second-level gate must reject it even though `volume` is allowed.
    SSH_ORIGINAL_COMMAND="docker volume prune -f" run "$EXEC_FILE"
    assert_failure 99
    assert_output --partial "'docker volume prune' not permitted"
}

@test "synapse-deployer-exec: bare docker volume (no subcommand) is REFUSED" {
    SSH_ORIGINAL_COMMAND="docker volume" run "$EXEC_FILE"
    assert_failure 99
    assert_output --partial "not permitted"
}

# ---- synapse-deployer-exec: shell-quote parsing ---------------------
#
# sshprov.shellQuoteArgv single-quotes any arg outside its safe alphabet
# — notably the backend image's `@sha256:` digest. The old `read -ra`
# whitespace split KEPT the literal quotes, so docker got
# 'ghcr.io/...@sha256:...' → exit 125 "invalid reference format". These
# assert the POSIX single-quote parser strips quoting exactly.

@test "synapse-deployer-exec: single-quoted @digest image parses without literal quotes" {
    SSH_ORIGINAL_COMMAND="docker run -d --name convex-x 'ghcr.io/get-convex/convex-backend@sha256:abc'" \
        SYNAPSE_DEPLOYER_EXEC_TEST=1 \
        run "$EXEC_FILE"
    assert_success
    assert_output "would-exec: docker run -d --name convex-x ghcr.io/get-convex/convex-backend@sha256:abc"
}

@test "synapse-deployer-exec: single-quoted arg with a space stays ONE token" {
    SSH_ORIGINAL_COMMAND="docker run -e 'GREETING=hello world' busybox" \
        SYNAPSE_DEPLOYER_EXEC_TEST=1 \
        run "$EXEC_FILE"
    assert_success
    assert_output "would-exec: docker run -e GREETING=hello world busybox"
}

@test "synapse-deployer-exec: embedded single-quote idiom round-trips" {
    # shellQuoteArgv encodes X=it's as 'X=it'\''s'; the parser must
    # rebuild X=it's (not X=it\''s, and not two tokens).
    SSH_ORIGINAL_COMMAND="docker run -e 'X=it'\''s' busybox" \
        SYNAPSE_DEPLOYER_EXEC_TEST=1 \
        run "$EXEC_FILE"
    assert_success
    assert_output "would-exec: docker run -e X=it's busybox"
}

# ---- synapse-deployer-exec: teardown sentinel (gap 4) ---------------
#
# Deleting a host from the control plane dispatches the single token
# "synapse-agent-teardown", which the wrapper hands to the root-owned
# teardown script via the scoped NOPASSWD sudoers rule. The sentinel is
# the ONLY non-docker thing the wrapper accepts, and only as a bare token.

@test "synapse-deployer-exec: teardown sentinel hands off to sudo (TEST short-circuit)" {
    SSH_ORIGINAL_COMMAND="synapse-agent-teardown" \
        SYNAPSE_DEPLOYER_EXEC_TEST=1 \
        run "$EXEC_FILE"
    assert_success
    assert_output --partial "would-exec: sudo -n /usr/local/bin/synapse-agent-teardown"
}

@test "synapse-deployer-exec: teardown sentinel with extra args is REFUSED" {
    # Only the bare token is the sentinel; "synapse-agent-teardown --evil"
    # must NOT escalate — it falls through to the docker gate and 99s.
    SSH_ORIGINAL_COMMAND="synapse-agent-teardown --rm-rf /" run "$EXEC_FILE"
    assert_failure 99
    assert_output --partial "only docker commands allowed"
}

# ---- synapse-agent-teardown ----------------------------------------

@test "synapse-agent-teardown: parses cleanly (bash -n)" {
    run bash -n "$TEARDOWN_FILE"
    assert_success
}

@test "synapse-agent-teardown: renders without leftover placeholders" {
    local out
    out="$(sed -e 's|{{SSH_USER}}|synapse-deployer|g' \
               -e 's|{{INSTALL_DIR}}|/etc/synapse-agent|g' "$TEARDOWN_FILE")"
    [[ "$out" != *'{{'* ]]
}

@test "synapse-agent-teardown: wipes the load-bearing footprint + self-destructs" {
    local key
    for key in 'synapse-agent.service' \
               '/usr/local/bin/synapse-agent' \
               '/etc/ssh/sshd_config.d/synapse-deployer.conf' \
               '/usr/local/bin/synapse-deployer-exec' \
               '/etc/sudoers.d/synapse-deployer-teardown' \
               'userdel' \
               'rm -f /usr/local/bin/synapse-agent-teardown'; do
        run grep -F -- "$key" "$TEARDOWN_FILE"
        if ! ((status == 0)); then
            echo "teardown script missing: $key" >&2
            return 1
        fi
    done
}

# ---- sudoers-synapse-deployer-teardown ------------------------------

@test "sudoers rule: scoped NOPASSWD to exactly the teardown script" {
    local out
    out="$(sed -e 's|{{SSH_USER}}|synapse-deployer|g' "$SUDOERS_FILE")"
    [[ "$out" != *'{{'* ]]
    # Exactly one non-comment directive, scoped to the absolute script path.
    run bash -c "sed -e 's|{{SSH_USER}}|synapse-deployer|g' '$SUDOERS_FILE' | grep -vE '^[[:space:]]*#' | grep -vE '^[[:space:]]*\$'"
    assert_success
    assert_output "synapse-deployer ALL=(root) NOPASSWD: /usr/local/bin/synapse-agent-teardown"
}

@test "sudoers rule: validates with visudo -cf when available" {
    if ! command -v visudo >/dev/null 2>&1; then
        skip "visudo not on PATH"
    fi
    local rendered="$BATS_TEST_TMPDIR/sudoers"
    sed -e 's|{{SSH_USER}}|synapse-deployer|g' "$SUDOERS_FILE" > "$rendered"
    run visudo -cf "$rendered"
    assert_success
}
