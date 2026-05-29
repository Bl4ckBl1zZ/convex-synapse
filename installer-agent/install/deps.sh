# installer-agent/install/deps.sh
# shellcheck shell=bash
#
# Dependency auto-install for install-agent.sh.
#
# A remote host is almost always a FRESH VPS — so the agent installer
# should bring up Docker + the CLI tools the later phases need instead of
# hard-failing preflight and making the operator SSH in to run
# `apt-get install -y jq` + `curl https://get.docker.com | sh` by hand.
# This mirrors setup.sh::phase_autoinstall_docker + phase_install_deps so
# both installers behave the same on a clean box.
#
# Runs BEFORE preflight (so preflight::check_docker / check_deps then see
# a working Docker + the tools present) and only as root. Everything is
# best-effort: preflight is the HARD gate that fails the run if something
# is still missing afterwards. --no-autoinstall skips this entirely for
# hardened / air-gapped hosts that pre-bake their image.
#
# Callers MUST source installer-agent/install/ui.sh first.
#
# Test seams:
#   DEPS_PKG_MGR         force the detected package manager (skip probing)
#   DEPS_GET_DOCKER_URL  override the get.docker.com URL (point at a stub)

# deps::_pkg_mgr — echo the host package manager (apt-get|dnf|yum|apk|
# zypper|pacman) or empty when none is recognised. DEPS_PKG_MGR overrides
# the probe for tests.
deps::_pkg_mgr() {
    if [[ -n "${DEPS_PKG_MGR:-}" ]]; then
        printf '%s' "$DEPS_PKG_MGR"
        return 0
    fi
    local m
    for m in apt-get dnf yum apk zypper pacman; do
        if command -v "$m" >/dev/null 2>&1; then
            printf '%s' "$m"
            return 0
        fi
    done
    return 0
}

# deps::_pkg_set <mgr> — echo the package set covering the agent's CLI
# deps (jq + openssh client + tar + coreutils + ca-certificates) for the
# given manager. The openssh-client package name is the only cross-distro
# wrinkle (openssh-client vs openssh-clients vs openssh).
deps::_pkg_set() {
    case "$1" in
        apt-get) printf 'jq openssh-client coreutils tar ca-certificates' ;;
        dnf|yum) printf 'jq openssh-clients coreutils tar ca-certificates' ;;
        apk)     printf 'jq openssh-client coreutils tar ca-certificates' ;;
        zypper)  printf 'jq openssh coreutils tar ca-certificates' ;;
        pacman)  printf 'jq openssh coreutils tar' ;;
        *)       printf 'jq' ;;
    esac
}

# deps::_install_pkgs <pkg...> — install packages via the detected manager,
# non-interactively. Idempotent: already-installed packages are no-ops.
# Returns non-zero on install failure or when no manager is recognised.
deps::_install_pkgs() {
    local mgr
    mgr="$(deps::_pkg_mgr)"
    if [[ -z "$mgr" ]]; then
        ui::warn "deps: no known package manager (apt/dnf/yum/apk/zypper/pacman) — install ${*} by hand"
        return 2
    fi
    case "$mgr" in
        apt-get)
            DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
            DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
            ;;
        dnf|yum) "$mgr" install -y "$@" ;;
        apk)     apk add --no-cache "$@" ;;
        zypper)  zypper --non-interactive install "$@" ;;
        pacman)  pacman -Sy --noconfirm "$@" ;;
        *)       return 2 ;;
    esac
}

# deps::ensure_tools — install the CLI tools the later phases need when any
# are missing. Fast no-op when everything is already present (re-running
# install-agent.sh on a configured host costs one `command -v` sweep). We
# only chase the deps genuinely absent on a minimal image — jq + the
# openssh client (ssh-keygen) + tar; useradd/install/logger/sha256sum live
# in base packages present on every systemd distro. Best-effort: preflight
# is the hard gate.
deps::ensure_tools() {
    local need=() c
    for c in jq ssh-keygen tar; do
        command -v "$c" >/dev/null 2>&1 || need+=("$c")
    done
    if (( ${#need[@]} == 0 )); then
        ui::ok "Tools: jq, ssh-keygen, tar already present"
        return 0
    fi
    local mgr pkgs
    mgr="$(deps::_pkg_mgr)"
    pkgs="$(deps::_pkg_set "$mgr")"
    ui::step "Installing missing tools (${need[*]}) via ${mgr:-<none>}"
    # shellcheck disable=SC2086  # intentional word-split of the package set
    if ! deps::_install_pkgs $pkgs; then
        ui::warn "deps: tool install did not complete — preflight will report what's still missing"
        return 0
    fi
    ui::ok "Tools installed"
}

# deps::_start_docker — enable + start the daemon (systemd). Best-effort;
# preflight::check_docker is the hard gate.
deps::_start_docker() {
    command -v systemctl >/dev/null 2>&1 || return 0
    systemctl enable --now docker >/dev/null 2>&1 \
        || systemctl start docker >/dev/null 2>&1 \
        || true
}

# deps::ensure_docker — install Docker via the official get.docker.com
# script when the binary is missing, then enable + start the daemon. The
# get.docker.com script no-ops when docker is already present, but we still
# only run it when `command -v docker` fails so a configured host doesn't
# re-hit the network. Best-effort: preflight::check_docker fails the run if
# docker is still unreachable afterwards.
deps::ensure_docker() {
    if command -v docker >/dev/null 2>&1; then
        ui::ok "Docker: already installed"
        deps::_start_docker
        return 0
    fi
    if ! command -v curl >/dev/null 2>&1; then
        ui::warn "deps: curl missing; cannot auto-install Docker — preflight will fail"
        return 0
    fi
    local url="${DEPS_GET_DOCKER_URL:-https://get.docker.com}"
    ui::step "Installing Docker (one-time, ~1 min) via ${url}"
    if ! curl -fsSL "$url" | sh; then
        ui::warn "deps: Docker auto-install failed — preflight will report it"
        return 0
    fi
    deps::_start_docker
    ui::ok "Docker installed"
}

# deps::autoinstall — top-level entry: tools first (so jq is present for
# the bootstrap-config phase), then Docker. Root-only (the agent always
# runs as root; a non-root run skips here and trips preflight::check_root
# with a clear message). Best-effort throughout — preflight is the gate.
deps::autoinstall() {
    if [[ "$(id -u 2>/dev/null || echo 1)" != "0" ]]; then
        ui::warn "deps: not running as root — skipping auto-install (preflight will flag it)"
        return 0
    fi
    deps::ensure_tools
    deps::ensure_docker
}
