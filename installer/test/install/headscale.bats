#!/usr/bin/env bats
# installer/test/install/headscale.bats
#
# Sanity tests for the Headscale config template. We can't spin up a
# real headscale binary in CI, but we CAN guard against regressing the
# config-validation surface that bit us on v1.18.0 → v1.18.1: Headscale
# 0.28+ refuses to start when `dns.override_local_dns` is true (its
# default) AND `dns.nameservers.global` is unset. The template MUST
# carry `override_local_dns: false` so we never trip that path.

load "../helpers/load"

@test "headscale config template exists and is non-empty" {
    local tmpl="$INSTALLER_DIR/templates/headscale.config.yaml.tmpl"
    [ -r "$tmpl" ]
    [ -s "$tmpl" ]
}

@test "headscale config template sets magic_dns: false" {
    local tmpl="$INSTALLER_DIR/templates/headscale.config.yaml.tmpl"
    run grep -E '^[[:space:]]+magic_dns:[[:space:]]+false[[:space:]]*$' "$tmpl"
    [ "$status" -eq 0 ]
}

@test "headscale config template sets override_local_dns: false (regression v1.18.1)" {
    # Headscale 0.28 fail-fast:
    #   FTL Error initializing error="loading configuration: Fatal config
    #   error: dns.nameservers.global must be set when dns.override_local_dns
    #   is true"
    # Setting override_local_dns: false explicitly avoids the trap without
    # forcing us to ship public nameservers onto operator VPSs.
    local tmpl="$INSTALLER_DIR/templates/headscale.config.yaml.tmpl"
    run grep -E '^[[:space:]]+override_local_dns:[[:space:]]+false[[:space:]]*$' "$tmpl"
    [ "$status" -eq 0 ]
}

@test "headscale config template's dns block is parseable as a single map" {
    # A future contributor who adds a second dns: block (e.g. by
    # accident during a merge) would silently break the rendered
    # config. Catch the double-key here.
    local tmpl="$INSTALLER_DIR/templates/headscale.config.yaml.tmpl"
    run grep -cE '^dns:[[:space:]]*$' "$tmpl"
    [ "$status" -eq 0 ]
    [ "$output" = "1" ]
}
