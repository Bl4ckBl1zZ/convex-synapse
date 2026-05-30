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

@test "headscale.policy.hujson tag owners use the user@ format (Headscale 0.28 policy v2)" {
    # Regression for v1.19.0/.1: bare "synapse" as a tagOwner is
    # rejected by Headscale 0.28's policy v2 parser ("Invalid Owner
    # ... an alias must be a user (containing @), group:, or tag:")
    # and the container crash-loops, so the API key is never minted
    # and Remote Hosts stays NOT CONFIGURED. Owners MUST be "synapse@".
    local tmpl="$INSTALLER_DIR/templates/headscale.policy.hujson"
    # The owner value must be the @-suffixed user form.
    run grep -F '"synapse@"' "$tmpl"
    [ "$status" -eq 0 ]
    # And the bare form (quote-delimited, no @) must NOT appear as an
    # owner. Match "synapse" immediately followed by a closing quote.
    run grep -E '\["synapse"\]' "$tmpl"
    [ "$status" -ne 0 ]
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

@test "headscale::render_config self-heals a poisoned v1.19.0/.1 policy file" {
    # An existing policy.hujson carrying the broken bare-user tagOwner
    # MUST be rewritten from the (fixed) template — otherwise an
    # already-poisoned install can never recover, even via a
    # dashboard-driven re-Configure. Operator-customized policies
    # (no broken token) are left untouched by the sibling test below.
    source "$INSTALLER_DIR/install/headscale.sh"
    # Minimal stubs so render_config runs without caddy/docker.
    eval 'caddy::_render() { printf "server_url: x\n"; }'
    eval 'detect::sudo_cmd() { printf ""; }'
    eval 'ui::warn() { :; }'
    eval 'ui::fail() { :; }'
    INSTALL_DIR="$BATS_TEST_TMPDIR/install"
    INSTALLER_TEMPLATES="$INSTALLER_DIR/templates"
    mkdir -p "$INSTALL_DIR/headscale"
    # Seed the broken policy.
    cat > "$INSTALL_DIR/headscale/policy.hujson" <<'POL'
{ "tagOwners": { "tag:synapse-control": ["synapse"] }, "acls": [] }
POL
    run headscale::render_config
    [ "$status" -eq 0 ]
    # The broken token is gone; the @-form is present.
    run grep -F '"synapse@"' "$INSTALL_DIR/headscale/policy.hujson"
    [ "$status" -eq 0 ]
    run grep -E '\["synapse"\]' "$INSTALL_DIR/headscale/policy.hujson"
    [ "$status" -ne 0 ]
}

@test "headscale::render_config leaves an operator-customized policy untouched" {
    source "$INSTALLER_DIR/install/headscale.sh"
    eval 'caddy::_render() { printf "server_url: x\n"; }'
    eval 'detect::sudo_cmd() { printf ""; }'
    eval 'ui::warn() { :; }'
    eval 'ui::fail() { :; }'
    INSTALL_DIR="$BATS_TEST_TMPDIR/install2"
    INSTALLER_TEMPLATES="$INSTALLER_DIR/templates"
    mkdir -p "$INSTALL_DIR/headscale"
    # A custom policy with a proper @-owner and a distinctive marker.
    cat > "$INSTALL_DIR/headscale/policy.hujson" <<'POL'
{ "tagOwners": { "tag:custom": ["alice@"] }, "acls": [], "_marker": "keep-me" }
POL
    run headscale::render_config
    [ "$status" -eq 0 ]
    run grep -F 'keep-me' "$INSTALL_DIR/headscale/policy.hujson"
    [ "$status" -eq 0 ]
}

@test "headscale.policy.hujson allows control → remote deployment port range (central proxy)" {
    # Regression for the SSH-only-ACL split: control → remote on :22
    # alone left the central proxy unable to reach a remote deployment's
    # host_port over the tailnet, so /d/<name>/* timed out ("context
    # canceled"). The 3210-3500 deployment range MUST be allowed.
    local tmpl="$INSTALLER_DIR/templates/headscale.policy.hujson"
    run grep -F 'tag:synapse-remote:3210-3500' "$tmpl"
    [ "$status" -eq 0 ]
}

@test "headscale::render_config adds the deployment-port ACL to an SSH-only policy" {
    # An install predating central-proxy routing carries the SSH-only
    # ACL (control → remote :22) and no 3210-3500 rule. render_config
    # must migrate it (re-copy the template) so remote deployments
    # become reachable — the operator-customized case is left untouched
    # by the sibling test, which has no synapse-remote:22 anchor.
    source "$INSTALLER_DIR/install/headscale.sh"
    eval 'caddy::_render() { printf "server_url: x\n"; }'
    eval 'detect::sudo_cmd() { printf ""; }'
    eval 'ui::warn() { :; }'
    eval 'ui::fail() { :; }'
    INSTALL_DIR="$BATS_TEST_TMPDIR/install-ssh-only"
    INSTALLER_TEMPLATES="$INSTALLER_DIR/templates"
    mkdir -p "$INSTALL_DIR/headscale"
    # Pre-fix SSH-only policy: correct @-owners, no deployment range.
    cat > "$INSTALL_DIR/headscale/policy.hujson" <<'POL'
{ "tagOwners": { "tag:synapse-control": ["synapse@"], "tag:synapse-remote": ["synapse@"] },
  "acls": [ { "action": "accept", "src": ["tag:synapse-control"], "dst": ["tag:synapse-remote:22"] } ] }
POL
    run headscale::render_config
    [ "$status" -eq 0 ]
    run grep -F 'tag:synapse-remote:3210-3500' "$INSTALL_DIR/headscale/policy.hujson"
    [ "$status" -eq 0 ]
}
