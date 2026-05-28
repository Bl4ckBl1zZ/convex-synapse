#!/usr/bin/env bats
# installer/test/install/headscale_policy.bats
#
# v1.19+ — the default Headscale ACL policy ships tag-based least-
# privilege, not the legacy permissive `src:["*"], dst:["*:*"]`. The
# control plane is tagged `tag:synapse-control`; every host added via
# Admin → Hosts → Setup remote install gets `tag:synapse-remote`.
# Control → remote on port 22 only. Anything else is denied.

load "../helpers/load"

@test "headscale.policy.hujson defines synapse-control + synapse-remote tagOwners" {
    local tmpl="$INSTALLER_DIR/templates/headscale.policy.hujson"
    [ -r "$tmpl" ]
    run grep -E '"tag:synapse-control":' "$tmpl"
    [ "$status" -eq 0 ]
    run grep -E '"tag:synapse-remote":' "$tmpl"
    [ "$status" -eq 0 ]
}

@test "headscale.policy.hujson allows tag:synapse-control → tag:synapse-remote:22" {
    local tmpl="$INSTALLER_DIR/templates/headscale.policy.hujson"
    # Multi-line hujson — read the file and assert both sides of the
    # ACL rule appear together. Bats's `run` captures the grep output;
    # we just need a non-zero hit for each anchor.
    run grep -F 'tag:synapse-control' "$tmpl"
    [ "$status" -eq 0 ]
    run grep -F 'tag:synapse-remote:22' "$tmpl"
    [ "$status" -eq 0 ]
}

@test "headscale.policy.hujson does NOT carry the legacy permissive *:* rule" {
    # Regression guard: the v1.18.x default was `src:["*"], dst:["*:*"]`.
    # If a future merge accidentally re-introduces it, every Synapse-
    # managed host becomes routable from every other host on the
    # tailnet — Remote Hosts should be the only inter-host SSH path.
    local tmpl="$INSTALLER_DIR/templates/headscale.policy.hujson"
    run grep -F '"src":    ["*"]' "$tmpl"
    [ "$status" -ne 0 ]
    run grep -F '"dst":    ["*:*"]' "$tmpl"
    [ "$status" -ne 0 ]
}
