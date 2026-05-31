# installer/install/headscale.sh
# shellcheck shell=bash
#
# Headscale (self-hosted Tailscale control plane) install + bootstrap.
# Composes the postgres + docker-compose + secrets + caddy helpers
# already loaded by setup.sh. Profile-gated: the `headscale` compose
# profile is OFF by default. Operators opt in via
# `setup.sh --enable-headscale`, which sets ENABLE_HEADSCALE=1 and
# calls headscale::bootstrap from phase_install_headscale.
#
# Why self-hosted (vs. Tailscale's managed control plane): zero
# third-party dependency on the identity path. WireGuard tunnels stay
# P2P between machines (DERP is fallback only); only the "who's who"
# coordination layer lives on the operator's Synapse host.
#
# Storage: dedicated 'headscale' database on the same Postgres
# cluster as Synapse metadata (auto-migrated on first start).
#
# Tests inject HEADSCALE_DOCKER_CMD / HEADSCALE_OPENSSL the same way
# secrets.sh / compose.sh do, so the docker exec + key generation
# paths are mockable without a live container.

# ---- constants ------------------------------------------------------

# Bumped in lock-step with the image tag in docker-compose.yml.
readonly HEADSCALE_VERSION="${HEADSCALE_VERSION:-v0.28.0}"

# Default user/namespace pre-auth keys minted by Synapse will live
# under. The Remote Hosts feature creates pre-auth keys per remote
# VPS; all of them belong to this single user.
readonly HEADSCALE_DEFAULT_USER="${HEADSCALE_DEFAULT_USER:-synapse}"

# ---- predicates -----------------------------------------------------

# headscale::is_enabled returns 0 when ENABLE_HEADSCALE=1 was set on
# the current setup.sh invocation OR SYNAPSE_HEADSCALE_URL is already
# stamped in .env (upgrade path: the operator opted in on a prior
# install, the flag isn't on the command line, but the profile must
# keep coming back up). Single source of truth for the phase guard.
headscale::is_enabled() {
    if (( ${ENABLE_HEADSCALE:-0} )); then
        return 0
    fi
    if [[ -n "${SYNAPSE_HEADSCALE_URL:-}" ]]; then
        return 0
    fi
    return 1
}

# ---- internal helpers ----------------------------------------------

# headscale::_compose <args...>  → wraps docker compose with the
# --profile headscale flag pinned to the install dir's compose file.
# Centralised so we don't sprinkle `docker compose -f .../docker-
# compose.yml --profile headscale` everywhere.
headscale::_compose() {
    local cmd="${HEADSCALE_DOCKER_CMD:-${COMPOSE_CMD:-docker}}"
    "$cmd" compose -f "$INSTALL_DIR/docker-compose.yml" --profile headscale "$@"
}

# headscale::_psql <sql>  → runs <sql> against the postgres container
# as the synapse superuser (POSTGRES_USER from .env). Connects to the
# 'postgres' database so we can CREATE DATABASE / CREATE USER on the
# cluster. Output goes to stdout; non-zero on psql failure.
headscale::_psql() {
    local sql="$1"
    local cmd="${HEADSCALE_DOCKER_CMD:-${COMPOSE_CMD:-docker}}"
    local pg_user="${POSTGRES_USER:-synapse}"
    "$cmd" compose -f "$INSTALL_DIR/docker-compose.yml" exec -T postgres \
        psql -U "$pg_user" -d postgres -tA -c "$sql"
}

# headscale::_resolve_server_url  echoes the external URL Tailscale
# clients will use to reach this control plane. Caller checks for
# empty output (returns 0 unconditionally for set -e ergonomics).
#
# Resolution order (first match wins):
#   1. SYNAPSE_HEADSCALE_DOMAIN set  → https://<domain>             (explicit override)
#   2. SYNAPSE_DOMAIN set            → https://headscale.<host>     (dashboard host's sibling — v1.19+ default)
#   3. SYNAPSE_BASE_DOMAIN set       → https://headscale.<base>     (subdomain of deployments base)
#   4. SYNAPSE_PUBLIC_IP + PORT set  → http://<ip>:<port>           (no-TLS install)
#   5. else                          → empty (caller errors out)
#
# v1.19+ rationale for preferring SYNAPSE_DOMAIN over SYNAPSE_BASE_DOMAIN:
# operators commonly run the dashboard at synapsepanel.com and the
# deployments wildcard at app.synapsepanel.com. Defaulting to
# headscale.app.synapsepanel.com would fall under the on-demand TLS
# wildcard, which gates issuance on tls_ask — and tls_ask only
# approves real deployments, so the Headscale subdomain never gets a
# cert. headscale.<SYNAPSE_DOMAIN> lives outside the wildcard.
headscale::_resolve_server_url() {
    if [[ -n "${SYNAPSE_HEADSCALE_DOMAIN:-}" ]]; then
        printf 'https://%s' "${SYNAPSE_HEADSCALE_DOMAIN#.}"
        return 0
    fi
    # v1.19.1: protect v1.18→v1.19 upgrades from silently moving the
    # Headscale subdomain. Operators on v1.18 who used the auto-derive
    # had `headscale.<SYNAPSE_BASE_DOMAIN>` stamped only in
    # SYNAPSE_HEADSCALE_SERVER_URL (no SYNAPSE_HEADSCALE_DOMAIN
    # because there was no override). v1.19 changed the preference
    # order — without this backfill, the first `--configure-headscale`
    # run after upgrade would derive a DIFFERENT subdomain from
    # SYNAPSE_DOMAIN, clobber SERVER_URL, and break every existing
    # tailnet client. Honoring the persisted SERVER_URL keeps it
    # idempotent.
    if [[ -n "${SYNAPSE_HEADSCALE_SERVER_URL:-}" ]]; then
        printf '%s' "$SYNAPSE_HEADSCALE_SERVER_URL"
        return 0
    fi
    if [[ -n "${SYNAPSE_DOMAIN:-}" ]]; then
        printf 'https://headscale.%s' "${SYNAPSE_DOMAIN#.}"
        return 0
    fi
    if [[ -n "${SYNAPSE_BASE_DOMAIN:-}" ]]; then
        printf 'https://headscale.%s' "${SYNAPSE_BASE_DOMAIN#.}"
        return 0
    fi
    if [[ -n "${SYNAPSE_PUBLIC_IP:-}" && -n "${SYNAPSE_HEADSCALE_PORT:-}" ]]; then
        printf 'http://%s:%s' "$SYNAPSE_PUBLIC_IP" "$SYNAPSE_HEADSCALE_PORT"
        return 0
    fi
    return 0
}

# ---- database -------------------------------------------------------

# headscale::ensure_database  creates the dedicated 'headscale'
# database + user on the existing Postgres cluster if missing.
# Idempotent: every CREATE is wrapped in an existence check.
#
# Persists SYNAPSE_HEADSCALE_DB_NAME / DB_USER / DB_PASSWORD into
# .env so subsequent renders + container restarts pick the same
# credentials. Password is generated via secrets::gen_db_password
# only when missing — operators who pre-seeded their own value are
# preserved.
headscale::ensure_database() {
    local env_file="$INSTALL_DIR/.env"
    local db_name db_user db_pass
    db_name="$(secrets::env_get "$env_file" SYNAPSE_HEADSCALE_DB_NAME)"
    [[ -z "$db_name" ]] && db_name="headscale"
    db_user="$(secrets::env_get "$env_file" SYNAPSE_HEADSCALE_DB_USER)"
    [[ -z "$db_user" ]] && db_user="headscale"
    db_pass="$(secrets::env_get "$env_file" SYNAPSE_HEADSCALE_DB_PASSWORD)"
    if [[ -z "$db_pass" ]]; then
        db_pass="$(secrets::gen_db_password)"
    fi

    secrets::ensure_env_var "$env_file" SYNAPSE_HEADSCALE_DB_NAME     "$db_name"
    secrets::ensure_env_var "$env_file" SYNAPSE_HEADSCALE_DB_USER     "$db_user"
    secrets::ensure_env_var "$env_file" SYNAPSE_HEADSCALE_DB_PASSWORD "$db_pass"
    export SYNAPSE_HEADSCALE_DB_NAME="$db_name"
    export SYNAPSE_HEADSCALE_DB_USER="$db_user"
    export SYNAPSE_HEADSCALE_DB_PASSWORD="$db_pass"

    # Role first (database has owner = role; creating the DB without
    # the role then ALTERing later works too but the one-shot path
    # is cleaner). The IF NOT EXISTS guard is the only reliably
    # idempotent way to do CREATE ROLE — there is no built-in
    # `CREATE ROLE ... IF NOT EXISTS` in stock Postgres, so we
    # branch on a SELECT result.
    local has_role
    has_role="$(headscale::_psql "SELECT 1 FROM pg_roles WHERE rolname = '${db_user}'")"
    if [[ "$has_role" != "1" ]]; then
        # CREATE ROLE with LOGIN + a password literal. Single quotes
        # in the password would break the SQL literal; we generate
        # hex-only passwords (secrets::gen_db_password) so the risk
        # is theoretical, but we still refuse on `'` for safety.
        if [[ "$db_pass" == *"'"* ]]; then
            ui::fail "headscale::ensure_database: refusing password containing single-quote"
            return 2
        fi
        headscale::_psql "CREATE ROLE \"${db_user}\" WITH LOGIN PASSWORD '${db_pass}'" >/dev/null
    fi

    local has_db
    has_db="$(headscale::_psql "SELECT 1 FROM pg_database WHERE datname = '${db_name}'")"
    if [[ "$has_db" != "1" ]]; then
        # CREATE DATABASE can't run inside a transaction; the -tA -c
        # path in _psql sends it as a single autocommit statement
        # which is what Postgres wants here.
        headscale::_psql "CREATE DATABASE \"${db_name}\" OWNER \"${db_user}\"" >/dev/null
    fi
}

# ---- config rendering ----------------------------------------------

# headscale::render_config  writes config.yaml + policy.hujson into
# $INSTALL_DIR/headscale/. The config is rendered fresh on every call
# (no operator-editable surface yet); the policy is copied verbatim
# unless it already exists (operators MAY have tweaked it).
#
# Requires SYNAPSE_HEADSCALE_SERVER_URL + DB_* exported. Caller must
# have run ensure_database first.
headscale::render_config() {
    local hs_dir="$INSTALL_DIR/headscale"
    local prefix=""
    prefix="$(detect::sudo_cmd 2>/dev/null || true)"
    $prefix mkdir -p "$hs_dir"

    local tmpl="$INSTALLER_TEMPLATES/headscale.config.yaml.tmpl"
    local out="$hs_dir/config.yaml"
    if [[ ! -r "$tmpl" ]]; then
        ui::fail "headscale::render_config: template missing at $tmpl"
        return 2
    fi
    # Re-render every call. Headscale picks up changes only on
    # container restart, which bootstrap does via `up -d`.
    local rendered
    rendered="$(caddy::_render "$tmpl")" || return 2
    local tmp
    tmp="$(mktemp "${out}.XXXXXX")" || return 2
    printf '%s' "$rendered" >"$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$out"

    local policy_src="$INSTALLER_TEMPLATES/headscale.policy.hujson"
    local policy_out="$hs_dir/policy.hujson"
    if [[ ! -e "$policy_out" && -r "$policy_src" ]]; then
        cp "$policy_src" "$policy_out"
        chmod 0644 "$policy_out"
    elif [[ -e "$policy_out" && -r "$policy_src" ]]; then
        # v1.19.2 self-heal: v1.19.0/.1 shipped a policy whose tag
        # owners were the bare user form `["synapse"]`, which
        # Headscale 0.28's policy v2 parser rejects ("Invalid Owner")
        # — the container crash-loops and Remote Hosts never goes
        # live. render_config normally NEVER overwrites an
        # operator-editable policy, but this exact broken pattern
        # can only have come from our shipped default, so rewriting
        # it is safe (and the only way a dashboard-driven re-Configure
        # can fix an already-poisoned install). We match the precise
        # broken token so any operator customization is left alone.
        if grep -qE '\["synapse"\]' "$policy_out"; then
            ui::warn "Headscale: migrating broken v1.19.0/.1 tag-owner policy (\"synapse\" → \"synapse@\")"
            cp "$policy_src" "$policy_out"
            chmod 0644 "$policy_out"
        fi
        # v1.19.12 self-heal: installs predating central-proxy routing
        # shipped an SSH-only ACL (control → remote :22) with no
        # deployment host-port rule, so /d/<name>/* to a remote host
        # timed out ("context canceled") and remote deployments were
        # unreachable. If the policy still lacks the 3210-3500 range but
        # carries our SSH ACL (proving it's the Synapse-managed default,
        # not an operator rewrite), re-copy the template to add it.
        # Idempotent once the range is present.
        if ! grep -q 'synapse-remote:3210' "$policy_out" && grep -q 'synapse-remote:22' "$policy_out"; then
            ui::warn "Headscale: adding deployment-port ACL (control → remote 3210-3500) for central-proxy routing"
            cp "$policy_src" "$policy_out"
            chmod 0644 "$policy_out"
        fi
    fi
}

# ---- container lifecycle -------------------------------------------

# headscale::_start  brings the headscale service up under its
# profile. depends_on postgres:service_healthy in the compose file
# means this returns once postgres is ready AND headscale is created
# (not necessarily healthy — that's _wait_healthy's job).
headscale::_start() {
    ui::spin "Starting Headscale container" \
        headscale::_compose up -d headscale
}

# headscale::_wait_healthy  polls `headscale health` inside the
# container until it returns 0 or the budget expires. 60s default;
# tests can shrink via HEADSCALE_HEALTH_BUDGET.
headscale::_wait_healthy() {
    local budget="${HEADSCALE_HEALTH_BUDGET:-60}"
    local deadline=$(( SECONDS + budget ))
    while (( SECONDS < deadline )); do
        if headscale::_compose exec -T headscale headscale health >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    ui::fail "Headscale did not become healthy in ${budget}s"
    return 2
}

# ---- user + API key -------------------------------------------------

# headscale::ensure_user  creates the default user/namespace if it
# doesn't exist. Existence is checked via headscale::_user_id (which
# parses `headscale users list -o json` with jq on the HOST — the
# headscale container is distroless and has no jq, but the JSON comes
# out to the host where jq lives). The old awk table-parse missed an
# existing user on a real box (the version-update WRN line + column
# drift), so ensure_user tried to re-create 'synapse' and hit a
# duplicate-key error. The JSON check is format-stable.
headscale::ensure_user() {
    local user="${1:-$HEADSCALE_DEFAULT_USER}"
    if [[ -n "$(headscale::_user_id "$user")" ]]; then
        return 0
    fi
    headscale::_compose exec -T headscale headscale users create "$user" >/dev/null
}

# headscale::ensure_api_key  mints a long-lived admin API key and
# persists it to .env via secrets::ensure_env_var. IDEMPOTENT — if
# SYNAPSE_HEADSCALE_API_KEY is already set in .env, returns 0 without
# minting a new one (every mint costs an API-key row in the headscale
# DB and orphans the previous one until manual revocation).
#
# Key capture: `headscale apikeys create` writes a short prelude
# followed by the plaintext key on the last non-empty line. We pluck
# the last token via awk; this is the same parsing the upstream
# `tailscale up --auth-key=$(...)` snippets use in the headscale
# docs. The key is NEVER echoed to stdout — only the trimmed-mask
# length is reported by the caller's ui::success.
headscale::ensure_api_key() {
    local env_file="$INSTALL_DIR/.env"
    local existing
    existing="$(secrets::env_get "$env_file" SYNAPSE_HEADSCALE_API_KEY)"
    if [[ -n "$existing" ]]; then
        export SYNAPSE_HEADSCALE_API_KEY="$existing"
        return 0
    fi
    local raw key
    # 100y = effectively non-expiring. The Remote Hosts flow uses one
    # admin key per Synapse install; rotation is a Phase-3 dashboard
    # action, not an install-time concern.
    raw="$(headscale::_compose exec -T headscale \
        headscale apikeys create --expiration 876000h 2>&1)" || {
        ui::fail "headscale apikeys create failed: ${raw}"
        return 2
    }
    # The plaintext key is the last non-empty line of stdout. awk
    # collapses blank lines and we keep only the final token (the
    # CLI may prefix it with "key: " on some versions).
    key="$(printf '%s\n' "$raw" | awk 'NF { last = $NF } END { print last }')"
    if [[ -z "$key" ]]; then
        ui::fail "headscale apikeys create returned no key"
        return 2
    fi
    secrets::ensure_env_var "$env_file" SYNAPSE_HEADSCALE_API_KEY "$key"
    export SYNAPSE_HEADSCALE_API_KEY="$key"
}

# ---- top-level entry point -----------------------------------------

# headscale::bootstrap  end-to-end "make sure Headscale is up,
# healthy, and reachable" entry point. Called from
# phase_install_headscale after phase_compose_up has brought up
# postgres + synapse + caddy.
#
# Order matters:
#   1. Resolve external server URL (errors out when neither
#      base-domain nor public-ip is available).
#   2. Stamp internal SYNAPSE_HEADSCALE_URL (the URL synapse-api uses
#      to call headscale's HTTP API — always the docker-network
#      service name, never the external URL).
#   3. ensure_database (must exist before headscale container starts).
#   4. render_config + policy.hujson.
#   5. compose up -d headscale (under the headscale profile).
#   6. wait_healthy.
#   7. ensure_user (the default 'synapse' namespace).
#   8. ensure_api_key (persists to .env, idempotent).
#   9. install Caddy block when applicable (TLS mode only) — MUST
#      precede the join so the control plane's own `tailscale up`
#      reaches a Caddy already fronting headscale.<domain>.
#  10. join_control_plane: register the control plane in its own
#      tailnet (best-effort; skip via SYNAPSE_SKIP_CONTROL_TAILSCALE).
headscale::bootstrap() {
    local env_file="$INSTALL_DIR/.env"

    # 1. external URL ------------------------------------------------
    local server_url
    server_url="$(headscale::_resolve_server_url)"
    if [[ -z "$server_url" ]]; then
        ui::fail "Headscale needs SYNAPSE_HEADSCALE_DOMAIN, SYNAPSE_DOMAIN, SYNAPSE_BASE_DOMAIN, or SYNAPSE_PUBLIC_IP+SYNAPSE_HEADSCALE_PORT"
        return 2
    fi
    secrets::set_env_var "$env_file" SYNAPSE_HEADSCALE_SERVER_URL "$server_url"
    export SYNAPSE_HEADSCALE_SERVER_URL="$server_url"

    # v1.19+: stamp SYNAPSE_HEADSCALE_DOMAIN into .env so the chosen
    # subdomain survives upgrades + dashboard-driven reconfigure jobs.
    # Skip when the operator left the explicit override empty AND the
    # derivation used SYNAPSE_PUBLIC_IP (no domain to persist there).
    if [[ "$server_url" == https://* ]]; then
        local _hs_domain="${server_url#https://}"
        secrets::ensure_env_var "$env_file" SYNAPSE_HEADSCALE_DOMAIN "$_hs_domain"
        export SYNAPSE_HEADSCALE_DOMAIN="$_hs_domain"
    fi

    # 2. internal URL -------------------------------------------------
    # synapse-api talks to headscale over the docker bridge by
    # service name. NEVER the external URL (Caddy round-tripping
    # would be wasteful and would break inside a no-tls install).
    secrets::ensure_env_var "$env_file" SYNAPSE_HEADSCALE_URL \
        "http://synapse-headscale:8080"
    local internal_url
    internal_url="$(secrets::env_get "$env_file" SYNAPSE_HEADSCALE_URL)"
    export SYNAPSE_HEADSCALE_URL="$internal_url"

    # 3-4. database + config -----------------------------------------
    ui::info "Provisioning headscale database"
    headscale::ensure_database
    ui::info "Rendering headscale config"
    headscale::render_config

    # 5-6. start + wait ----------------------------------------------
    headscale::_start
    headscale::_wait_healthy

    # 7-8. user + admin key ------------------------------------------
    ui::info "Ensuring '${HEADSCALE_DEFAULT_USER}' user"
    headscale::ensure_user "$HEADSCALE_DEFAULT_USER"
    ui::info "Minting admin API key (idempotent)"
    headscale::ensure_api_key

    # 9. Caddy block — MUST precede ANY `tailscale up` -------------
    # Both the control-plane self-join (step 10) AND every remote-host
    # join need Caddy to already front headscale.<domain> with a valid
    # cert. Pre-1.19.9 this ran AFTER join_control_plane, so the
    # control plane's own `tailscale up` raced a Caddy that wasn't yet
    # routing headscale.<domain> — most visibly on the upgrade path,
    # which regenerates the Caddyfile WITHOUT the managed block — and
    # hung on the control-key fetch (the on-demand `:443` catch-all
    # answers /key with 404). v1.19.6: install whenever we're in TLS
    # mode (server_url is https), NOT only when a base domain is set,
    # so a domain-only install still gets its own Caddy site.
    # caddy::install_headscale_block self-guards on a missing hostname.
    if (( ${NO_TLS:-0} == 0 )) && [[ "$server_url" == https://* ]]; then
        if declare -F caddy::install_headscale_block >/dev/null; then
            caddy::install_headscale_block || ui::warn \
                "caddy::install_headscale_block failed — Headscale is up but not fronted by Caddy"
        fi
    fi

    # 9.5. Recreate synapse-api so it re-reads the SYNAPSE_HEADSCALE_*
    # env stamped above. The running container started in
    # phase_compose_up, BEFORE those vars were in .env — so its
    # config.HeadscaleHost is empty and /v1/internal/tls_ask 404s the
    # headscale host, which makes Caddy refuse the on-demand cert and
    # the join's `tailscale up` hang forever on the TLS handshake.
    # (configure_headscale also recreates synapse, but AFTER bootstrap —
    # too late for the join below.) TLS mode only (the join needs a cert).
    if (( ${NO_TLS:-0} == 0 )) && [[ "$server_url" == https://* ]]; then
        headscale::_recreate_synapse_api
    fi

    # 10. control-plane tailnet membership --------------------------
    # Join the Synapse control plane to its own tailnet so the central
    # proxy + provisioner can reach remote-host 100.x addresses.
    # Best-effort — operators on a hardened distro that refuses /tmp
    # execution can skip via SYNAPSE_SKIP_CONTROL_TAILSCALE=1 and run
    # `tailscale up --login-server=$SERVER_URL --auth-key=...` by hand.
    if (( ${SYNAPSE_SKIP_CONTROL_TAILSCALE:-0} == 0 )); then
        if ! headscale::join_control_plane; then
            ui::warn "Headscale: control plane tailnet join failed — Remote Hosts central → remote SSH will not work"
            ui::info "  fix: SSH in and run 'tailscale up --login-server=${server_url} --auth-key=<key>' by hand"
        fi
    fi

    ui::success "Headscale ready at ${server_url}"
}

# headscale::_recreate_synapse_api — force-recreate the synapse-api
# container so it re-reads the SYNAPSE_HEADSCALE_* env just stamped into
# .env (needed so /v1/internal/tls_ask knows the headscale host and
# Caddy will issue its on-demand cert). Best-effort; degrades with a
# clear warning. A few seconds' settle so the join's first cert
# handshake doesn't race a still-starting api.
headscale::_recreate_synapse_api() {
    local cmd="${HEADSCALE_DOCKER_CMD:-${COMPOSE_CMD:-docker}}"
    ui::info "Recreating synapse-api to pick up Headscale env (tls_ask needs the headscale host)"
    if "$cmd" compose -f "$INSTALL_DIR/docker-compose.yml" up -d --no-build --force-recreate synapse >/dev/null 2>&1; then
        sleep 3
    else
        ui::warn "could not recreate synapse-api — tls_ask may not know the headscale host yet"
    fi
}

# ---- reconcile (placeholder seam, not wired in Phase 1) -------------

# headscale::reconcile  re-renders config when SYNAPSE_BASE_DOMAIN
# or SYNAPSE_PUBLIC_IP changed and restarts the service. Hooked into
# lifecycle::reconfigure in a later phase; documented here so the
# seam is visible.
headscale::reconcile() {
    if ! headscale::is_enabled; then
        return 0
    fi
    local prev_url
    prev_url="$(secrets::env_get "$INSTALL_DIR/.env" SYNAPSE_HEADSCALE_SERVER_URL)"
    local new_url
    new_url="$(headscale::_resolve_server_url)"
    if [[ "$prev_url" == "$new_url" ]]; then
        return 0
    fi
    headscale::bootstrap
    headscale::_compose restart headscale
}

# ---- control-plane tailnet membership (v1.19+) ----------------------
#
# The Synapse control plane VPS must join its own Headscale tailnet
# as a regular Tailscale client so the central proxy + provisioner
# can reach remote hosts at their 100.x.x.x addresses. Without this
# step:
#   - `ssh synapse-deployer@<tailnet-ip>` from synapse-api 502s
#     because the tailnet IP isn't routable from the control plane;
#   - the v1.19 dynamic-upstream proxy returns 502 for every remote
#     deployment.
#
# This is idempotent: when the host is already authenticated to the
# same login-server, we keep its session and return. A different
# server URL flips us into a refusal — the operator must explicitly
# acknowledge migration via `tailscale logout` first. Refusal is the
# safer default; we don't want to silently disconnect the control
# plane from a working tailnet because someone edited
# SYNAPSE_HEADSCALE_DOMAIN.

readonly _CONTROL_TAG="tag:synapse-control"

# headscale::_control_hostname  echoes the stable hostname the control
# plane registers under inside Headscale. Default: synapse-control.
# Operators can override by exporting SYNAPSE_CONTROL_HOSTNAME before
# setup.sh — useful when running multiple Synapse instances against
# the same Headscale (rare).
headscale::_control_hostname() {
    printf '%s' "${SYNAPSE_CONTROL_HOSTNAME:-synapse-control}"
}

# headscale::_install_tailscale  install the tailscale CLI if missing.
# Mirrors installer-agent/install/tailscale.sh but lives inline here
# so the control-plane installer doesn't drag in the agent's library
# layout.
headscale::_install_tailscale() {
    if ! command -v tailscale >/dev/null 2>&1; then
        ui::info "Installing Tailscale CLI (https://tailscale.com/install.sh)"
        if ! curl -fsSL https://tailscale.com/install.sh | sh >&2; then
            ui::fail "Tailscale install script failed"
            return 2
        fi
        if ! command -v tailscale >/dev/null 2>&1; then
            ui::fail "Tailscale install completed but binary not on PATH"
            return 2
        fi
    fi
    # `tailscale up` (join_control_plane) talks to a RUNNING tailscaled.
    # install.sh starts+enables it on a fresh box, but a host where the
    # binary was already present with the daemon STOPPED — reboot without
    # enable, a partial prior install, or a reconfigure after a wipe —
    # makes the join fail "failed to connect to local tailscaled". Ensure
    # the daemon is up + enabled (idempotent) and answering its localapi
    # before returning. Best-effort: non-systemd inits / odd unit names
    # fall through and the join surfaces the original error.
    if command -v systemctl >/dev/null 2>&1; then
        systemctl enable --now tailscaled >/dev/null 2>&1 || true
        local _i
        for _i in $(seq 1 10); do
            tailscale status 2>&1 | grep -q "failed to connect to local tailscaled" || break
            sleep 1
        done
    fi
    return 0
}

# headscale::_current_login_server  echoes the login-server the local
# tailscaled is currently bound to (trailing slash trimmed), or empty
# when it can't be determined (logged out, mid-connect, or a tailscale
# build whose status JSON omits the field). Single source of truth for
# _control_already_joined AND join_control_plane's refuse-clobber guard
# — both used to inline this parse and drift apart.
headscale::_current_login_server() {
    local status_json
    status_json="$(tailscale status --json 2>/dev/null)" || return 0
    local cs
    if command -v jq >/dev/null 2>&1; then
        cs="$(printf '%s' "$status_json" | jq -r '.CurrentTailnet.LoginServer // .ControlURL // ""' 2>/dev/null)"
    else
        cs="$(printf '%s' "$status_json" | grep -oE '"(LoginServer|ControlURL)":[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
    fi
    printf '%s' "${cs%/}"
}

# headscale::_control_already_joined SERVER_URL
# Returns 0 when the local tailscaled is already authenticated against
# the given login-server. Trailing slashes are normalized on both
# sides (some tailscale builds report the server with a trailing "/").
# When the login-server can't be read at all (very old tailscale or a
# CI stub), falls back to "any 100.x IP is at least a membership".
headscale::_control_already_joined() {
    local server_url="$1"
    local cur
    cur="$(headscale::_current_login_server)"
    if [[ -n "$cur" ]]; then
        [[ "$cur" == "${server_url%/}" ]]
        return
    fi
    local addr
    addr="$(tailscale ip -4 2>/dev/null | head -1 || true)"
    [[ -n "$addr" && "$addr" == 100.* ]]
}

# headscale::_user_id <user>
# Resolves a Headscale username to its numeric user ID. Headscale
# 0.28's CLI + API take the numeric ID (not the name) for
# preauthkey/node ops.
#
# Parses `headscale users list -o json` with jq on the HOST. The
# headscale container is distroless (no jq), but `-o json` writes a
# clean array to stdout that we pipe out and parse host-side, where
# jq is a hard dependency (preflight installs it). This replaced an
# awk table-parse that broke on a real box: the version-update WRN
# line + column layout drift made it miss the existing 'synapse'
# user, so the control-plane tailnet join failed with "could not
# resolve user id". JSON is format-stable.
#
# Output shape (headscale 0.28): a JSON ARRAY of
# {"id":<number>,"name":"<user>",...}. We tolerate a {"users":[...]}
# shape too, and strip any non-JSON preamble (some builds print the
# version WRN to stdout ahead of the array). Empty stdout when the
# user isn't found.
headscale::_user_id() {
    local user="${1:-$HEADSCALE_DEFAULT_USER}"
    local json
    json="$(headscale::_compose exec -T headscale headscale users list -o json 2>/dev/null || true)"
    # Drop anything before the first '[' or '{' so a stray WRN line on
    # stdout doesn't make jq choke.
    json="${json#"${json%%[\[{]*}"}"
    [[ -n "$json" ]] || return 0
    printf '%s' "$json" | jq -r --arg u "$user" '
        (if type == "array" then . else .users end)[]
        | select(.name == $u) | .id' 2>/dev/null | head -1
}

# headscale::_mint_control_preauth_key
# Mints a single-use, NOT-ephemeral pre-auth key tagged tag:synapse-control
# inside the headscale container. Echoes the plaintext key on stdout.
# Output is captured by the caller; redaction is the caller's job.
headscale::_mint_control_preauth_key() {
    # 1h expiry — long enough for `tailscale up` to claim it, short
    # enough that a forgotten key can't be replayed.
    #
    # Headscale 0.28's `preauthkeys create --user` takes a NUMERIC
    # user ID, not the username (`--user uint`). Resolve the name → ID
    # first; passing "synapse" 400s with "invalid syntax". v1.19.3 fix.
    local user_id
    user_id="$(headscale::_user_id "$HEADSCALE_DEFAULT_USER")"
    if [[ -z "$user_id" ]]; then
        ui::fail "headscale: could not resolve user id for '${HEADSCALE_DEFAULT_USER}'"
        return 2
    fi
    local raw
    if ! raw="$(headscale::_compose exec -T headscale \
            headscale preauthkeys create \
            --user "$user_id" \
            --tags "$_CONTROL_TAG" \
            --expiration 1h 2>&1)"; then
        ui::fail "headscale preauthkeys create (control) failed: ${raw}"
        return 2
    fi
    # The plaintext key is the last non-empty line. Same pattern as
    # ensure_api_key above (some Headscale CLI versions prefix with
    # "key: ").
    local key
    key="$(printf '%s\n' "$raw" | awk 'NF { last = $NF } END { print last }')"
    if [[ -z "$key" ]]; then
        ui::fail "headscale preauthkeys create (control) returned no key"
        return 2
    fi
    printf '%s' "$key"
}

# headscale::_ensure_local_hosts_entry SERVER_URL
# Idempotently pins the Headscale hostname to 127.0.0.1 in /etc/hosts
# so the control plane's tailscaled reaches the co-located Caddy
# directly instead of hairpinning out to its OWN public IP — which
# many NAT'd VPS (public IP behind a provider NAT, no hairpinning)
# refuse with "connection refused", so `tailscale up` hangs on the
# control-key fetch and the node never stays connected. The on-demand
# cert still validates by SNI over the loopback dial. Only the host's
# tailscaled is affected — synapse-api talks to Headscale over the
# docker network (SYNAPSE_HEADSCALE_URL), never this hostname. NO-OP
# for non-https URLs; best-effort when /etc/hosts isn't writable.
headscale::_ensure_local_hosts_entry() {
    local server_url="$1"
    [[ "$server_url" == https://* ]] || return 0
    local host="${server_url#https://}"
    host="${host%%/*}"
    [[ -n "$host" ]] || return 0
    local hosts_file="${SYNAPSE_HOSTS_FILE:-/etc/hosts}"
    if grep -qE "^[[:space:]]*127\.0\.0\.1[[:space:]]+${host//./\\.}([[:space:]]|\$)" "$hosts_file" 2>/dev/null; then
        return 0
    fi
    if [[ ! -w "$hosts_file" ]]; then
        ui::warn "headscale: cannot pin ${host} → 127.0.0.1 (${hosts_file} not writable); relying on NAT hairpinning"
        return 0
    fi
    printf '127.0.0.1 %s # synapse-headscale (control-plane hairpin)\n' "$host" >>"$hosts_file"
    ui::info "Pinned ${host} → 127.0.0.1 in ${hosts_file} (control-plane tailnet via local Caddy)"
}

# headscale::_wait_public_reachable SERVER_URL
# Polls the Headscale public URL's /health until Caddy answers 2xx.
# caddy::install_headscale_block just RESTARTED Caddy and on-demand
# cert issuance is lazy, so without this the join's first `tailscale
# up` handshake can race a cold Caddy / un-issued cert. Short budget,
# best-effort. NO-OP without curl or for non-https URLs.
headscale::_wait_public_reachable() {
    local server_url="$1"
    [[ "$server_url" == https://* ]] || return 0
    command -v curl >/dev/null 2>&1 || return 0
    local url="${server_url%/}/health"
    local budget="${HEADSCALE_REACHABLE_BUDGET:-30}"
    local deadline=$(( SECONDS + budget ))
    while (( SECONDS < deadline )); do
        if curl -fsS --max-time 5 -o /dev/null "$url" 2>/dev/null; then
            return 0
        fi
        sleep 2
    done
    ui::warn "Headscale public URL ${url} not reachable in ${budget}s — attempting join anyway"
    return 0
}

# headscale::join_control_plane
# End-to-end "make sure the Synapse control plane VPS is a member of
# its own tailnet" entry point. Idempotent: returns 0 quickly when
# already joined to the configured SERVER_URL. Returns non-zero when
# the host is joined to a DIFFERENT login-server — operator must
# acknowledge migration explicitly.
headscale::join_control_plane() {
    local server_url="${SYNAPSE_HEADSCALE_SERVER_URL:-}"
    if [[ -z "$server_url" ]]; then
        ui::warn "join_control_plane: SYNAPSE_HEADSCALE_SERVER_URL unset"
        return 1
    fi

    headscale::_install_tailscale || return 2

    if headscale::_control_already_joined "$server_url"; then
        ui::info "Control plane already joined to ${server_url}"
        return 0
    fi

    # Refuse to clobber ONLY when tailscaled is positively bound to a
    # DIFFERENT login-server — migrating away is the operator's call
    # (`tailscale logout` first). A 100.x IP whose login-server we
    # can't read (node mid-connect, or offline after a partial join)
    # is almost always OUR own tailnet: `tailscale up` against the same
    # server_url is idempotent, so we proceed instead of refusing.
    # Pre-1.19.9 this refused on ANY 100.x IP and mislabeled a
    # half-joined control plane as "a different control plane".
    local current_server
    current_server="$(headscale::_current_login_server)"
    if [[ -n "$current_server" && "$current_server" != "${server_url%/}" ]]; then
        ui::warn "Tailscale is joined to a DIFFERENT control plane (${current_server})"
        ui::info "  refusing to clobber. To migrate: sudo tailscale logout, then re-run setup.sh --configure-headscale"
        return 2
    fi

    # NAT hairpin workaround + readiness: pin the Headscale host to the
    # local Caddy and wait for it to answer before the handshake.
    headscale::_ensure_local_hosts_entry "$server_url"
    headscale::_wait_public_reachable "$server_url"

    local key
    if ! key="$(headscale::_mint_control_preauth_key)"; then
        return 2
    fi

    local hostname
    hostname="$(headscale::_control_hostname)"
    ui::info "Joining control plane to ${server_url} as ${hostname} (tag ${_CONTROL_TAG})"
    # --accept-dns=false: Synapse central runs its own DNS resolution
    # for deployments; the tailnet's MagicDNS would otherwise rewrite
    # base-domain queries via the headscale magic suffix.
    if ! tailscale up \
            --login-server="$server_url" \
            --auth-key="$key" \
            --hostname="$hostname" \
            --accept-dns=false \
            --accept-routes=false; then
        ui::fail "tailscale up failed against ${server_url}"
        return 2
    fi
    # Wait briefly for the IP assignment so a follow-up `tailscale ip`
    # in the same setup.sh run reads back the freshly-minted address.
    local i addr
    for (( i = 0; i < 15; i++ )); do
        addr="$(tailscale ip -4 2>/dev/null | head -1 || true)"
        if [[ -n "$addr" && "$addr" == 100.* ]]; then
            ui::success "Control plane tailnet IP: ${addr}"
            return 0
        fi
        sleep 1
    done
    ui::warn "Control plane tailscale up succeeded but no 100.x IP within 15s — check 'tailscale status'"
    return 0
}
