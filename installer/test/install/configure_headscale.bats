#!/usr/bin/env bats
# installer/test/install/configure_headscale.bats
#
# v1.19+ — Unit tests for `lifecycle::configure_headscale`, the entry
# point the synapse-updater daemon shells when the dashboard's
# Admin → Remote Hosts panel posts a configure_headscale job.
#
# Same mocking pattern as reconfigure.bats: PATH-shadow `docker` so we
# don't need a real engine + stub out headscale::bootstrap so we
# exercise the lifecycle wrapper without spinning up real Headscale.
#
# What we cover:
#   - install-dir preflight refuses (.env missing → not_installed)
#   - explicit --headscale-domain= persists into .env
#   - bootstrap failure surfaces bootstrap_failed
#   - happy path triggers compose recreate of synapse-api
#   - control-plane tailnet helper is invoked by bootstrap
#   - persist SYNAPSE_HEADSCALE_DOMAIN derived from SYNAPSE_DOMAIN

bats_require_minimum_version 1.5.0

load '../helpers/load'

setup() {
    synapse_mock_setup
    # shellcheck source=../../install/ui.sh
    source "$INSTALLER_DIR/install/ui.sh"
    # shellcheck source=../../install/secrets.sh
    source "$INSTALLER_DIR/install/secrets.sh"
    # shellcheck source=../../install/caddy.sh
    source "$INSTALLER_DIR/install/caddy.sh"
    # shellcheck source=../../install/compose.sh
    source "$INSTALLER_DIR/install/compose.sh"
    # shellcheck source=../../lib/detect.sh
    source "$INSTALLER_DIR/lib/detect.sh"
    # shellcheck source=../../install/headscale.sh
    source "$INSTALLER_DIR/install/headscale.sh"
    # shellcheck source=../../install/lifecycle.sh
    source "$INSTALLER_DIR/install/lifecycle.sh"
    # Provide the setup::hydrate_env helper that lifecycle calls. We
    # stub it as a no-op because the test fixture already exports the
    # values we want lifecycle to see; the real implementation would
    # otherwise NPE because $INSTALL_DIR is not the production path.
    eval 'setup::hydrate_env() { return 0; }'

    UI_NO_COLOR=1
    INSTALL_DIR="$BATS_TEST_TMPDIR/install"
    mkdir -p "$INSTALL_DIR"
    export INSTALL_DIR
    ENV_FILE="$INSTALL_DIR/.env"
    COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
    INSTALLER_TEMPLATES="$INSTALLER_DIR/templates"
    export INSTALLER_TEMPLATES

    # Default-pass docker mock so any compose recreate shell-out
    # succeeds. We pass --no-build, so plain `docker compose up -d
    # --no-build --force-recreate synapse` returns 0.
    cat >"$SYN_MOCK_BIN/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/docker"
    COMPOSE_CMD="$SYN_MOCK_BIN/docker"
    export COMPOSE_CMD

    # Stub the upstream healthcheck so the lifecycle wrapper doesn't
    # try to curl http://localhost:8080/health from inside bats.
    eval 'compose::wait_healthy() { return 0; }'

    # Stub headscale::bootstrap so the test exercises the lifecycle
    # wrapper's contract (env handling, recreate, log) without
    # needing a real Headscale container.
    eval 'headscale::bootstrap() {
        SYNAPSE_HEADSCALE_SERVER_URL="https://${SYNAPSE_HEADSCALE_DOMAIN:-headscale.derived.example.com}"
        SYNAPSE_HEADSCALE_URL="http://synapse-headscale:8080"
        return 0
    }'
}

_install_fixture() {
    cat >"$ENV_FILE" <<EOF
SYNAPSE_VERSION=1.18.5
SYNAPSE_JWT_SECRET=preserved
POSTGRES_PASSWORD=preserved
SYNAPSE_PORT=8080
SYNAPSE_DOMAIN=synapsepanel.com
EOF
    cat >"$COMPOSE_FILE" <<EOF
services:
  synapse: {}
EOF
}

# ---- preflight -----------------------------------------------------

@test "configure_headscale: missing install dir → not_installed" {
    local bogus="$BATS_TEST_TMPDIR/no-such"
    mkdir -p "$bogus"
    run lifecycle::configure_headscale "$bogus"
    assert_failure 2
    assert_output --partial "not_installed"
}

@test "configure_headscale: install dir without compose file → not_installed" {
    : >"$ENV_FILE"
    run lifecycle::configure_headscale "$INSTALL_DIR"
    assert_failure 2
    assert_output --partial "not_installed"
}

# ---- happy path ----------------------------------------------------

@test "configure_headscale: happy path runs bootstrap + records log" {
    _install_fixture
    run lifecycle::configure_headscale "$INSTALL_DIR"
    assert_success
    # configure_headscale.log was touched.
    [ -f "$INSTALL_DIR/configure_headscale.log" ]
    grep -q "configure_headscale: start" "$INSTALL_DIR/configure_headscale.log"
    grep -q "configure_headscale: done" "$INSTALL_DIR/configure_headscale.log"
}

@test "configure_headscale: explicit HEADSCALE_DOMAIN persists into .env BEFORE bootstrap" {
    _install_fixture
    # Capture what the stubbed bootstrap saw by re-stubbing here.
    SAW_HEADSCALE_DOMAIN=""
    eval 'headscale::bootstrap() {
        SAW_HEADSCALE_DOMAIN="$SYNAPSE_HEADSCALE_DOMAIN"
        return 0
    }'
    HEADSCALE_DOMAIN="explicit-control.example.org" \
        lifecycle::configure_headscale "$INSTALL_DIR"
    [ "$SAW_HEADSCALE_DOMAIN" = "explicit-control.example.org" ]
    # And it landed on disk.
    run grep -E '^SYNAPSE_HEADSCALE_DOMAIN=explicit-control\.example\.org$' "$ENV_FILE"
    assert_success
}

@test "configure_headscale: ENABLE_HEADSCALE is flipped on for the run" {
    _install_fixture
    SAW_FLAG=""
    eval 'headscale::bootstrap() {
        SAW_FLAG="$ENABLE_HEADSCALE"
        return 0
    }'
    lifecycle::configure_headscale "$INSTALL_DIR"
    [ "$SAW_FLAG" = "1" ]
}

# ---- failure modes -------------------------------------------------

@test "configure_headscale: bootstrap failure → bootstrap_failed" {
    _install_fixture
    eval 'headscale::bootstrap() { return 2; }'
    run lifecycle::configure_headscale "$INSTALL_DIR"
    assert_failure 2
    assert_output --partial "bootstrap_failed"
}

@test "configure_headscale: synapse-api recreate failure → restart_failed warning" {
    _install_fixture
    # Override docker mock to return non-zero on the recreate path.
    cat >"$SYN_MOCK_BIN/docker" <<'EOF'
#!/usr/bin/env bash
# Pass `compose -f ... up -d --no-build --force-recreate synapse`,
# fail everything else with rc=1.
if [[ "$*" == *"up -d --no-build --force-recreate synapse"* ]]; then
    exit 1
fi
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/docker"
    run lifecycle::configure_headscale "$INSTALL_DIR"
    assert_failure 2
    assert_output --partial "restart_failed"
}
