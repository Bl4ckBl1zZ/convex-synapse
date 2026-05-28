# installer/install/caddy.sh
# shellcheck shell=bash
#
# Caddy reverse-proxy detection + configuration. Three modes:
#
#   caddy_host           — Caddy is already running on the host as a
#                          systemd service. We append a managed block
#                          to /etc/caddy/Caddyfile (BEGIN/END markers
#                          for idempotency) and reload.
#   nginx_external       — Operator runs nginx. We can't auto-edit
#                          their config; we print a config snippet
#                          they can paste manually and exit with a
#                          documented "manual step required" status.
#   caddy_compose        — Fresh host with no reverse proxy. We
#                          enable the optional `caddy` profile in
#                          docker-compose.yml and use the standalone
#                          Caddyfile template.
#
# Composes detect:: helpers from chunk 1 and uses ui::* for
# operator-facing output.
#
# Tests inject CADDY_RELOAD=fake-reload-cmd / CADDY_FILE=/tmp/...
# to make the reload + write paths deterministic.

# ---- managed-block primitive ---------------------------------------

# caddy::_block_markers <tag> → echoes "begin\n<TAB>end" on two lines.
# Stable strings so awk-based stripping is exact-match (no regex
# escape needed). The tag is part of the marker so multiple managed
# blocks (synapse + future ones) can coexist.
caddy::_block_markers() {
    local tag="$1"
    printf '# BEGIN %s (managed by synapse setup.sh — do not edit)\n' "$tag"
    printf '# END %s (managed by synapse setup.sh)\n' "$tag"
}

# caddy::upsert_block <file> <tag>
# Reads block content from stdin. Strips any pre-existing block with
# the same tag (matched by exact BEGIN/END lines), then appends the
# new block at the bottom. Atomic via mktemp+mv. Re-running with the
# same input is a no-op semantically (the BEGIN/END markers identify
# the managed region and the rest of the file is preserved verbatim).
caddy::upsert_block() {
    local file="$1" tag="$2"
    local begin end
    begin="$(printf '# BEGIN %s (managed by synapse setup.sh — do not edit)' "$tag")"
    end="$(printf   '# END %s (managed by synapse setup.sh)' "$tag")"
    local content
    content="$(cat)"
    local tmp
    tmp="$(mktemp "${file}.XXXXXX")" || return 2
    if [[ -f "$file" ]]; then
        # Strip any existing block with the same tag.
        awk -v b="$begin" -v e="$end" '
            $0 == b { skip = 1; next }
            $0 == e { skip = 0; next }
            !skip   { print }
        ' "$file" >"$tmp"
    else
        : >"$tmp"
    fi
    {
        printf '\n%s\n' "$begin"
        printf '%s\n' "$content"
        printf '%s\n' "$end"
    } >>"$tmp"
    if [[ -f "$file" ]]; then
        chmod --reference="$file" "$tmp" 2>/dev/null || chmod 0644 "$tmp"
    else
        chmod 0644 "$tmp"
    fi
    mv -f "$tmp" "$file"
}

# caddy::remove_block <file> <tag>
# Strips the managed block with the given tag. Used by uninstall.
caddy::remove_block() {
    local file="$1" tag="$2"
    [[ -f "$file" ]] || return 0
    local begin end
    begin="$(printf '# BEGIN %s (managed by synapse setup.sh — do not edit)' "$tag")"
    end="$(printf   '# END %s (managed by synapse setup.sh)' "$tag")"
    local tmp
    tmp="$(mktemp "${file}.XXXXXX")" || return 2
    awk -v b="$begin" -v e="$end" '
        $0 == b { skip = 1; next }
        $0 == e { skip = 0; next }
        !skip   { print }
    ' "$file" >"$tmp"
    chmod --reference="$file" "$tmp" 2>/dev/null || chmod 0644 "$tmp"
    mv -f "$tmp" "$file"
}

# ---- mode detection ------------------------------------------------

# caddy::detect_mode → echoes one of caddy_host / nginx_external /
# caddy_compose. Always exits 0; the caller branches on the string.
caddy::detect_mode() {
    if detect::has_caddy; then
        # If caddy is on PATH and a unit is enabled, treat as host.
        # Tests can override via CADDY_FORCE_MODE for path coverage.
        if [[ -n "${CADDY_FORCE_MODE:-}" ]]; then
            echo "$CADDY_FORCE_MODE"
            return 0
        fi
        echo "caddy_host"
        return 0
    fi
    if detect::has_nginx; then
        echo "nginx_external"
        return 0
    fi
    echo "caddy_compose"
}

# ---- template rendering --------------------------------------------

# caddy::_render <template> → echoes the rendered template to stdout.
# Substitutes {{KEY}} placeholders from exported env vars (DOMAIN,
# DASHBOARD_PORT, SYNAPSE_PORT, ACME_EMAIL). Same substitution logic
# as secrets::render_env_tmpl, factored slightly differently so we
# can pipe straight into upsert_block / a file.
caddy::_render() {
    local tmpl="$1"
    [[ -r "$tmpl" ]] || { echo "caddy::_render: $tmpl unreadable" >&2; return 2; }
    local content
    content="$(cat "$tmpl")"
    local placeholders
    placeholders="$(grep -oE '\{\{[A-Z_][A-Z0-9_]*\}\}' "$tmpl" | sort -u)"
    local ph key val esc
    while IFS= read -r ph; do
        # Avoid `[[ ]] && cmd`: under set -e the test's exit code
        # propagates and aborts the loop. Use explicit `if`/`fi`.
        if [[ -z "$ph" ]]; then continue; fi
        key="${ph#\{\{}"; key="${key%\}\}}"
        val="${!key:-}"
        esc="$(printf '%s' "$val" | sed -e 's/[\&|]/\\&/g')"
        content="$(printf '%s' "$content" | sed "s|${ph}|${esc}|g")"
    done <<<"$placeholders"
    printf '%s' "$content"
}

# ---- mode actions ---------------------------------------------------

# caddy::install_host_block <caddy_file> <fragment_template>
# caddy_host mode entry point. Renders the fragment template,
# upserts it into <caddy_file>, then reloads Caddy (or runs
# CADDY_RELOAD if set, for tests).
caddy::install_host_block() {
    local caddy_file="${1:-/etc/caddy/Caddyfile}"
    local tmpl="${2:-$INSTALLER_TEMPLATES/caddy.fragment}"
    local rendered
    rendered="$(caddy::_render "$tmpl")" || return 2

    # v1.0 custom domains: append the wildcard site block. In host-
    # Caddy mode upstream defaults to 127.0.0.1 (Synapse runs on the
    # host, not behind a service-name DNS). The operator MUST add
    # `on_demand_tls { ask http://127.0.0.1:8080/v1/internal/tls_ask }`
    # to the global block of /etc/caddy/Caddyfile themselves —
    # the managed BEGIN/END markers can't reach into the global
    # section.
    if [[ -n "${SYNAPSE_BASE_DOMAIN:-}" ]]; then
        local wildcard_tmpl="${3:-$INSTALLER_TEMPLATES/caddy.wildcard}"
        if [[ -r "$wildcard_tmpl" ]]; then
            local upstream="${CADDY_UPSTREAM_HOST:-127.0.0.1}"
            rendered+=$'\n'"$(CADDY_UPSTREAM_HOST="$upstream" \
                caddy::_render "$wildcard_tmpl")"
        fi
    fi

    if ! caddy::upsert_block "$caddy_file" "synapse" <<<"$rendered"; then
        echo "caddy::install_host_block: upsert failed" >&2
        return 2
    fi
    local reload_cmd="${CADDY_RELOAD:-systemctl reload caddy}"
    # shellcheck disable=SC2086  # intentional word-split for the
    # configurable command string.
    $reload_cmd
}

# caddy::print_nginx_snippet <nginx_template>
# nginx_external mode. Prints a config block the operator can paste
# into their nginx server { } context. We don't auto-edit nginx
# configs because the surface is too varied.
caddy::print_nginx_snippet() {
    cat <<EOF
# === Synapse — paste into your existing nginx server block ===
location /v1/   { proxy_pass http://127.0.0.1:${SYNAPSE_PORT:-8080}/v1/;   proxy_http_version 1.1; proxy_set_header Host \$host; }
location /d/    { proxy_pass http://127.0.0.1:${SYNAPSE_PORT:-8080}/d/;    proxy_http_version 1.1; proxy_set_header Host \$host; }
location /health { proxy_pass http://127.0.0.1:${SYNAPSE_PORT:-8080}/health; }
location /      { proxy_pass http://127.0.0.1:${DASHBOARD_PORT:-6790}/;  proxy_http_version 1.1; proxy_set_header Host \$host; }
# Then: sudo nginx -t && sudo systemctl reload nginx
EOF
}

# caddy::write_standalone <out_file> <standalone_template>
# caddy_compose mode. Renders the standalone Caddyfile to a path
# the docker-compose `caddy` service will mount. When
# SYNAPSE_BASE_DOMAIN is non-empty, also appends the wildcard
# block (caddy.wildcard) so per-deployment subdomains work via
# Caddy on-demand TLS. Refuses to overwrite an existing file unless
# CADDY_FORCE_OVERWRITE=1.
caddy::write_standalone() {
    local out="${1:?out path required}"
    local tmpl="${2:-$INSTALLER_TEMPLATES/caddy.standalone}"
    if [[ -e "$out" && "${CADDY_FORCE_OVERWRITE:-0}" != "1" ]]; then
        echo "caddy::write_standalone: $out exists; pass CADDY_FORCE_OVERWRITE=1 to replace" >&2
        return 1
    fi
    local rendered
    rendered="$(caddy::_render "$tmpl")" || return 2

    # v1.0 custom domains: append the wildcard site block when the
    # operator opted in. The standalone template's global already
    # carries the on_demand_tls { ask } gate — only the site block
    # itself is conditional.
    if [[ -n "${SYNAPSE_BASE_DOMAIN:-}" ]]; then
        local wildcard_tmpl="${3:-$INSTALLER_TEMPLATES/caddy.wildcard}"
        if [[ ! -r "$wildcard_tmpl" ]]; then
            echo "caddy::write_standalone: $wildcard_tmpl unreadable" >&2
            return 2
        fi
        # In compose mode the upstream is the synapse-api service
        # name on the bridge network (NOT 127.0.0.1 — that resolves
        # inside the Caddy container). Operators who want a different
        # upstream can preset CADDY_UPSTREAM_HOST.
        local upstream="${CADDY_UPSTREAM_HOST:-synapse-api}"
        CADDY_UPSTREAM_HOST="$upstream" rendered+=$'\n'"$(caddy::_render "$wildcard_tmpl")" \
            || return 2
    fi

    local tmp
    tmp="$(mktemp "${out}.XXXXXX")" || return 2
    printf '%s' "$rendered" >"$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$out"
}

# caddy::install_headscale_block
# Renders installer/templates/caddy.headscale.fragment.tmpl with the
# current SYNAPSE_BASE_DOMAIN + ACME_EMAIL, then upserts it into
# whichever Caddyfile is in play and reloads Caddy. NO-OP when
# SYNAPSE_BASE_DOMAIN is empty — without a subdomain we have nothing
# to put the headscale site on (Headscale doesn't support sub-path
# deployment, so the path-mux trick the rest of Synapse uses is
# unavailable here).
#
# Modes (mirrors caddy::install_host_block / caddy::write_standalone):
#
#   caddy_host:    append to /etc/caddy/Caddyfile + systemctl reload
#   caddy_compose: append to $SYNAPSE_CADDYFILE_PATH (the bind-mounted
#                  standalone Caddyfile) + docker compose exec caddy
#                  caddy reload
#   nginx_external: print a hint and return 0 — the operator owns
#                   their nginx config and Headscale needs WebSocket
#                   passthrough they have to wire by hand.
caddy::install_headscale_block() {
    # Bail when neither SYNAPSE_BASE_DOMAIN nor SYNAPSE_HEADSCALE_DOMAIN
    # is set — without a hostname we have nothing to render. The block
    # is also rendered with whichever is set (override wins) so the
    # operator can place Headscale outside any deployments wildcard.
    if [[ -z "${SYNAPSE_BASE_DOMAIN:-}" && -z "${SYNAPSE_HEADSCALE_DOMAIN:-}" ]]; then
        return 0
    fi
    local headscale_host
    if [[ -n "${SYNAPSE_HEADSCALE_DOMAIN:-}" ]]; then
        headscale_host="${SYNAPSE_HEADSCALE_DOMAIN#.}"
    else
        headscale_host="headscale.${SYNAPSE_BASE_DOMAIN#.}"
    fi
    local tmpl="${1:-$INSTALLER_TEMPLATES/caddy.headscale.fragment.tmpl}"
    if [[ ! -r "$tmpl" ]]; then
        echo "caddy::install_headscale_block: $tmpl unreadable" >&2
        return 2
    fi
    # The fragment template carries an {{ACME_EMAIL_BLOCK}} placeholder
    # that expands to a `tls <email>` directive when an ACME email is
    # configured. ACME_EMAIL may be empty when the operator only
    # passed --base-domain (no --domain); fall back to SYNAPSE_ACME_EMAIL
    # from .env so the headscale block always gets standard ACME (not
    # the unsuitable on_demand wildcard).
    local effective_email="${ACME_EMAIL:-${SYNAPSE_ACME_EMAIL:-}}"
    local email_block=""
    if [[ -n "$effective_email" ]]; then
        email_block="tls ${effective_email}"
    fi
    local rendered
    rendered="$(SYNAPSE_HEADSCALE_HOST="$headscale_host" \
                ACME_EMAIL_BLOCK="$email_block" \
                caddy::_render "$tmpl")" || return 2

    local mode
    mode="$(caddy::detect_mode)"
    case "$mode" in
        caddy_host)
            local caddy_file="${CADDY_FILE:-/etc/caddy/Caddyfile}"
            if ! caddy::upsert_block "$caddy_file" "synapse-headscale" <<<"$rendered"; then
                echo "caddy::install_headscale_block: upsert failed" >&2
                return 2
            fi
            local reload_cmd="${CADDY_RELOAD:-systemctl reload caddy}"
            # shellcheck disable=SC2086
            $reload_cmd
            ;;
        caddy_compose)
            local caddy_file="${SYNAPSE_CADDYFILE_PATH:-$INSTALL_DIR/Caddyfile}"
            if ! caddy::upsert_block "$caddy_file" "synapse-headscale" <<<"$rendered"; then
                echo "caddy::install_headscale_block: upsert failed" >&2
                return 2
            fi
            # In compose mode the Caddy container reads the bind-
            # mounted Caddyfile; trigger a graceful reload so the
            # new headscale.<base> site activates without dropping
            # connections on the main {{DOMAIN}} block.
            local cmd="${CADDY_COMPOSE_RELOAD_CMD:-${COMPOSE_CMD:-docker}}"
            "$cmd" compose -f "$INSTALL_DIR/docker-compose.yml" \
                exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null \
                || "$cmd" compose -f "$INSTALL_DIR/docker-compose.yml" restart caddy
            ;;
        nginx_external)
            cat <<EOF >&2
# === Synapse — add to your nginx config to front Headscale ===
server {
    listen 443 ssl http2;
    server_name headscale.${SYNAPSE_BASE_DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:8181;  # or your headscale port
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
# Then: sudo nginx -t && sudo systemctl reload nginx
EOF
            ;;
        *)
            echo "caddy::install_headscale_block: unknown mode $mode" >&2
            return 2
            ;;
    esac
}
