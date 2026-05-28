# installer-agent/install/preflight.sh
# shellcheck shell=bash
#
# Pre-flight checks for install-agent.sh.
#
# Each check returns 0 on pass / 2 on fail; warnings return 0 after
# emitting ui::warn (the agent installer is intentionally less tolerant
# than setup.sh — most preflight failures here are hard blockers because
# the alternative is a half-registered host that needs manual cleanup).
#
# Composes ui:: helpers from installer-agent/install/ui.sh. install-agent.sh
# is responsible for sourcing ui.sh BEFORE this file.

# preflight::check_linux — refuse non-Linux up front.
preflight::check_linux() {
    local os
    os="$(uname -s 2>/dev/null || echo unknown)"
    if [[ "$os" != "Linux" ]]; then
        ui::fail "OS: $os — install-agent.sh requires Linux"
        return 2
    fi
    ui::ok "OS: Linux"
}

# preflight::check_arch — normalise uname -m into amd64/arm64. Echo
# the normalised value on stdout so callers can capture ARCH.
preflight::check_arch() {
    local raw
    raw="$(uname -m 2>/dev/null || echo unknown)"
    local arch
    case "$raw" in
        x86_64|amd64)   arch="amd64" ;;
        aarch64|arm64)  arch="arm64" ;;
        *)
            ui::fail "Architecture: $raw — only amd64 and arm64 are supported"
            return 2
            ;;
    esac
    ui::ok "Architecture: $arch"
    printf '%s\n' "$arch"
}

# preflight::check_root — install-agent.sh writes /usr/local/bin,
# /etc/systemd, /etc/ssh/sshd_config.d/, creates users, reloads sshd.
# Hard root requirement; sudo is fine but the script itself must run
# under uid 0 (we don't sudo-each-command).
preflight::check_root() {
    if [[ "$EUID" -eq 0 ]]; then
        ui::ok "Privileges: running as root"
        return 0
    fi
    ui::fail "Privileges: install-agent.sh must run as root (try: sudo bash install-agent.sh ...)"
    return 2
}

# preflight::check_systemd — we install a systemd unit; the unit
# manager has to be PID 1 (or at least active).
preflight::check_systemd() {
    if [[ -d /run/systemd/system ]]; then
        ui::ok "Init: systemd active"
        return 0
    fi
    if command -v systemctl >/dev/null 2>&1; then
        if systemctl --version >/dev/null 2>&1; then
            ui::ok "Init: systemctl available"
            return 0
        fi
    fi
    ui::fail "Init: systemd not detected — install-agent.sh needs a systemd-based host"
    return 2
}

# preflight::check_docker — the synapse-agent reads `docker version`
# and `docker ps` for facts and observed state. Docker daemon must be
# reachable from root (we add synapse-agent + synapse-deployer to the
# `docker` group later).
preflight::check_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        ui::fail "Docker: 'docker' binary not on PATH (install Docker first: https://docs.docker.com/engine/install/)"
        return 2
    fi
    if ! docker version >/dev/null 2>&1; then
        ui::fail "Docker: daemon not reachable (try: systemctl start docker)"
        return 2
    fi
    ui::ok "Docker: daemon reachable"
}

# preflight::check_deps — curl + jq + ssh-keygen + tar + sha256sum
# are all used by later phases. Fail loudly here instead of mid-install.
preflight::check_deps() {
    local missing=()
    local d
    for d in curl jq ssh-keygen tar sha256sum useradd usermod install logger; do
        if ! command -v "$d" >/dev/null 2>&1; then
            missing+=("$d")
        fi
    done
    if (( ${#missing[@]} > 0 )); then
        ui::fail "Missing tools: ${missing[*]} (install via your package manager: apt-get install -y jq openssh-client coreutils)"
        return 2
    fi
    ui::ok "Tools: curl jq ssh-keygen tar sha256sum useradd usermod install logger"
}

# preflight::check_control_url <url>
# HEAD against the control-plane URL — confirms we have outbound network
# AND the URL is well-formed AND the operator didn't typo it. We don't
# require a 2xx (some installs put a 401 wall in front of /), just that
# we got SOMETHING back from a TLS handshake.
preflight::check_control_url() {
    local url="$1"
    if [[ -z "$url" ]]; then
        ui::fail "Control URL: empty (pass --control-url=https://your-synapse.example.com)"
        return 2
    fi
    # curl -fsSI returns non-zero on 4xx/5xx, but we want to accept those
    # (a control plane behind auth still proves connectivity). Use --max-time
    # so a black-hole host doesn't hang the installer for 2 minutes.
    if curl -sS -o /dev/null -I --max-time 10 "$url" >/dev/null 2>&1; then
        ui::ok "Control URL reachable: $url"
        return 0
    fi
    # Retry once without -I in case the server refuses HEAD (some Caddy
    # configs answer 405 for HEAD on /).
    if curl -sS -o /dev/null --max-time 10 "$url" >/dev/null 2>&1; then
        ui::ok "Control URL reachable: $url"
        return 0
    fi
    ui::fail "Control URL unreachable: $url (check DNS, firewall, --control-url=)"
    return 2
}

# preflight::run_all <control-url>
# Run every check; collect the failure count and return non-zero if any
# failed. We don't short-circuit on the first failure so the operator
# sees the full picture (one fix per re-run is annoying).
#
# Echoes the normalised arch on stdout when ALL checks pass; install-agent.sh
# captures it into the ARCH global.
preflight::run_all() {
    local control_url="$1"
    local failures=0
    local arch=""

    preflight::check_linux   || (( ++failures ))
    if ! arch="$(preflight::check_arch)"; then
        (( ++failures ))
    fi
    preflight::check_root    || (( ++failures ))
    preflight::check_systemd || (( ++failures ))
    preflight::check_docker  || (( ++failures ))
    preflight::check_deps    || (( ++failures ))
    preflight::check_control_url "$control_url" || (( ++failures ))

    if (( failures > 0 )); then
        ui::fail "Pre-flight: $failures check(s) failed; fix the above and re-run install-agent.sh"
        return 2
    fi
    printf '%s\n' "$arch"
    return 0
}
