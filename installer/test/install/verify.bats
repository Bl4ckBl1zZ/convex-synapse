#!/usr/bin/env bats
#
# Unit tests for installer/install/verify.sh.
#
# Mocks curl (per-endpoint responses) and jq via PATH-shadow. The
# verify::run end-to-end happy path is asserted by stitching the
# mocks into a state machine that returns the right body for each
# URL the script hits.

bats_require_minimum_version 1.5.0

load '../helpers/load'

setup() {
    synapse_mock_setup
    # shellcheck source=../../install/ui.sh
    source "$INSTALLER_DIR/install/ui.sh"
    # shellcheck source=../../install/verify.sh
    source "$INSTALLER_DIR/install/verify.sh"
    UI_NO_COLOR=1
    # Real jq is needed for response parsing — present in bats/bats:latest.
    VERIFY_JQ=jq
    export VERIFY_JQ
}

# ---- _curl + _jq helpers -------------------------------------------

@test "_curl: builds POST with json body and returns response" {
    mock_cmd curl 0 '{"ok":true}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::_curl POST http://x/api '{"a":1}'
    assert_success
    assert_output '{"ok":true}'
}

@test "_curl: adds Bearer header when VERIFY_TOKEN is set" {
    cat >"$SYN_MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >"$BATS_TEST_TMPDIR/curl.args"
echo '{}'
EOF
    chmod +x "$SYN_MOCK_BIN/curl"
    VERIFY_CURL="$SYN_MOCK_BIN/curl" VERIFY_TOKEN=tok-123 run verify::_curl GET http://x
    assert_success
    run cat "$BATS_TEST_TMPDIR/curl.args"
    assert_output --partial "Authorization: Bearer tok-123"
}

# ---- register / create_team / create_project / create_deployment ---

@test "register: extracts accessToken (camelCase, Convex Cloud shape)" {
    mock_cmd curl 0 '{"accessToken":"abc-123","refreshToken":"r"}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::register http://x a@b.com pw Name
    assert_success
    assert_output "abc-123"
}

@test "register: snake_case access_token still accepted (forward-compat)" {
    mock_cmd curl 0 '{"access_token":"abc-snake","refresh_token":"r"}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::register http://x a@b.com pw Name
    assert_success
    assert_output "abc-snake"
}

@test "register: curl failure propagates" {
    mock_cmd curl 22 ''
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::register http://x a@b.com pw Name
    assert_failure
}

@test "create_team: extracts slug" {
    mock_cmd curl 0 '{"slug":"default","name":"Default","id":1}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::create_team http://x Default
    assert_success
    assert_output "default"
}

@test "create_project: extracts projectId (camelCase, Convex Cloud shape)" {
    mock_cmd curl 0 '{"projectId":"42","projectSlug":"demo","project":{"id":"42","name":"Demo"}}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::create_project http://x default Demo
    assert_success
    assert_output "42"
}

@test "create_project: nested project.id fallback works" {
    mock_cmd curl 0 '{"project":{"id":"99","name":"Demo"}}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::create_project http://x default Demo
    assert_success
    assert_output "99"
}

@test "create_deployment: extracts name from Deployment object" {
    mock_cmd curl 0 '{"id":"u","name":"happy-cat-1234","status":"provisioning"}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::create_deployment http://x 42 dev
    assert_success
    assert_output "happy-cat-1234"
}

# ---- wait_deployment -----------------------------------------------

@test "wait_deployment: status=running on first poll -> success" {
    mock_cmd curl 0 '{"status":"running"}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::wait_deployment http://x happy-cat 5
    assert_success
}

@test "wait_deployment: status=failed -> exit 2" {
    mock_cmd curl 0 '{"status":"failed"}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::wait_deployment http://x happy-cat 5
    assert_failure 2
}

@test "wait_deployment: never reaches running -> exit 1" {
    mock_cmd curl 0 '{"status":"provisioning"}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::wait_deployment http://x happy-cat 2
    assert_failure 1
}

# ---- check_cli_creds -----------------------------------------------

@test "check_cli_creds: convexUrl public -> echoes URL + success" {
    mock_cmd curl 0 '{"convexUrl":"https://synapse.example.com/d/happy-cat","adminKey":"k"}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::check_cli_creds http://x happy-cat
    assert_success
    assert_output "https://synapse.example.com/d/happy-cat"
}

@test "check_cli_creds: convexUrl 127.0.0.1 -> failure (PUBLIC_URL not wired)" {
    mock_cmd curl 0 '{"convexUrl":"http://127.0.0.1:3210","adminKey":"k"}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::check_cli_creds http://x happy-cat
    assert_failure 1
    assert_output --partial "loopback"
}

@test "check_cli_creds: convexUrl localhost -> failure" {
    mock_cmd curl 0 '{"convexUrl":"http://localhost:3210","adminKey":"k"}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::check_cli_creds http://x happy-cat
    assert_failure 1
}

@test "check_cli_creds: missing field -> failure" {
    mock_cmd curl 0 '{}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" run verify::check_cli_creds http://x happy-cat
    assert_failure 1
}

# ---- run end-to-end (state-machine mock) ---------------------------

@test "run: full happy path with state-machine curl mock" {
    # Stub curl that branches on the URL it's called with. Each
    # endpoint returns the response the next step expects.
    cat >"$SYN_MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
url=""
for arg in "$@"; do
    case "$arg" in
        http*) url="$arg" ;;
    esac
done
case "$url" in
    *auth/register)       echo '{"accessToken":"tok-self","refreshToken":"r"}' ;;
    *teams/create_team)   echo '{"slug":"default","name":"Default","id":"t-1"}' ;;
    *create_project)      echo '{"projectId":"p-1","projectSlug":"demo","project":{"id":"p-1","name":"Demo"}}' ;;
    *create_deployment)   echo '{"id":"d-1","name":"happy-cat-self","status":"provisioning"}' ;;
    */deployments/happy-cat-self/cli_credentials)
                          echo '{"convexUrl":"https://synapse.example.com/d/happy-cat-self","adminKey":"k","deploymentName":"happy-cat-self"}' ;;
    */deployments/happy-cat-self)
                          echo '{"status":"running","name":"happy-cat-self"}' ;;
    *)                    echo '{}'; exit 1 ;;
esac
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/curl"
    cat >"$SYN_MOCK_BIN/openssl" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == "rand -hex" ]] && { echo "fixed-pw-fixture"; exit 0; }
exit 1
EOF
    chmod +x "$SYN_MOCK_BIN/openssl"
    VERIFY_CURL="$SYN_MOCK_BIN/curl" \
    VERIFY_OPENSSL="$SYN_MOCK_BIN/openssl" \
    VERIFY_EMAIL="self-test@x" \
        run verify::run http://localhost:8080 --keep-demo
    assert_success
    assert_output --partial "Self-test passed"
}

# ---- run --skip-if-installed (v1.18.5 prod-safety gate) ------------
#
# verify::run --skip-if-installed probes synapse-postgres for users
# BEFORE running the destructive self-test + TRUNCATE. The gate has
# four observable branches we pin down here:
#   1. users > 0   → skip (no curl ever called)
#   2. users == 0  → proceed with full self-test
#   3. probe fails → fail-open, proceed with full self-test
#   4. flag absent → legacy behaviour: TRUNCATE still fires

# Reusable state-machine curl stub matching the v0.6 happy path. The
# heredoc is double-quoted so $SYN_MOCK_CALLS expands at write time;
# runtime $vars inside the script are backslash-escaped.
_verify_install_curl_stub() {
    cat >"$SYN_MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
url=""
for arg in "\$@"; do
    case "\$arg" in http*) url="\$arg" ;; esac
done
printf '%s\n' "\$@" >>"$SYN_MOCK_CALLS/curl"
case "\$url" in
    *auth/register)       echo '{"accessToken":"tok-self","refreshToken":"r"}' ;;
    *teams/create_team)   echo '{"slug":"default","name":"Default","id":"t-1"}' ;;
    *create_project)      echo '{"projectId":"p-1","projectSlug":"demo","project":{"id":"p-1","name":"Demo"}}' ;;
    *create_deployment)   echo '{"id":"d-1","name":"happy-cat-self","status":"provisioning"}' ;;
    */deployments/happy-cat-self/cli_credentials)
                          echo '{"convexUrl":"https://synapse.example.com/d/happy-cat-self","adminKey":"k","deploymentName":"happy-cat-self"}' ;;
    */deployments/happy-cat-self/delete)
                          echo '{}' ;;
    */deployments/happy-cat-self)
                          echo '{"status":"running","name":"happy-cat-self"}' ;;
    *)                    echo '{}'; exit 1 ;;
esac
exit 0
EOF
    chmod +x "$SYN_MOCK_BIN/curl"
    cat >"$SYN_MOCK_BIN/openssl" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == "rand -hex" ]] && { echo "fixed-pw-fixture"; exit 0; }
exit 1
EOF
    chmod +x "$SYN_MOCK_BIN/openssl"
}

@test "verify::run --skip-if-installed: skips when users.count > 0" {
    # docker exec ... psql ... echoes a non-zero user count: prod data
    # is present, so verify::run must early-return without touching
    # the API. The mock_cmd-recorded $SYN_MOCK_CALLS/curl file acts as
    # the sentinel — if it exists, the self-test path was entered.
    mock_cmd docker 0 '3'
    mock_cmd curl 0 '{}'
    VERIFY_CURL="$SYN_MOCK_BIN/curl" \
    VERIFY_DOCKER="$SYN_MOCK_BIN/docker" \
        run verify::run http://localhost:8080 --skip-if-installed
    assert_success
    assert_output --partial "protecting prod data"
    assert_file_not_exists "$SYN_MOCK_CALLS/curl"
}

@test "verify::run --skip-if-installed: runs full self-test when users.count == 0" {
    # Fresh install: probe returns 0 → proceed. Full state-machine
    # mock drives the happy path. The presence of $SYN_MOCK_CALLS/curl
    # proves the self-test code path WAS entered.
    mock_cmd docker 0 '0'
    _verify_install_curl_stub
    VERIFY_CURL="$SYN_MOCK_BIN/curl" \
    VERIFY_OPENSSL="$SYN_MOCK_BIN/openssl" \
    VERIFY_DOCKER="$SYN_MOCK_BIN/docker" \
    VERIFY_EMAIL="self-test@x" \
        run verify::run http://localhost:8080 --skip-if-installed --keep-demo
    assert_success
    assert_output --partial "Self-test passed"
    assert_file_exists "$SYN_MOCK_CALLS/curl"
}

@test "verify::run --skip-if-installed: runs full self-test on psql failure (fail-open for fresh install)" {
    # docker exec exits 1 (postgres unreachable, container missing,
    # whatever). The fail-open contract says: assume fresh install,
    # don't block the green-light proof. Self-test must still run.
    mock_cmd docker 1 ''
    _verify_install_curl_stub
    VERIFY_CURL="$SYN_MOCK_BIN/curl" \
    VERIFY_OPENSSL="$SYN_MOCK_BIN/openssl" \
    VERIFY_DOCKER="$SYN_MOCK_BIN/docker" \
    VERIFY_EMAIL="self-test@x" \
        run verify::run http://localhost:8080 --skip-if-installed --keep-demo
    assert_success
    assert_output --partial "Self-test passed"
    assert_file_exists "$SYN_MOCK_CALLS/curl"
}

@test "verify::run without --skip-if-installed: still truncates (legacy callers preserved)" {
    # No --skip-if-installed and no --keep-demo → the legacy TRUNCATE
    # users CASCADE block at the end of verify::run must still fire.
    # We assert it by inspecting the docker mock's recorded argv.
    mock_cmd docker 0 ''
    _verify_install_curl_stub
    VERIFY_CURL="$SYN_MOCK_BIN/curl" \
    VERIFY_OPENSSL="$SYN_MOCK_BIN/openssl" \
    VERIFY_DOCKER="$SYN_MOCK_BIN/docker" \
    VERIFY_EMAIL="self-test@x" \
        run verify::run http://localhost:8080
    assert_success
    assert_output --partial "Self-test passed"
    run cat "$SYN_MOCK_CALLS/docker"
    assert_output --partial "TRUNCATE users CASCADE;"
}
