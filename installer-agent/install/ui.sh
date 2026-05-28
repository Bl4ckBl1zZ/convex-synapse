# installer-agent/install/ui.sh
# shellcheck shell=bash
#
# Operator-facing UI helpers for install-agent.sh — colored output and
# step/ok/warn/fail logging. Mirrors the smaller subset of
# installer/install/ui.sh (no wizard primitives, no spinner): the
# agent installer is non-interactive in the common one-liner path.
#
# Color discipline matches the main installer:
#   - ANSI emitted only when stdout is a TTY ([[ -t 1 ]]).
#   - $NO_COLOR (https://no-color.org) and $UI_NO_COLOR=1 force colorless.
#   - $UI_FORCE_COLOR=1 forces colors on for ANSI-aware non-TTY consumers.

ui::_color_init() {
    if [[ "${UI_NO_COLOR:-0}" == "1" ]] || [[ -n "${NO_COLOR:-}" ]]; then
        UI_GREEN="" UI_YELLOW="" UI_RED="" UI_CYAN="" UI_BOLD="" UI_RESET=""
    elif [[ "${UI_FORCE_COLOR:-0}" == "1" ]] || [[ -t 1 ]]; then
        UI_GREEN=$'\033[32m'
        UI_YELLOW=$'\033[33m'
        UI_RED=$'\033[31m'
        UI_CYAN=$'\033[36m'
        UI_BOLD=$'\033[1m'
        UI_RESET=$'\033[0m'
    else
        UI_GREEN="" UI_YELLOW="" UI_RED="" UI_CYAN="" UI_BOLD="" UI_RESET=""
    fi
}

# ui::ok is the install-agent alias for ui::success — the assignment
# names the helpers `ui::ok` so install-agent.sh sites read naturally.
# We export both names so callers don't have to care.
ui::ok()      { ui::_color_init; printf '%s✓%s %s\n' "$UI_GREEN"  "$UI_RESET" "$*"; }
ui::success() { ui::ok "$@"; }
ui::warn()    { ui::_color_init; printf '%s!%s %s\n' "$UI_YELLOW" "$UI_RESET" "$*"; }
ui::fail()    { ui::_color_init; printf '%s✗%s %s\n' "$UI_RED"    "$UI_RESET" "$*" >&2; }
ui::info()    { ui::_color_init; printf '%sℹ%s %s\n' "$UI_CYAN"   "$UI_RESET" "$*"; }

# ui::step — phase header. Blank line above for visual separation.
ui::step() {
    ui::_color_init
    printf '\n%s==>%s %s%s%s\n' "$UI_CYAN" "$UI_RESET" "$UI_BOLD" "$*" "$UI_RESET"
}

# ui::redact <stream-of-text>
# Strip bearer-shaped values from a string so we never echo a token. Used
# by install-agent.sh whenever we surface a raw API response to the
# operator (success path or failure). Matches both JSON fields and
# Authorization-header-looking lines.
#
# IMPORTANT: this is defence-in-depth; the primary contract is that
# install-agent.sh NEVER passes a raw token to ui::*. The helper is
# here so a slip becomes a "<redacted>" in the log, not a leak.
ui::redact() {
    sed -E \
        -e 's/("(agent|admin|adoption|tailscale|auth|api)?[Tt]oken"[[:space:]]*:[[:space:]]*")[^"]+/\1<redacted>/g' \
        -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._-]+/\1<redacted>/g' \
        -e 's/(--auth-key=)[^[:space:]]+/\1<redacted>/g' \
        -e 's/(--adoption-token=)[^[:space:]]+/\1<redacted>/g' \
        -e 's/(--headscale-auth=)[^[:space:]]+/\1<redacted>/g'
}
