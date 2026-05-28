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
#   1. SYNAPSE_HEADSCALE_DOMAIN set  → https://<domain>           (explicit override)
#   2. SYNAPSE_BASE_DOMAIN set       → https://headscale.<base>   (subdomain of deployments base)
#   3. SYNAPSE_PUBLIC_IP + PORT set  → http://<ip>:<port>         (no-TLS install)
#   4. else                          → empty (caller errors out)
#
# SYNAPSE_HEADSCALE_DOMAIN (v1.18.2+) exists so operators whose
# control plane lives at one root (`synapsepanel.com`) but whose
# deployments wildcard at another (`*.app.synapsepanel.com`) can
# place Headscale outside the on-demand wildcard. Without it the
# auto-derived `headscale.<base>` falls under the wildcard's
# `tls { on_demand }` policy, which gates issuance on `tls_ask` —
# and `tls_ask` only approves real deployments, so the Headscale
# subdomain never gets a cert.
headscale::_resolve_server_url() {
    if [[ -n "${SYNAPSE_HEADSCALE_DOMAIN:-}" ]]; then
        printf 'https://%s' "${SYNAPSE_HEADSCALE_DOMAIN#.}"
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
# doesn't exist. `headscale users list -o json | jq` is the canonical
# probe; we shell out to grep so we don't require jq inside the
# container (the headscale image is distroless).
headscale::ensure_user() {
    local user="${1:-$HEADSCALE_DEFAULT_USER}"
    local out
    # `users list` exits 0 even when the user is missing; the absence
    # signal is just empty output for that name. Plain-text output
    # has the user name as the first column.
    out="$(headscale::_compose exec -T headscale headscale users list 2>/dev/null || true)"
    if printf '%s\n' "$out" | awk -v u="$user" 'NR>1 && $2==u { found=1 } END { exit !found }'; then
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
#   9. install Caddy block when applicable (TLS mode only).
headscale::bootstrap() {
    local env_file="$INSTALL_DIR/.env"

    # 1. external URL ------------------------------------------------
    local server_url
    server_url="$(headscale::_resolve_server_url)"
    if [[ -z "$server_url" ]]; then
        ui::fail "Headscale needs SYNAPSE_BASE_DOMAIN or SYNAPSE_PUBLIC_IP+SYNAPSE_HEADSCALE_PORT"
        return 2
    fi
    secrets::set_env_var "$env_file" SYNAPSE_HEADSCALE_SERVER_URL "$server_url"
    export SYNAPSE_HEADSCALE_SERVER_URL="$server_url"

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

    # 9. Caddy block -------------------------------------------------
    # Only relevant in TLS mode with a base domain — without a base
    # domain we have nothing to put in front of the proxy.
    if [[ -n "${SYNAPSE_BASE_DOMAIN:-}" ]] && (( ${NO_TLS:-0} == 0 )); then
        if declare -F caddy::install_headscale_block >/dev/null; then
            caddy::install_headscale_block || ui::warn \
                "caddy::install_headscale_block failed — Headscale is up but not fronted by Caddy"
        fi
    fi

    ui::success "Headscale ready at ${server_url}"
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
