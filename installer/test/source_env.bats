#!/usr/bin/env bats
#
# Unit tests for setup::hydrate_env.
#
# Regression: re-running `setup.sh --enable-headscale --base-domain=…`
# on an existing install used to fail with "Headscale needs
# SYNAPSE_BASE_DOMAIN or SYNAPSE_PUBLIC_IP+SYNAPSE_HEADSCALE_PORT"
# because phase_secrets only exports the .env keys on a FRESH render
# (gated to `[[ ! -f .env ]]`), so downstream phases that read those
# vars from the environment got nothing on a re-run — even though the
# value was literally on disk in $INSTALL_DIR/.env. setup::hydrate_env
# closes that gap by re-exporting the persisted subset early in
# main(), without ever `source`ing the file (values may legally
# contain shell-unsafe bytes).
#
# Style mirrors installer/test/install/secrets.bats: per-test tmpdir
# fixture for .env, no real network/Docker, ui::info stubbed to a
# no-op so the function stays pure-data.

bats_require_minimum_version 1.5.0

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
    # secrets::env_get is the safe quote-stripping reader used by
    # hydrate_env. Source it first.
    # shellcheck source=../install/secrets.sh
    source "$REPO_ROOT/install/secrets.sh"
    # setup.sh top-level guards on __SETUP_NO_MAIN so sourcing it
    # only defines functions, never runs main().
    export __SETUP_NO_MAIN=1
    # shellcheck source=../../setup.sh
    source "$REPO_ROOT/../setup.sh"
    # ui::info / ui::step come from installer/install/ui.sh, which is
    # only sourced inside source_libs(). For these unit tests we want
    # hydrate_env's log line to be a no-op.
    ui::info() { :; }
    ui::step() { :; }

    # Every test gets a clean INSTALL_DIR. Tests that need an .env
    # write it themselves so the "missing file" branch can be exercised
    # by simply skipping the write.
    INSTALL_DIR="$BATS_TEST_TMPDIR/install"
    mkdir -p "$INSTALL_DIR"

    # Always start with the hydrated keys unset so the "operator
    # override wins" test is the only one that pre-seeds them.
    unset \
        SYNAPSE_BASE_DOMAIN \
        SYNAPSE_DOMAIN \
        SYNAPSE_PUBLIC_URL \
        SYNAPSE_PUBLIC_IP \
        SYNAPSE_ACME_EMAIL \
        SYNAPSE_HEADSCALE_URL \
        SYNAPSE_HEADSCALE_SERVER_URL \
        SYNAPSE_HEADSCALE_DOMAIN \
        SYNAPSE_HEADSCALE_API_KEY
}

@test "setup::hydrate_env: no-op when .env missing" {
    # Fresh install path: phase_secrets is responsible for populating
    # the environment, hydrate_env must stay out of the way.
    [ ! -f "$INSTALL_DIR/.env" ]
    run setup::hydrate_env
    [ "$status" -eq 0 ]
    [ -z "${SYNAPSE_BASE_DOMAIN:-}" ]
    [ -z "${SYNAPSE_DOMAIN:-}" ]
}

@test "setup::hydrate_env: exports SYNAPSE_BASE_DOMAIN from .env" {
    printf 'SYNAPSE_BASE_DOMAIN=app.example.com\n' > "$INSTALL_DIR/.env"
    setup::hydrate_env
    [ "$SYNAPSE_BASE_DOMAIN" = "app.example.com" ]
}

@test "setup::hydrate_env: CLI/env override wins over .env" {
    # Operator running `SYNAPSE_BASE_DOMAIN=from-cli ./setup.sh ...`
    # or having exported it in their shell must NOT have their value
    # silently clobbered by whatever is sitting in the persisted file.
    printf 'SYNAPSE_BASE_DOMAIN=from-env.example.com\n' > "$INSTALL_DIR/.env"
    export SYNAPSE_BASE_DOMAIN=from-cli.example.com
    setup::hydrate_env
    [ "$SYNAPSE_BASE_DOMAIN" = "from-cli.example.com" ]
}

@test "setup::hydrate_env: hydrates all 9 expected keys" {
    # The exact key list is part of the function's contract — every
    # downstream phase that reads one of these expects hydrate_env to
    # have re-exported it. Drift here breaks --enable-headscale on
    # re-runs all over again.
    cat > "$INSTALL_DIR/.env" <<'EOF'
SYNAPSE_BASE_DOMAIN=app.example.com
SYNAPSE_DOMAIN=synapse.example.com
SYNAPSE_PUBLIC_URL=https://synapse.example.com
SYNAPSE_PUBLIC_IP=203.0.113.10
SYNAPSE_ACME_EMAIL=ops@example.com
SYNAPSE_HEADSCALE_URL=https://headscale.example.com
SYNAPSE_HEADSCALE_SERVER_URL=https://headscale.example.com
SYNAPSE_HEADSCALE_DOMAIN=headscale.example.com
SYNAPSE_HEADSCALE_API_KEY=hs-fixture-api-key
EOF
    setup::hydrate_env
    [ "$SYNAPSE_BASE_DOMAIN"          = "app.example.com" ]
    [ "$SYNAPSE_DOMAIN"               = "synapse.example.com" ]
    [ "$SYNAPSE_PUBLIC_URL"           = "https://synapse.example.com" ]
    [ "$SYNAPSE_PUBLIC_IP"            = "203.0.113.10" ]
    [ "$SYNAPSE_ACME_EMAIL"           = "ops@example.com" ]
    [ "$SYNAPSE_HEADSCALE_URL"        = "https://headscale.example.com" ]
    [ "$SYNAPSE_HEADSCALE_SERVER_URL" = "https://headscale.example.com" ]
    [ "$SYNAPSE_HEADSCALE_DOMAIN"     = "headscale.example.com" ]
    [ "$SYNAPSE_HEADSCALE_API_KEY"    = "hs-fixture-api-key" ]
}
