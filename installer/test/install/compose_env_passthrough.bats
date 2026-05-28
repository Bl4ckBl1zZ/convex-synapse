#!/usr/bin/env bats
#
# Regression for the v1.5.2 KVM4 SYNAPSE_STORAGE_KEY bug. Every
# SYNAPSE_* env var the Go binary reads via os.Getenv MUST also be
# in the synapse-api service's environment block in
# docker-compose.yml. Otherwise the var lives in .env, the operator
# thinks it's plumbed through, and the container silently runs with
# defaults — surfacing as nil-pointer panics or "feature appears
# wired but doesn't work" deep in the field.
#
# The bug was caught on a fresh KVM4 install where SYNAPSE_STORAGE_KEY
# was generated in .env by the installer but never reached the
# container, so crypto.NewFromEnv() returned an error, secretBox
# stayed nil, and /v1/admin/dns_credentials/cloudflare panicked on
# EncryptString.
#
# Coverage approach: scrape every os.Getenv("SYNAPSE_*") + os.LookupEnv
# call in the synapse Go module, scrape every SYNAPSE_* key in the
# synapse-api service's environment: block of docker-compose.yml,
# diff the sets. Any Go-side var missing from compose fails the test
# with the offender named.
#
# Allowlist: a few SYNAPSE_* vars the binary reads OPTIONALLY for
# legacy / test-only purposes. New entries here need a justification
# comment.

bats_require_minimum_version 1.5.0

setup() {
    REPO_ROOT="${BATS_TEST_DIRNAME}/../../../"
    if [[ ! -d "$REPO_ROOT/synapse" ]]; then
        skip "synapse Go module not present in expected layout"
    fi
}

@test "compose: every SYNAPSE_* env Go reads is also in docker-compose.yml synapse-api environment" {
    # Vars the installer / Go binary reference but compose intentionally
    # doesn't expose to the synapse-api container. Justification per
    # entry — keep this list short.
    declare -A allowlist=(
        # Operator-set on the host shell, never read inside the
        # container. The container's setup.sh is a different beast.
        ["SYNAPSE_INSTALL_DIR"]="installer-host-only"
        ["SYNAPSE_INSTALL_LOG"]="installer-host-only"
        ["SYNAPSE_BOOTSTRAP_REPO_URL"]="installer-host-only"
        ["SYNAPSE_BOOTSTRAP_REF"]="installer-host-only"
        ["SYNAPSE_VERSION"]="render-time-only (build arg, not runtime env)"
        ["SYNAPSE_CADDYFILE_PATH"]="installer-host-only"
        ["SYNAPSE_CADDYFILE_BACKUP"]="installer-host-only"
        ["SYNAPSE_HA_E2E"]="gated test-only env"
        ["SYNAPSE_DASHBOARD_UPSTREAM"]="dashboard-side, not synapse-api"
        ["SYNAPSE_TEST_DB_URL"]="test harness, not container runtime"
        ["SYNAPSE_BACKUP_S3_ENDPOINT"]="installer/backup-flow only"
        ["SYNAPSE_UPDATER_BIND"]="daemon-side env, not synapse-api"
        ["SYNAPSE_UPDATER_PORT"]="daemon-side env (synapse-api uses URL+TOKEN)"
        ["SYNAPSE_UPDATER_NO_RESTART"]="installer-side guard, not synapse-api"
        ["SYNAPSE_UPDATER_STATE_DIR"]="daemon-side state path"
        ["SYNAPSE_UPDATER_LOG_DIR"]="daemon-side log path"
        ["SYNAPSE_POSTGRES_CONTAINER"]="daemon-side docker exec target"
        # v1.19.1 — surfaced when the test was fixed to actually
        # iterate. Each is a pre-existing test-only / installer-only
        # / GET-handler-fallback case. None matter for the v1.19.1
        # release the test was unblocking; revisit individually.
        ["SYNAPSE_ACME_EMAIL"]="surfaced via host_domain GET fallback (PublicURL); compose passthrough is a v1.20 follow-up"
        ["SYNAPSE_HOST_GEO_OVERRIDE"]="test-only override for geo.Resolver, never set in compose env"
        ["SYNAPSE_HA_BACKEND_POSTGRES_PROBE_URL"]="ha_real_e2e_test.go gated test; never reaches the container"
        ["SYNAPSE_HA_BACKEND_POSTGRES_URL"]="ha_real_e2e_test.go gated test; never reaches the container"
        ["SYNAPSE_HA_BACKEND_S3_ACCESS_KEY"]="ha_real_e2e_test.go gated test; never reaches the container"
        ["SYNAPSE_HA_BACKEND_S3_ENDPOINT"]="ha_real_e2e_test.go gated test; never reaches the container"
        ["SYNAPSE_HA_BACKEND_S3_SECRET_KEY"]="ha_real_e2e_test.go gated test; never reaches the container"
    )

    # Scrape Go side. Match `os.Getenv("SYNAPSE_…")` and
    # `os.LookupEnv("SYNAPSE_…")` and `getEnvDefault("SYNAPSE_…", …)`.
    #
    # v1.19.1: switched from `grep -r --include='*.go'` to a portable
    # find+grep pipeline. The bats image (bats/bats:latest) uses
    # BusyBox grep which doesn't support --include — the original
    # form returned ZERO results silently, the for-loop iterated
    # over nothing, $missing stayed empty, and the test passed
    # regardless of what was actually missing. Caught after
    # v1.19.0 shipped without SYNAPSE_DOMAIN /
    # SYNAPSE_HEADSCALE_DOMAIN wired into compose despite this very
    # test claiming green for those vars. Real-VPS smoke surfaced
    # the bug; the fix is making the test actually do its job.
    local go_vars
    go_vars="$(find "$REPO_ROOT/synapse/" -name '*.go' -type f -print0 \
        | xargs -0 grep -hoE '"(SYNAPSE_[A-Z0-9_]+)"' 2>/dev/null \
        | tr -d '"' \
        | sort -u)"

    # Scrape compose synapse-api env block. Limit to the synapse-api
    # service so we don't false-positive on dashboard/postgres entries.
    local compose_block
    compose_block="$(awk '
        /^  synapse:/{found=1; next}
        found && /^  [a-z]/{exit}
        found{print}
    ' "$REPO_ROOT/docker-compose.yml")"

    local compose_vars
    compose_vars="$(echo "$compose_block" \
        | grep -oE '^      SYNAPSE_[A-Z0-9_]+:' \
        | tr -d ': ' \
        | sort -u)"

    local missing=""
    for var in $go_vars; do
        # Skip allowlist entries.
        if [[ -n "${allowlist[$var]:-}" ]]; then
            continue
        fi
        if ! echo "$compose_vars" | grep -qx "$var"; then
            missing+="$var"$'\n'
        fi
    done

    if [[ -n "$missing" ]]; then
        printf 'Go-side env vars NOT exposed in docker-compose.yml synapse-api environment:\n%s\n' "$missing"
        printf 'Add each to the synapse service environment block, OR add to this test allowlist with a justification comment.\n'
        false
    fi
}

@test "compose: synapse-api mounts install-agent.sh read-only (v1.19.4 remote-hosts one-liner)" {
    # GET /v1/install_agent/script serves this file for the Remote
    # Hosts one-liner. Without the mount the endpoint 503s and the
    # `curl .../v1/install_agent/script | sudo bash` paste fails.
    run grep -E '^\s*-\s*\./install-agent\.sh:/install-agent\.sh:ro\s*$' "$REPO_ROOT/docker-compose.yml"
    [ "$status" -eq 0 ]
}
