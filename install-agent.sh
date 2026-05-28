#!/usr/bin/env bash
#
# Synapse — Remote Hosts agent installer (Phase 2, v1.18).
#
# Run on a fresh VPS via the hosted one-liner that the dashboard
# generates under Hosts → Adopt host:
#
#     curl -fsSL https://synapsepanel.com/install-agent.sh | sudo bash -s -- \
#         --control-url=https://synapsepanel.com \
#         --headscale-auth=<tailscale-pre-auth-key> \
#         --adoption-token=<syn_adopt_xxx>
#
# Or, after `git clone`:
#
#     sudo ./install-agent.sh \
#         --control-url=https://... \
#         --headscale-auth=... \
#         --adoption-token=...
#
# The script automates the "Install as a systemd service on a VPS"
# procedure documented in docs/HOSTS_AND_AGENTS.md, plus the
# Phase 2 Tailscale/SSH plumbing:
#
#   1. Preflight (Linux, amd64/arm64, root, systemd, docker, deps,
#      control-URL reachable).
#   2. Tailscale install + `tailscale up` against Headscale using the
#      operator-supplied pre-auth key.
#   3. GET /v1/install_agent/config from the control plane for the
#      release/download metadata.
#   4. Download + SHA256-verify the synapse-agent tarball; install
#      /usr/local/bin/synapse-agent.
#   5. Create system users: synapse-agent (observer) and synapse-deployer
#      (SSH ForceCommand target).
#   6. Generate ed25519 keypair for synapse-deployer; render sshd_config.d
#      drop-in; install /usr/local/bin/synapse-deployer-exec wrapper.
#   7. POST /v1/agents/register with adoption_token + tailnet IP + SSH
#      pubkey → persist agent token to /etc/synapse-agent/config.json
#      (mode 0600).
#   8. Install + enable synapse-agent.service.
#   9. Verify by polling journalctl until "heartbeat ok" lands.
#
# Everything lives inside `main()` and is invoked at EOF. This is the
# Tailscale curl-pipe-shell idiom: a download truncated mid-file
# can't execute partial logic because the function is never called.
#
# When invoked via `curl | bash`, the installer-agent/ directory
# holding the dot-included libraries doesn't ship alongside this
# single file. needs_bootstrap detects that case and bootstrap()
# git-clones the repo into a temp dir + re-execs install-agent.sh
# from there with the same args. Operators who ran `git clone` see
# no behaviour change — installer-agent/ is already next to
# install-agent.sh.
#
# SECRET HYGIENE: this script accepts THREE secrets on the CLI —
# --headscale-auth, --adoption-token, the SSH private key it writes
# to disk. None are echoed to stdout/stderr, none are written to the
# install log. Anything we surface to the operator is filtered
# through ui::redact (installer-agent/install/ui.sh) before printing.

set -Eeuo pipefail

readonly INSTALL_AGENT_VERSION="1.18.0"
readonly INSTALL_DIR_DEFAULT="/etc/synapse-agent"
readonly LOG_FILE="${SYNAPSE_AGENT_INSTALL_LOG:-/tmp/synapse-agent-install.log}"
readonly LOCK_FILE="/run/install-agent.lock"
readonly BOOTSTRAP_REPO_URL="${SYNAPSE_BOOTSTRAP_REPO_URL:-https://github.com/Iann29/convex-synapse.git}"
readonly BOOTSTRAP_REF="${SYNAPSE_BOOTSTRAP_REF:-main}"

# Resolve the script dir so we can dot-include the installer-agent/
# libraries regardless of how we were invoked. Same pattern as setup.sh:
# under `curl | bash`, BASH_SOURCE[0] is empty — that's the bootstrap
# signal.
_setup_src="${BASH_SOURCE[0]:-}"
if [[ -n "$_setup_src" && -f "$_setup_src" ]]; then
    HERE="$(cd "$(dirname "$_setup_src")" && pwd)"
else
    HERE=""
fi
unset _setup_src
readonly INSTALLER_AGENT_TEMPLATES="${HERE:+$HERE/installer-agent/templates}"
export INSTALLER_AGENT_TEMPLATES

# CURRENT_STEP is set at the top of each phase so the ERR trap message
# names which step crashed without a stack trace.
CURRENT_STEP="initialising"

trap 'on_err $? "${BASH_LINENO[0]}" "${FUNCNAME[1]:-main}" "${BASH_COMMAND}"' ERR
trap 'on_exit $?' EXIT

on_err() {
    local rc=$1 line=$2 fn=$3 cmd=$4
    # Filter the command line through ui::redact so a `tailscale up
    # --auth-key=tskey-...` failure doesn't dump the key into the log.
    local safe_cmd
    if declare -F ui::redact >/dev/null 2>&1; then
        safe_cmd="$(printf '%s' "$cmd" | ui::redact)"
    else
        safe_cmd="$cmd"
    fi
    {
        printf '\n[FATAL] %s failed (exit %d) at line %d in %s()\n' \
            "$CURRENT_STEP" "$rc" "$line" "$fn"
        printf '  command: %s\n' "$safe_cmd"
        printf '  log: %s\n' "$LOG_FILE"
    } >&2
}

on_exit() {
    local rc=$1
    rm -f "$LOCK_FILE.fd" 2>/dev/null || true
    if (( rc != 0 )); then
        : # nothing to roll back yet — keep partial state so the operator
          # can re-run install-agent.sh and the idempotent phases pick
          # up where we left off.
    fi
}

# usage --------------------------------------------------------------

usage() {
    cat <<'EOF'
Synapse remote-host agent installer

Usage:
    install-agent.sh [options]

Required (or interactive prompt when stdin is a TTY):
    --control-url=URL         Synapse control-plane URL
                              (e.g. https://synapsepanel.com).
    --headscale-auth=KEY      Tailscale pre-auth key minted by the
                              backend's Headscale provisioner.
    --adoption-token=TOKEN    One-time Synapse adoption token (syn_adopt_...)
                              minted in the dashboard under Hosts →
                              Adopt host. Single-use; expires after use.

Optional:
    --agent-version=v1.X.Y    Override the synapse-agent version. By
                              default the version is taken from
                              /v1/install_agent/config (so the dashboard
                              decides which release is current).
    --install-dir=PATH        Agent config dir. Default: /etc/synapse-agent
    --ssh-user=NAME           Deployer SSH username. Default:
                              synapse-deployer. Fork override only —
                              the backend assumes the default name.
    --no-tailscale-install    Skip the Tailscale install step (operator
                              already has it on PATH).
    --non-interactive         Hard-fail on missing required flags
                              instead of prompting.
    --no-bootstrap            Skip the curl|bash bootstrap re-exec even
                              when installer-agent/ is missing. Useful
                              for tests and for running install-agent.sh
                              from a custom checkout.
    --version                 Print installer version and exit.
    --help                    This message.

Environment:
    SYNAPSE_AGENT_INSTALL_LOG       Override log path
    SYNAPSE_BOOTSTRAP_REPO_URL      Git URL for the bootstrap re-exec
    SYNAPSE_BOOTSTRAP_REF           Git ref for the bootstrap re-exec
EOF
}

# CLI parsing --------------------------------------------------------

parse_flags() {
    CONTROL_URL=""
    HEADSCALE_AUTH=""
    ADOPTION_TOKEN=""
    AGENT_VERSION_OVERRIDE=""
    INSTALL_DIR="$INSTALL_DIR_DEFAULT"
    SSH_USER="synapse-deployer"
    NO_TAILSCALE_INSTALL=0
    NO_BOOTSTRAP=0
    SHOW_VERSION=0
    SHOW_HELP=0
    while (( $# > 0 )); do
        case "$1" in
            --control-url=*)        CONTROL_URL="${1#*=}" ;;
            --headscale-auth=*)     HEADSCALE_AUTH="${1#*=}" ;;
            --adoption-token=*)     ADOPTION_TOKEN="${1#*=}" ;;
            --agent-version=*)      AGENT_VERSION_OVERRIDE="${1#*=}" ;;
            --install-dir=*)        INSTALL_DIR="${1#*=}" ;;
            --ssh-user=*)           SSH_USER="${1#*=}" ;;
            --no-tailscale-install) NO_TAILSCALE_INSTALL=1 ;;
            --non-interactive)      export SYNAPSE_NON_INTERACTIVE=1 ;;
            --no-bootstrap)         NO_BOOTSTRAP=1 ;;
            --version)              SHOW_VERSION=1 ;;
            --help|-h)              SHOW_HELP=1 ;;
            *) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
        esac
        shift
    done
    # Trim the URL's trailing slash so we can append "/v1/..." cleanly.
    CONTROL_URL="${CONTROL_URL%/}"
}

# require_flag_or_prompt <flag-name> <var-name> <prompt-text> [secret=0]
# When the value is empty and stdin is a TTY and --non-interactive isn't
# set, prompt for the value. Otherwise hard-fail with a precise message.
# secret=1 disables echo (read -s) so a pasted token doesn't smear the log.
require_flag_or_prompt() {
    local flag="$1" var="$2" prompt="$3" secret="${4:-0}"
    local cur
    cur="$(eval "printf '%s' \"\${$var:-}\"")"
    if [[ -n "$cur" ]]; then
        return 0
    fi
    if [[ -n "${SYNAPSE_NON_INTERACTIVE:-}" ]] || [[ ! -t 0 ]]; then
        echo "error: missing required flag $flag" >&2
        return 2
    fi
    local val
    # shellcheck disable=SC2034  # `val` is consumed via `eval "$var=\$val"` below
    : "${val:=}"
    if (( secret )); then
        read -r -s -p "$prompt: " val
        echo
    else
        read -r -p "$prompt: " val
    fi
    eval "$var=\"\$val\""
}

# Single-instance via flock (mirror setup.sh). /run is always present on
# systemd hosts which we've already required in preflight. Lock survives
# subshells; released on process exit by the EXIT trap rm -f.
acquire_lock() {
    exec 9>"$LOCK_FILE.fd" || {
        echo "could not open $LOCK_FILE.fd" >&2
        exit 2
    }
    if ! flock -n 9; then
        echo "another install-agent.sh is already running (lock: $LOCK_FILE.fd)" >&2
        exit 2
    fi
}

# Bootstrap (curl | bash) --------------------------------------------
#
# Same pattern as setup.sh: when invoked via `curl | bash`, the
# installer-agent/ tree is not on disk. needs_bootstrap detects that;
# bootstrap clones the repo and re-execs install-agent.sh from the clone.

# needs_bootstrap [<dir>]
# Returns 0 (true) when no installer-agent/ tree is reachable from <dir>
# (default: $HERE). Empty <dir> always counts as needing bootstrap.
needs_bootstrap() {
    local dir="${1-$HERE}"
    if [[ -z "$dir" ]]; then
        return 0
    fi
    if [[ ! -d "$dir/installer-agent" ]]; then
        return 0
    fi
    return 1
}

# bootstrap_target_dir — same precedence as setup.sh.
bootstrap_target_dir() {
    local pid=$$
    if [[ -d /tmp && -w /tmp ]]; then
        printf '/tmp/convex-synapse-agent-bootstrap-%s' "$pid"
        return 0
    fi
    local home="${HOME:-/root}"
    if [[ -d "$home" && -w "$home" ]]; then
        printf '%s/.synapse-agent-bootstrap-%s' "$home" "$pid"
        return 0
    fi
    return 1
}

bootstrap() {
    if ! command -v git >/dev/null 2>&1; then
        printf 'error: git is required for the curl|bash bootstrap.\n' >&2
        printf '  install it first (apt-get install -y git / dnf install -y git) and re-run.\n' >&2
        exit 2
    fi
    local target
    if ! target="$(bootstrap_target_dir)"; then
        # shellcheck disable=SC2016  # literal $HOME in operator-facing message
        printf 'error: no writable temp dir for bootstrap (/tmp + $HOME both unusable).\n' >&2
        exit 2
    fi
    if [[ -e "$target" ]]; then
        rm -rf "$target"
    fi
    printf 'Bootstrapping install-agent.sh from %s (ref: %s)...\n' \
        "$BOOTSTRAP_REPO_URL" "$BOOTSTRAP_REF" >&2
    printf '  target: %s\n' "$target" >&2
    if ! git clone --depth=1 --branch "$BOOTSTRAP_REF" \
            "$BOOTSTRAP_REPO_URL" "$target" >&2; then
        printf 'error: git clone failed. Check network + that the ref %s exists.\n' \
            "$BOOTSTRAP_REF" >&2
        exit 2
    fi
    if [[ ! -x "$target/install-agent.sh" ]]; then
        printf 'error: cloned repo has no install-agent.sh at %s/install-agent.sh\n' "$target" >&2
        exit 2
    fi
    printf 'Re-executing install-agent.sh from %s\n' "$target" >&2
    export SYNAPSE_AGENT_BOOTSTRAPPED=1
    exec "$target/install-agent.sh" "$@"
}

# Source libs --------------------------------------------------------

source_libs() {
    # shellcheck source=installer-agent/install/ui.sh
    . "$HERE/installer-agent/install/ui.sh"
    # shellcheck source=installer-agent/install/preflight.sh
    . "$HERE/installer-agent/install/preflight.sh"
    # shellcheck source=installer-agent/install/tailscale.sh
    . "$HERE/installer-agent/install/tailscale.sh"
    # shellcheck source=installer-agent/install/users.sh
    . "$HERE/installer-agent/install/users.sh"
    # shellcheck source=installer-agent/install/ssh.sh
    . "$HERE/installer-agent/install/ssh.sh"
    # shellcheck source=installer-agent/install/agent.sh
    . "$HERE/installer-agent/install/agent.sh"
    # shellcheck source=installer-agent/install/verify.sh
    . "$HERE/installer-agent/install/verify.sh"
}

# Phases -------------------------------------------------------------

phase_banner() {
    CURRENT_STEP="banner"
    ui::step "Synapse host agent installer v${INSTALL_AGENT_VERSION}"
    ui::info "Control URL:  $CONTROL_URL"
    ui::info "Install dir:  $INSTALL_DIR"
    ui::info "SSH user:     $SSH_USER"
    ui::info "Log file:     $LOG_FILE"
}

phase_preflight() {
    CURRENT_STEP="preflight"
    ui::step "Pre-flight checks"
    # preflight::run_all echoes the normalised arch on the success path.
    local arch
    if ! arch="$(preflight::run_all "$CONTROL_URL")"; then
        return 2
    fi
    ARCH="$arch"
    export ARCH
}

phase_bootstrap_config() {
    CURRENT_STEP="bootstrap_config"
    local resp
    resp="$(agent::bootstrap_config "$CONTROL_URL")"
    HEADSCALE_SERVER_URL="$(printf '%s' "$resp" | jq -r '.headscaleServerUrl // empty')"
    DOWNLOAD_URL_TEMPLATE="$(printf '%s' "$resp" | jq -r '.downloadUrl // empty')"
    BOOTSTRAP_AGENT_VERSION="$(printf '%s' "$resp" | jq -r '.agentVersion // empty')"
    if [[ -z "$HEADSCALE_SERVER_URL" ]]; then
        ui::fail "Bootstrap config missing headscaleServerUrl"
        return 2
    fi
    if [[ -z "$DOWNLOAD_URL_TEMPLATE" ]]; then
        ui::fail "Bootstrap config missing downloadUrl"
        return 2
    fi
    # CLI override > server-decided version.
    AGENT_VERSION="${AGENT_VERSION_OVERRIDE:-$BOOTSTRAP_AGENT_VERSION}"
    if [[ -z "$AGENT_VERSION" ]]; then
        ui::fail "Bootstrap config missing agentVersion and --agent-version not set"
        return 2
    fi
    ui::ok "Headscale: $HEADSCALE_SERVER_URL  Agent version: $AGENT_VERSION"
}

phase_tailscale() {
    CURRENT_STEP="tailscale"
    tailscale::install
    tailscale::join "$HEADSCALE_SERVER_URL" "$HEADSCALE_AUTH"
    TAILNET_ADDR="$(tailscale::wait_ready)"
}

phase_download_agent() {
    CURRENT_STEP="download_agent"
    agent::download "$AGENT_VERSION" "$ARCH" "$DOWNLOAD_URL_TEMPLATE"
}

phase_users() {
    CURRENT_STEP="users"
    ui::step "Creating system users (synapse-agent, $SSH_USER)"
    users::ensure
}

phase_ssh() {
    CURRENT_STEP="ssh"
    ui::step "Setting up SSH for deployer"
    SSH_PUBKEY="$(ssh::generate_keypair)"
    ssh::install_deployer_exec
    ssh::configure_sshd "$TAILNET_ADDR"
    ssh::install_authorized_keys "$SSH_PUBKEY"
}

phase_register() {
    CURRENT_STEP="register"
    agent::register "$CONTROL_URL" "$ADOPTION_TOKEN" "$TAILNET_ADDR" "$SSH_PUBKEY"
}

phase_systemd() {
    CURRENT_STEP="systemd"
    ui::step "Installing synapse-agent systemd unit"
    agent::install_systemd
}

phase_verify() {
    CURRENT_STEP="verify"
    verify::heartbeat
}

phase_success_screen() {
    CURRENT_STEP="success"
    ui::step "Host adoption complete"
    ui::info "Tailnet IP:   $TAILNET_ADDR"
    ui::info "Agent dir:    $INSTALL_DIR"
    ui::info "Service:      synapse-agent.service (systemctl status synapse-agent)"
    ui::info "Logs:         journalctl -u synapse-agent -f"
    ui::ok   "Host is now online in the Synapse dashboard."
}

# main ---------------------------------------------------------------

main() {
    parse_flags "$@"

    if (( SHOW_VERSION )); then
        echo "install-agent.sh $INSTALL_AGENT_VERSION"
        exit 0
    fi
    if (( SHOW_HELP )); then
        usage
        exit 0
    fi

    # Refuse non-Linux up front so a macOS operator doesn't waste a
    # bootstrap clone discovering systemd is missing.
    if [[ "$(uname -s 2>/dev/null)" != "Linux" ]]; then
        echo "error: install-agent.sh requires Linux" >&2
        exit 2
    fi

    # Bootstrap re-exec: when fetched via curl|bash the installer-agent/
    # libs aren't next to us. Clone the repo into a temp dir and exec
    # from there. --no-bootstrap escapes the loop for tests;
    # SYNAPSE_AGENT_BOOTSTRAPPED=1 is set by the parent install-agent.sh
    # on the re-exec so we don't clone twice.
    if (( ! NO_BOOTSTRAP )) && [[ -z "${SYNAPSE_AGENT_BOOTSTRAPPED:-}" ]] \
            && needs_bootstrap; then
        bootstrap "$@"
        exit 2  # bootstrap execs; reaching here = failure
    fi

    # Interactive prompts for the three secrets. No-op when --non-interactive
    # or stdin isn't a TTY; in those cases missing values are hard errors.
    require_flag_or_prompt --control-url     CONTROL_URL    "Synapse control URL"          0
    require_flag_or_prompt --headscale-auth  HEADSCALE_AUTH "Tailscale pre-auth key"       1
    require_flag_or_prompt --adoption-token  ADOPTION_TOKEN "Synapse adoption token"       1
    CONTROL_URL="${CONTROL_URL%/}"

    # Mirror stdout+stderr to the log AFTER we know we're running. A
    # bare --version / --help shouldn't create a dangling log. The
    # token-bearing values were already consumed into shell vars; we
    # rely on ui::redact for anything that might surface a token
    # through a command line in ERR traps.
    if [[ -w "$(dirname "$LOG_FILE")" ]]; then
        exec > >(tee -a "$LOG_FILE") 2>&1
    fi

    source_libs
    acquire_lock

    phase_banner
    phase_preflight
    phase_bootstrap_config
    phase_tailscale
    phase_download_agent
    phase_users
    phase_ssh
    phase_register
    phase_systemd
    phase_verify
    phase_success_screen
}

# Skip the actual run when sourced from a test (so bats can probe
# individual functions without triggering preflight / curl). The
# Tailscale truncation-safety property is preserved: a half-downloaded
# script still won't reach this line.
if [[ -z "${__SETUP_NO_MAIN:-}" ]]; then
    main "$@"
fi
