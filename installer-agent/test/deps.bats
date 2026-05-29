#!/usr/bin/env bats
# installer-agent/test/deps.bats
#
# Unit tests for installer-agent/install/deps.sh — the v1.19.11 dependency
# auto-install (Docker + CLI tools) that runs before preflight so a fresh
# VPS doesn't bounce off "install Docker first".
#
# Strategy: source ui.sh + deps.sh and drive the pure/seam-injectable
# functions with PATH-shadow mocks (synapse_mock_setup). DEPS_PKG_MGR and
# DEPS_GET_DOCKER_URL are the test seams that keep us off the real package
# manager + the real get.docker.com.

bats_require_minimum_version 1.5.0

load 'helpers/load'

setup() {
    synapse_mock_setup
    # shellcheck source=../install/ui.sh
    source "$INSTALLER_AGENT_DIR/install/ui.sh"
    # shellcheck source=../install/deps.sh
    source "$INSTALLER_AGENT_DIR/install/deps.sh"
    UI_NO_COLOR=1
}

# ---- _pkg_set (pure) -----------------------------------------------

@test "deps::_pkg_set: apt-get → openssh-client + jq + coreutils" {
    run deps::_pkg_set apt-get
    assert_output "jq openssh-client coreutils tar ca-certificates"
}

@test "deps::_pkg_set: dnf → openssh-clients (RHEL package name)" {
    run deps::_pkg_set dnf
    assert_output --partial "openssh-clients"
}

@test "deps::_pkg_set: unknown manager → jq fallback" {
    run deps::_pkg_set some-future-mgr
    assert_output "jq"
}

# ---- _pkg_mgr ------------------------------------------------------

@test "deps::_pkg_mgr: DEPS_PKG_MGR override wins (no probing)" {
    export DEPS_PKG_MGR=dnf
    run deps::_pkg_mgr
    unset DEPS_PKG_MGR
    assert_output "dnf"
}

@test "deps::_pkg_mgr: detects apt-get on PATH" {
    mock_cmd apt-get 0
    run deps::_pkg_mgr
    assert_output "apt-get"
}

# ---- _install_pkgs -------------------------------------------------

@test "deps::_install_pkgs: apt-get path runs install with the packages" {
    mock_cmd apt-get 0
    export DEPS_PKG_MGR=apt-get
    run deps::_install_pkgs jq openssh-client
    unset DEPS_PKG_MGR
    assert_success
    # mock_cmd records one arg per line, so assert the tokens individually.
    run cat "$SYN_MOCK_CALLS/apt-get"
    assert_output --partial "install"
    assert_output --partial "jq"
    assert_output --partial "openssh-client"
}

@test "deps::_install_pkgs: unrecognised manager → non-zero" {
    export DEPS_PKG_MGR=totally-fake-mgr
    run deps::_install_pkgs jq
    unset DEPS_PKG_MGR
    assert_failure
}

# ---- ensure_docker -------------------------------------------------

@test "deps::ensure_docker: docker already present → no get.docker.com fetch" {
    mock_cmd docker 0
    mock_cmd systemctl 0
    mock_cmd curl 0
    run deps::ensure_docker
    assert_success
    # The install path (curl get.docker.com) must NOT have run.
    [ ! -f "$SYN_MOCK_CALLS/curl" ]
}

@test "deps::ensure_docker: docker absent → fetches the configured get-docker URL" {
    if command -v docker >/dev/null 2>&1; then
        skip "docker present in test env — can't exercise the install path"
    fi
    mock_cmd curl 0      # outputs nothing; piped to the real sh → no-op
    mock_cmd systemctl 0
    export DEPS_GET_DOCKER_URL="https://example.test/get-docker"
    run deps::ensure_docker
    unset DEPS_GET_DOCKER_URL
    assert_success
    [ -f "$SYN_MOCK_CALLS/curl" ]
    run cat "$SYN_MOCK_CALLS/curl"
    assert_output --partial "https://example.test/get-docker"
}

# ---- phase wiring (--no-autoinstall) -------------------------------

@test "phase_autoinstall_deps: --no-autoinstall skips the install entirely" {
    run bash -c "
        __SETUP_NO_MAIN=1 source '$INSTALL_AGENT_SCRIPT'
        source '$INSTALLER_AGENT_DIR/install/ui.sh'
        source '$INSTALLER_AGENT_DIR/install/deps.sh'
        UI_NO_COLOR=1
        NO_AUTOINSTALL=1
        phase_autoinstall_deps
    "
    assert_success
    assert_output --partial "Skipping dependency auto-install"
}
