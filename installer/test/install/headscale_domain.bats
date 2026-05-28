#!/usr/bin/env bats
# installer/test/install/headscale_domain.bats
#
# Regression test for v1.18.2: SYNAPSE_HEADSCALE_DOMAIN MUST take
# precedence over SYNAPSE_BASE_DOMAIN when present. Without that
# override, operators with a deployments wildcard (e.g.
# *.app.example.com) under on_demand TLS can't ever land a Headscale
# cert because tls_ask refuses non-deployment subdomains.

load "../helpers/load"

setup() {
    # Source the function-under-test from the same locations setup.sh
    # would. Keep all "ui::*", "secrets::*" stubs out — we exercise the
    # pure resolution helper only.
    source "$INSTALLER_DIR/install/headscale.sh"
}

@test "headscale::_resolve_server_url uses HEADSCALE_DOMAIN override when set" {
    SYNAPSE_HEADSCALE_DOMAIN="headscale.example.com" \
    SYNAPSE_BASE_DOMAIN="app.example.com" \
        run headscale::_resolve_server_url
    [ "$status" -eq 0 ]
    [ "$output" = "https://headscale.example.com" ]
}

@test "headscale::_resolve_server_url prefers SYNAPSE_DOMAIN over SYNAPSE_BASE_DOMAIN (v1.19+)" {
    # The v1.19+ default: when the operator has both a dashboard
    # domain (synapsepanel.com) and a deployments wildcard
    # (app.synapsepanel.com), Headscale lives at headscale.<dashboard>,
    # NOT headscale.<wildcard>. The wildcard's on-demand TLS would
    # otherwise refuse to issue a cert because tls_ask gates on real
    # deployments only.
    unset SYNAPSE_HEADSCALE_DOMAIN
    SYNAPSE_DOMAIN="synapsepanel.com" \
    SYNAPSE_BASE_DOMAIN="app.synapsepanel.com" \
        run headscale::_resolve_server_url
    [ "$status" -eq 0 ]
    [ "$output" = "https://headscale.synapsepanel.com" ]
}

@test "headscale::_resolve_server_url HEADSCALE_DOMAIN override wins over SYNAPSE_DOMAIN" {
    SYNAPSE_HEADSCALE_DOMAIN="tailscale-control.example.org" \
    SYNAPSE_DOMAIN="synapsepanel.com" \
    SYNAPSE_BASE_DOMAIN="app.synapsepanel.com" \
        run headscale::_resolve_server_url
    [ "$status" -eq 0 ]
    [ "$output" = "https://tailscale-control.example.org" ]
}

@test "headscale::_resolve_server_url falls back to headscale.<BASE_DOMAIN> when no override AND no host domain" {
    # v1.19+ regression guard: without SYNAPSE_DOMAIN the resolver
    # MUST still emit a sensible value rather than refusing —
    # base-domain-only installs are a supported configuration.
    unset SYNAPSE_HEADSCALE_DOMAIN SYNAPSE_DOMAIN
    SYNAPSE_BASE_DOMAIN="app.example.com" \
        run headscale::_resolve_server_url
    [ "$status" -eq 0 ]
    [ "$output" = "https://headscale.app.example.com" ]
}
@test "headscale::_resolve_server_url strips leading dot from HEADSCALE_DOMAIN" {
    SYNAPSE_HEADSCALE_DOMAIN=".headscale.example.com" \
        run headscale::_resolve_server_url
    [ "$status" -eq 0 ]
    [ "$output" = "https://headscale.example.com" ]
}

@test "headscale::_resolve_server_url returns empty when no hostname source" {
    unset SYNAPSE_HEADSCALE_DOMAIN SYNAPSE_BASE_DOMAIN
    unset SYNAPSE_PUBLIC_IP SYNAPSE_HEADSCALE_PORT
    run headscale::_resolve_server_url
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "headscale::_resolve_server_url backfills from existing SYNAPSE_HEADSCALE_SERVER_URL (v1.19.1 upgrade safety)" {
    # Regression for the v1.18→v1.19 upgrade footgun. A v1.18 install
    # that used the auto-derived `headscale.<SYNAPSE_BASE_DOMAIN>` had
    # SERVER_URL stamped but never SYNAPSE_HEADSCALE_DOMAIN. v1.19
    # changed the preference to SYNAPSE_DOMAIN over BASE_DOMAIN, so
    # the next `--configure-headscale` would silently move the
    # subdomain and break every existing tailnet client. The backfill
    # check at the top of _resolve_server_url honors the persisted
    # SERVER_URL, keeping configure-headscale idempotent after upgrade.
    unset SYNAPSE_HEADSCALE_DOMAIN
    SYNAPSE_HEADSCALE_SERVER_URL="https://headscale.app.example.com" \
    SYNAPSE_DOMAIN="example.com" \
    SYNAPSE_BASE_DOMAIN="app.example.com" \
        run headscale::_resolve_server_url
    [ "$status" -eq 0 ]
    [ "$output" = "https://headscale.app.example.com" ]
}

@test "headscale::_resolve_server_url HEADSCALE_DOMAIN override still wins over persisted SERVER_URL" {
    # Operators who explicitly set --headscale-domain= want the new
    # value, not the persisted one. The override must win the order.
    SYNAPSE_HEADSCALE_DOMAIN="new.example.org" \
    SYNAPSE_HEADSCALE_SERVER_URL="https://old.example.com" \
    SYNAPSE_DOMAIN="example.com" \
        run headscale::_resolve_server_url
    [ "$status" -eq 0 ]
    [ "$output" = "https://new.example.org" ]
}

@test "headscale::_user_id resolves username to numeric ID from JSON (v1.19.8)" {
    # Headscale 0.28's preauthkey CLI/API takes the numeric user ID,
    # not the name. v1.19.8 parses `headscale users list -o json` with
    # jq (format-stable) — the old awk table parse missed an existing
    # user on a real box (version-update WRN line + column drift), so
    # the control-plane tailnet join failed with "could not resolve
    # user id". Stub _compose to return the 0.28 JSON array.
    eval 'headscale::_compose() {
        cat <<JSON
[
  { "id": 1, "name": "synapse", "created_at": { "seconds": 1779996216, "nanos": 0 } }
]
JSON
    }'
    run headscale::_user_id synapse
    [ "$status" -eq 0 ]
    [ "$output" = "1" ]
}

@test "headscale::_user_id tolerates a WRN line ahead of the JSON" {
    # Some headscale builds print a "newer version available" WRN to
    # stdout before the JSON array. _user_id strips any non-JSON
    # preamble so jq still parses.
    eval 'headscale::_compose() {
        printf "%s\n" "2026-01-01T00:00:00Z WRN An updated version of Headscale ..."
        cat <<JSON
[ { "id": 7, "name": "synapse" } ]
JSON
    }'
    run headscale::_user_id synapse
    [ "$status" -eq 0 ]
    [ "$output" = "7" ]
}

@test "headscale::_user_id is empty when the user is absent (JSON)" {
    eval 'headscale::_compose() {
        cat <<JSON
[ { "id": 1, "name": "other" } ]
JSON
    }'
    run headscale::_user_id synapse
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}
