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

@test "headscale::_resolve_server_url falls back to headscale.<BASE_DOMAIN> when no override" {
    unset SYNAPSE_HEADSCALE_DOMAIN
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
