# installer-agent/install/agent.sh
# shellcheck shell=bash
#
# Agent binary install + register + systemd unit.
#
# Public functions:
#   agent::bootstrap_config CONTROL_URL
#                       -> GET /v1/install_agent/config; echoes JSON
#   agent::download VERSION ARCH DOWNLOAD_URL_TEMPLATE
#                       -> fetch tarball, verify SHA256, install binary
#   agent::register CONTROL_URL ADOPTION_TOKEN TAILNET_ADDR SSH_PUBKEY
#                       -> POST /v1/agents/register; write 0600 config
#   agent::install_systemd
#                       -> drop unit, daemon-reload, enable --now
#
# Token redaction: register response is filtered through ui::redact
# before being echoed; we never log the adoption token, the agent
# token, or the pre-auth key. The /etc/synapse-agent/config.json file
# itself is mode 0600 owned by synapse-agent — operator-readable only
# via sudo, never via shell history.
#
# Callers MUST source installer-agent/install/ui.sh first and set
# $ARCH and $INSTALLER_AGENT_TEMPLATES.

# agent::bootstrap_config <control_url>
# Fetch the backend's install-agent bootstrap config. Returns a JSON
# document describing:
#   - headscaleServerUrl: where Tailscale clients register
#   - agentVersion:       which synapse-agent version to install
#   - downloadUrl:        template with {{version}} + {{arch}}
#   - downloadSha256Url:  same template, sha256 sidecar
#
# Echoes the response body on stdout. Caller pipes through jq to
# extract the fields. Fails (exit 2) if curl fails or the response
# isn't a JSON object.
agent::bootstrap_config() {
    local control_url="$1"
    local resp
    ui::step "Fetching install-agent bootstrap config from $control_url"
    if ! resp="$(curl -fsSL --max-time 15 \
            "$control_url/v1/install_agent/config" 2>/dev/null)"; then
        ui::fail "Could not GET $control_url/v1/install_agent/config — check control URL + backend version (needs v1.18+)"
        return 2
    fi
    # Sanity-check it's a JSON object before downstream jq calls die.
    if ! printf '%s' "$resp" | jq -e 'type == "object"' >/dev/null 2>&1; then
        ui::fail "Bootstrap config response was not a JSON object: $(printf '%s' "$resp" | ui::redact | head -c 200)"
        return 2
    fi
    ui::ok "Bootstrap config received"
    printf '%s' "$resp"
}

# agent::download <version> <arch> <download_url_template>
# Substitutes {{version}} and {{arch}} in the template, downloads the
# tarball + .sha256 sidecar, verifies, extracts, installs the binary.
agent::download() {
    local version="$1" arch="$2" download_url="$3"
    local url="${download_url//\{\{version\}\}/$version}"
    url="${url//\{\{arch\}\}/$arch}"
    local checksum_url="$url.sha256"
    local tarball="/tmp/synapse-agent-$$.tar.gz"
    local stage="/tmp/synapse-agent-stage-$$"

    # Always clean up the staging files — even on failure mid-way. We
    # don't trap EXIT here because install-agent.sh's top-level trap is
    # already handling that; we just rm explicitly at the success path
    # and on any short-circuit return.
    _cleanup() { rm -rf "$tarball" "$tarball.sha256" "$stage" 2>/dev/null || true; }

    ui::step "Downloading synapse-agent $version ($arch)"
    ui::info "  $url"
    if ! curl -fsSL --retry 3 --max-time 120 -o "$tarball" "$url"; then
        _cleanup
        ui::fail "Download failed: $url"
        return 2
    fi
    if ! curl -fsSL --retry 3 --max-time 30 -o "$tarball.sha256" "$checksum_url"; then
        _cleanup
        ui::fail "Checksum download failed: $checksum_url"
        return 2
    fi

    # sha256sum -c expects the path inside the sums file to match an
    # existing file in cwd. The release sidecar typically contains
    # `<hex>  synapse-agent-<v>-linux-<arch>.tar.gz`; rewrite the path
    # to point at our $tarball so -c works regardless of cwd.
    local expected_hash actual_hash
    expected_hash="$(awk 'NR==1 { print $1 }' "$tarball.sha256")"
    if [[ -z "$expected_hash" ]]; then
        _cleanup
        ui::fail "Empty/malformed checksum file: $checksum_url"
        return 2
    fi
    actual_hash="$(sha256sum "$tarball" | awk '{ print $1 }')"
    if [[ "$expected_hash" != "$actual_hash" ]]; then
        _cleanup
        ui::fail "SHA256 mismatch (expected $expected_hash, got $actual_hash)"
        return 2
    fi
    ui::ok "SHA256 verified"

    mkdir -p "$stage"
    if ! tar -C "$stage" -xzf "$tarball"; then
        _cleanup
        ui::fail "tar extraction failed"
        return 2
    fi
    # The release tarball ships `synapse-agent` at the top level (or
    # under a single dir). Look in both places.
    local bin=""
    if [[ -x "$stage/synapse-agent" ]]; then
        bin="$stage/synapse-agent"
    else
        bin="$(find "$stage" -maxdepth 2 -type f -name synapse-agent -perm -u+x 2>/dev/null | head -1)"
    fi
    if [[ -z "$bin" ]]; then
        _cleanup
        ui::fail "synapse-agent binary not found inside tarball"
        return 2
    fi
    install -m 0755 "$bin" /usr/local/bin/synapse-agent
    _cleanup
    local installed_version
    installed_version="$(/usr/local/bin/synapse-agent version 2>/dev/null | head -1 || echo unknown)"
    ui::ok "Installed /usr/local/bin/synapse-agent ($installed_version)"
}

# agent::register <control_url> <adoption_token> <tailnet_addr> <ssh_pubkey>
# POST /v1/agents/register with the local facts. The backend
# (Phase 1 + this branch's Backend Ext) extends agentRegisterReq to
# also accept tailnetAddr + sshPubkey + sshUser and persists them onto
# the host row. The response carries the long-lived agent token, which
# we write to /etc/synapse-agent/config.json (mode 0600, owned by
# synapse-agent).
agent::register() {
    local control_url="$1" adoption_token="$2" tailnet_addr="$3" pubkey="$4"
    local ssh_user="${SSH_USER:-synapse-deployer}"
    local agent_version
    agent_version="$(/usr/local/bin/synapse-agent version 2>/dev/null | head -1 || echo unknown)"
    local docker_version
    docker_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
    local host_name
    host_name="$(hostname 2>/dev/null || echo unknown)"

    # Build payload via jq so we don't have to hand-escape strings.
    local payload
    payload="$(jq -n \
        --arg token        "$adoption_token" \
        --arg hostname     "$host_name" \
        --arg os           "linux" \
        --arg arch         "${ARCH:-unknown}" \
        --arg agentVersion "$agent_version" \
        --arg dockerVersion "$docker_version" \
        --arg tailnetAddr  "$tailnet_addr" \
        --arg sshPubkey    "$pubkey" \
        --arg sshUser      "$ssh_user" \
        '{token: $token,
          hostname: $hostname,
          os: $os,
          arch: $arch,
          agentVersion: $agentVersion,
          dockerVersion: $dockerVersion,
          tailnetAddr: $tailnetAddr,
          sshPubkey: $sshPubkey,
          sshUser: $sshUser}')"

    ui::step "Registering with Synapse central"
    local resp http_status
    # Capture body + status separately so a non-2xx gives a useful message.
    local tmp_body
    tmp_body="$(mktemp)"
    http_status="$(curl -sS -o "$tmp_body" -w '%{http_code}' \
        --max-time 30 \
        -X POST \
        -H 'Content-Type: application/json' \
        --data "$payload" \
        "$control_url/v1/agents/register" || true)"
    resp="$(cat "$tmp_body")"
    rm -f "$tmp_body"

    if [[ "$http_status" != "200" && "$http_status" != "201" ]]; then
        ui::fail "Register failed: HTTP $http_status — $(printf '%s' "$resp" | ui::redact | head -c 300)"
        return 2
    fi

    local agent_token host_id
    agent_token="$(printf '%s' "$resp" | jq -r '.agentToken // empty')"
    host_id="$(printf '%s' "$resp" | jq -r '.hostId // empty')"
    if [[ -z "$agent_token" || "$agent_token" == "null" ]]; then
        ui::fail "Register response missing agentToken: $(printf '%s' "$resp" | ui::redact | head -c 300)"
        return 2
    fi

    # Persist the agent config. Mode 0600, owned by synapse-agent.
    install -d -m 0750 -o synapse-agent -g synapse-agent /etc/synapse-agent

    # Use jq to render the config so quoting is bulletproof.
    local config
    config="$(jq -n \
        --arg controlUrl  "$control_url" \
        --arg agentToken  "$agent_token" \
        --arg hostId      "$host_id" \
        '{controlUrl: $controlUrl,
          agentToken: $agentToken,
          hostId: $hostId,
          heartbeatIntervalSeconds: 15,
          mode: "observe-only",
          docker: {enabled: true}}')"

    # Write atomically: tmp + chmod + chown + mv so the file is never
    # readable mid-write.
    local cfg=/etc/synapse-agent/config.json
    local tmp_cfg
    tmp_cfg="$(mktemp /etc/synapse-agent/.config.json.XXXXXX)"
    printf '%s\n' "$config" > "$tmp_cfg"
    chmod 0600 "$tmp_cfg"
    chown synapse-agent:synapse-agent "$tmp_cfg"
    mv "$tmp_cfg" "$cfg"
    ui::ok "Registered with Synapse central (host: $host_id); agent token persisted to $cfg"
}

# agent::install_systemd — drop the unit + enable+start. Idempotent:
# re-running install-agent.sh on a host with an active unit reloads
# the unit (in case the template changed) and restarts to pick up any
# new config.json.
agent::install_systemd() {
    install -m 0644 \
        "$INSTALLER_AGENT_TEMPLATES/synapse-agent.service" \
        /etc/systemd/system/synapse-agent.service
    systemctl daemon-reload
    if ! systemctl enable --now synapse-agent.service; then
        ui::fail "systemctl enable --now synapse-agent.service failed"
        return 2
    fi
    # If it was already active, --now is a no-op; restart to pick up
    # any updated config.json from a re-register.
    systemctl restart synapse-agent.service
    ui::ok "synapse-agent.service started"
}
