# Remote Hosts (v1.18+)

Run Synapse-managed Convex deployments on VPSes other than the
control plane host — multi-region, scale-out, blast-radius
isolation. One-liner install on each VPS, dashboard handles the
rest.

> **Status:** shipped in v1.18.0; v1.19 promoted enablement to the
> dashboard (Admin → Remote Hosts) and lit up dynamic upstream
> routing for deployments placed on remote hosts. Validated
> end-to-end on a Hetzner CPX22 control plane + a CX11 worker
> reached over a self-hosted Headscale tailnet. The central proxy
> now forwards `<deployment>.<base-domain>`, `/d/<deployment>`, and
> `<deployment>.site.<base-domain>` (cloud only — see
> [Limitations](#limitations-v1190) for the v1.19 site carve-out)
> to the remote tailnet IP automatically.

## TL;DR

Open **Admin → Remote Hosts** in the dashboard and click
**Configure** (v1.19+). For each new VPS afterwards: click **Hosts →
New host → Setup remote install**, copy the one-liner, paste it
into the VPS's root shell. The VPS joins a private tailnet,
generates an ed25519 SSH keypair, sends the *private* key to
Synapse central (encrypted at rest with `crypto.SecretBox`), and
registers as `online` within ~60 s. Place deployments on it from
the dashboard's **Place on host** dropdown or with `synapse
deployment create --host=<uuid>`.

If you prefer the CLI, `setup.sh --configure-headscale` is the same
workflow as the dashboard button (operators reaching for it most
often when the dashboard isn't yet running). The legacy
`setup.sh --enable-headscale` flag stays as an install-time
opt-in for fresh installs.

## Architecture

Three pieces stacked on top of the existing single-host control
plane:

1. **Headscale** — a self-hosted Tailscale control plane (v0.28.0,
   `installer/install/headscale.sh`). Runs on the Synapse host
   itself as the `headscale` compose profile, fronted by Caddy at
   `headscale.<base-domain>`. Identity layer for the tailnet;
   clients (the VPSes) join via single-use pre-auth keys minted by
   Synapse central on demand. Postgres-backed (separate DB from
   Synapse's metadata). Why self-hosted: zero third-party
   dependency on the identity path — the operator owns the entire
   tailnet, no Tailscale Inc. account required.
2. **`install-agent.sh`** — pure-bash one-liner installed on each
   new VPS (`install-agent.sh:1-60` for the contract). Bootstraps
   from `curl | sudo bash` exactly the way `setup.sh` does, then:
   joins the tailnet (`tailscale up --login-server=...`), fetches
   the agent download manifest from `GET /v1/install_agent/config`,
   downloads + SHA256-verifies the `synapse-agent` tarball,
   creates two system users (`synapse-agent` observer +
   `synapse-deployer` SSH target), generates an ed25519 keypair
   for `synapse-deployer`, posts the *private* key to Synapse
   central along with the adoption token, and registers the
   hardened `synapse-agent.service` systemd unit. Idempotent —
   re-running it picks up where it left off.
3. **`sshprov` / `RemoteClient`** — Synapse central's Go-side SSH
   layer (`synapse/internal/sshprov/`,
   `synapse/internal/docker/remote.go`). Per-host SSH connection
   pool keyed on `(hostID, tailnetAddr)` with a 5-minute idle
   timeout. Decrypts the per-host private key on demand via
   `internal/hostssh.LoadPrivKey`, dials the VPS at its tailnet
   IP:22, sends `docker run / stop / inspect / ...` strings as the
   SSH command. The remote sshd's `Match User synapse-deployer`
   block force-execs every command through
   `/usr/local/bin/synapse-deployer-exec`, which whitelists exactly
   nine docker subcommands and rejects everything else.

```
┌────────────────────────────────────────────────────────────────┐
│ Synapse control plane host                                     │
│                                                                │
│   ┌──────────────────┐    ┌──────────────────────────────┐     │
│   │ synapse-api      │    │ synapse-headscale            │     │
│   │ (Go, port 8080)  │───▶│ (Tailscale control plane,    │     │
│   │                  │    │  port 8080 internal,         │     │
│   │ • headscale.Client│   │  fronted at                  │     │
│   │ • sshprov.Client │    │  headscale.<base-domain>)    │     │
│   │ • hostssh.LoadPrivKey └──────────────────────────────┘     │
│   │ • crypto.SecretBox                                         │
│   └────────┬─────────┘                                         │
│            │ docker run / stop / inspect (local socket)        │
│            ▼                                                   │
│      Self-host deployments                                     │
└────────────────────────────────────────────────────────────────┘
              │
              │ SSH over Headscale tailnet (100.64.0.0/10)
              │ — per-host ed25519 key, forced-command wrapper
              ▼
┌────────────────────────────────────────────────────────────────┐
│ Remote VPS (e.g. Hetzner CX11 in eu-central)                   │
│                                                                │
│   tailscaled ◀──── pre-auth key ──── headscale on central      │
│       │                                                        │
│       ▼                                                        │
│   sshd (port 22)                                               │
│     │  Match User synapse-deployer:                            │
│     │    ForceCommand /usr/local/bin/synapse-deployer-exec     │
│     │    PermitTTY no · AllowTcpForwarding no · ...            │
│     ▼                                                          │
│   synapse-deployer-exec                                        │
│     │  whitelist: run · stop · rm · start · restart            │
│     │             inspect · ps · logs · version                │
│     ▼                                                          │
│   docker run …  →  convex-<name> container                     │
│                                                                │
│   synapse-agent.service (observe-only heartbeat)               │
└────────────────────────────────────────────────────────────────┘
```

The two channels are independent. The agent's outbound HTTPS
heartbeat (`POST /v1/agents/heartbeat`) carries liveness +
container observations, the same as a pre-v1.18 agent. The SSH
channel is *initiated by Synapse central* and used only for
provisioning mutations — never for liveness, never for reads the
agent can already volunteer.

## End-to-end flow (operator perspective)

1. Buy a VPS. Any Linux distro with `systemd` + Docker + `sshd` is
   fine. Validated against Ubuntu 24.04 on Hetzner CX11; Debian 12,
   Fedora, RHEL all work as long as `getent`, `useradd`, and
   `systemctl` are present.
2. In the Synapse dashboard, go to **Hosts → New host** and fill in
   a name + region (free-form labels, used only in the UI). A row
   appears with status `unknown`.
3. Click **Setup remote install** on that row. A modal renders a
   single bash command with three secrets baked in:
   `--control-url`, `--headscale-auth` (pre-auth key), and
   `--adoption-token`. **Copy it now — those secrets are shown
   exactly once.** Both expire 60 minutes from creation.
4. SSH into the VPS as root (or via `sudo bash -c '...'`) and
   paste. The script prints one line per phase (preflight →
   tailscale → register → systemd → verify) and exits when the
   first heartbeat lands.
5. Refresh the dashboard. The host row flips to `online` with
   `agentVersion`, `dockerVersion`, CPU / RAM / disk facts, the
   tailnet IP, and the SSH pubkey fingerprint visible.
6. Create a deployment. In **New deployment → Place on host**,
   pick the VPS. The container provisions there in ~1 s via the
   SSH channel; the deployment row shows an `on <host-name>` badge
   so operators can tell at a glance which deployments live where.

## End-to-end flow (technical)

Two protocols layered on top of each other. Each step cites the
file:line where it lives so a reader can audit without grep.

### Setup (one-time, control plane)

`setup.sh --enable-headscale` calls `phase_install_headscale`
(`setup.sh:897`), which routes through
`installer/install/headscale.sh:headscale::bootstrap`. The phase:

- flips the `headscale` compose profile on (`installer/install/headscale.sh:_compose`)
- generates the Headscale Postgres credentials
  (`SYNAPSE_HEADSCALE_DB_{NAME,USER,PASSWORD}`)
- renders `headscale/config.yaml` from
  `installer/templates/headscale.config.yaml.tmpl` (server URL,
  Postgres connection)
- mints an admin API key via `headscale apikeys create`, persisting
  it in `.env` as `SYNAPSE_HEADSCALE_API_KEY`
- appends the `caddy.headscale.fragment.tmpl` block so Caddy issues
  a Let's Encrypt cert for `headscale.<base-domain>` automatically
- restarts `synapse-api` so it picks up `SYNAPSE_HEADSCALE_URL`,
  `SYNAPSE_HEADSCALE_API_KEY`, and `SYNAPSE_HEADSCALE_SERVER_URL`
  from `.env`

Skipped (with a friendly message, no error) when the operator
re-runs `setup.sh` *without* the flag and `SYNAPSE_HEADSCALE_URL`
isn't already in `.env` — predicate `headscale::is_enabled` in
`installer/install/headscale.sh`. Hard-rejected with a clear
message when invoked under `--no-tls` *and* no `--domain` /
`--base-domain` (Tailscale clients need a stable HTTPS URL; see
`setup.sh:296`).

### Setup (one-time, per VPS — the modal flow)

`POST /v1/hosts/{id}/remote_setup`
(`synapse/internal/api/remote_setup.go:56-167`) runs as
instance-admin:

1. Returns `503 remote_hosts_disabled` if `h.Headscale == nil` or
   `h.HeadscaleServerURL == ""` — i.e. the operator didn't run
   `--enable-headscale`.
2. Loads the host row by `chi.URLParam("hostID")`.
3. Mints a Synapse adoption token via
   `auth.GenerateTokenWithPrefix("syn_adopt_")`, persists the
   SHA-256 hash + `expires_at` in `host_adoption_tokens`.
4. Calls `headscale.Client.CreatePreAuthKey` with the same expiry
   (`reusable=false, ephemeral=false`) against the `synapse` user
   namespace. Returns `502 headscale_unreachable` if Headscale is
   down.
5. Composes the one-liner with both secrets inlined and returns
   `{adoptionToken, headscaleAuthKey, controlUrl, oneLiner,
   expiresAt}`. The audit record carries `hostName` +
   `expiresAt` only — neither secret touches the audit log.

Both tokens share a 1-hour TTL
(`remote_setup.go:remoteSetupTTL`).

### Install on the VPS

The pasted command first hits `GET /install-agent.sh` (served by
Caddy from the repo). The script then walks:

1. **Preflight** (`installer-agent/install/preflight.sh`):
   Linux + systemd + amd64/arm64 + root + Docker + reachable
   `--control-url`.
2. **Bootstrap re-exec** (`install-agent.sh:needs_bootstrap`):
   under `curl | bash` the `installer-agent/` library tree isn't
   on disk; `bootstrap()` git-clones the repo into
   `/tmp/convex-synapse-agent-bootstrap-<pid>` and re-execs from
   there with the original args. Operators who `git clone`d
   first see no behaviour change.
3. **Tailscale install + join**
   (`installer-agent/install/tailscale.sh`): installs `tailscale`
   via the upstream Debian/Fedora repo if absent, then
   `tailscale up --login-server=<headscale-url>
   --auth-key=<pre-auth-key>`. Captures the resulting tailnet IP.
4. **Agent download** (`installer-agent/install/agent.sh`):
   `GET /v1/install_agent/config` returns the agent download URL
   pattern (`agentDownloadUrl`) + the current
   `agentVersion` + a `remoteProvisioningEnabled` flag
   (`synapse/internal/api/install_agent.go`). The script fetches
   the matching tarball from GitHub Releases, verifies SHA256,
   installs `/usr/local/bin/synapse-agent`.
5. **Users + groups** (`installer-agent/install/users.sh`):
   creates `synapse-agent` (observer, in `docker` group),
   `synapse-deployer` (SSH target, in `docker` group, no shell
   login outside the wrapper).
6. **SSH plumbing** (`installer-agent/install/ssh.sh`):
   `ssh::generate_keypair` produces a fresh ed25519 keypair under
   `$INSTALL_DIR/synapse_deployer_ed25519` (mode 0600).
   `ssh::install_deployer_exec` drops the forced-command wrapper
   at `/usr/local/bin/synapse-deployer-exec`.
   `ssh::install_authorized_keys` writes
   `~synapse-deployer/.ssh/authorized_keys` with
   `command="/usr/local/bin/synapse-deployer-exec",restrict <pubkey>`.
   `ssh::configure_sshd` renders
   `installer-agent/templates/sshd-synapse.conf` into
   `/etc/ssh/sshd_config.d/`, runs `sshd -t`, reloads sshd.
7. **Register**
   (`installer-agent/install/agent.sh`): `POST /v1/agents/register`
   with the adoption token, tailnet IP, SSH pubkey, and the
   ed25519 *private* key in the body. Server-side
   `resolveOrCreateHost` consumes the token, stamps
   `hosts.tailnet_addr`, `hosts.ssh_pubkey`,
   `hosts.ssh_privkey_encrypted` (encrypted via
   `crypto.SecretBox`), `hosts.ssh_privkey_fingerprint`, and
   `hosts.is_remote=true`, then returns the long-lived agent
   token. Written to `/etc/synapse-agent/config.json` (mode
   0600).
8. **systemd**
   (`installer-agent/templates/synapse-agent.service`): install +
   `systemctl enable --now`. Hardened: `ProtectSystem=strict`,
   `ProtectHome=true`, `PrivateTmp=true`, `NoNewPrivileges=true`,
   `RestrictNamespaces=true`, `MemoryDenyWriteExecute=true`,
   `SystemCallFilter=@system-service`, empty capability set. The
   agent itself is in `docker` group only — no `CAP_NET_BIND` etc.
9. **Verify** (`installer-agent/install/verify.sh`):
   `journalctl -u synapse-agent --since` for "heartbeat ok", up
   to ~30 s. Exits non-zero with the captured journal tail if
   nothing lands.

### Provisioning a deployment on a remote host

1. Dashboard `POST /v1/projects/{id}/deployments` carries
   `hostId: "<uuid>"` (the dropdown selection). Handler
   `createDeployment` (`synapse/internal/api/deployments.go:1313`)
   validates the host exists, is `online` (effective status), is
   `is_remote=true` *and* has `ssh_privkey_encrypted IS NOT NULL`
   (rejects half-set hosts), then writes `deployments.host_id`.
2. A row lands in `provisioning_jobs`. The worker
   (`synapse/internal/provisioner/worker.go`) claims it with
   `SELECT … FOR UPDATE SKIP LOCKED`, JOINing
   `hosts` on `deployments.host_id` to read `is_remote`,
   `tailnet_addr`, `ssh_user`, `ssh_port` into the in-flight
   `claimedJob` (`worker.go:425`).
3. `Worker.dockerForJob` (`worker.go:1395`) branches: local
   `*dockerprov.Client` for `is_remote=false`, fresh
   `*dockerprov.RemoteClient` bound to the host's tailnet IP for
   `is_remote=true`. On misconfiguration (Remote Hosts disabled,
   missing tailnet, etc.) the helper `markFailed`s the job with a
   clear hint and returns nil.
4. `RemoteClient.Provision`
   (`synapse/internal/docker/remote.go`) builds the same env list
   the local `Client.Provision` would, then sends a `docker run …`
   string through `sshprov.Client.Run`. The sshprov client decrypts
   the host's private key via `hostssh.LoadPrivKey`, dials
   `<tailnet_addr>:22`, sends the command. On the remote sshd:
   `Match User synapse-deployer` triggers `ForceCommand` →
   `synapse-deployer-exec` parses `SSH_ORIGINAL_COMMAND`, asserts
   `argv[0] == "docker"` and `argv[1] ∈ {run, stop, rm, start,
   restart, inspect, ps, logs, version}`, then `exec "${argv[@]}"`.
5. The container comes up bound to the tailnet IP (port-published
   inside the VPS). The agent's next heartbeat reports it via
   `containerScan`. Drift converges to `in_sync`.

## Three trust layers

| Layer | What | Who controls | Compromise blast radius |
|---|---|---|---|
| **Tailnet membership** | WireGuard tunnel via Headscale; client gets a 100.64.0.0/10 IP after presenting a valid pre-auth key | Headscale admin API key on Synapse central; pre-auth keys are single-use, 1h TTL | Anyone with an active tailnet IP can reach `synapse-deployer@<vps>:22` and present an SSH key — defeated by layer 2 below |
| **SSH transport** | ed25519 keypair, per-host. Privkey held by Synapse central, encrypted at rest with `crypto.SecretBox` (AES-256-GCM, the same envelope HA deployments use for Postgres URLs). Pubkey in `authorized_keys` with `restrict` + `command=` clause | `SYNAPSE_STORAGE_KEY` in the control plane `.env` | Compromise of one VPS leaks one VPS's privkey (it lives on disk in `/etc/synapse-agent/`). Compromise of Synapse central leaks every VPS's key |
| **Command authorization** | `synapse-deployer-exec` whitelist (9 docker subcommands). Anything else: `exit 99` + audit log via `logger -p auth.notice` | Hardcoded in the wrapper at install time; same script on every VPS | A bug in the wrapper. The wrapper is 70 lines, no eval, no shell expansion — auditable in one sitting |

The three layers are independent. A compromise at one layer does
not let an attacker advance to the next without re-compromising
that layer separately.

## Set it up

### On the Synapse control plane (one-time)

**Preferred (v1.19+):** open **Admin → Remote Hosts** in the
dashboard and click **Configure**. The same workflow the dashboard
drives is available as a CLI repair / automation path:

```bash
# v1.19+ — dashboard-equivalent. Requires SYNAPSE_DOMAIN or
# SYNAPSE_BASE_DOMAIN (TLS mode) — Tailscale clients need a stable
# HTTPS URL for the WebSocket upgrade.
setup.sh --configure-headscale [--headscale-domain=<host>]

# Legacy install-time opt-in (still works for fresh installs):
setup.sh --enable-headscale
```

What this does:

- Adds the `headscale` compose profile (Headscale container +
  shared Postgres database).
- Renders `<install-dir>/headscale/config.yaml` with the external
  server URL `https://headscale.<base-domain>`.
- Mints a Headscale admin API key and writes it to `.env`
  (`SYNAPSE_HEADSCALE_API_KEY`).
- Adds the `headscale.<base-domain>` block to the Caddy config —
  Let's Encrypt issues a cert on first request.
- Restarts `synapse-api` so the Headscale wiring lights up.

Skipped (no-op with a friendly note) when re-running `setup.sh`
without the flag — see `headscale::is_enabled`. Re-running *with*
the flag is idempotent; secrets are reused if already present in
`.env`.

Sanity-check after the install:

```bash
# Public Headscale endpoint should answer with the discovery JSON.
curl -sS https://headscale.<base-domain>/health
# {"status":"pass"}

# From the control plane host:
docker compose --profile headscale logs headscale --tail=20
# look for: "listening" + "control plane is ready"

# Synapse central sees Headscale:
curl -sS https://<base-domain>/v1/install_agent/config | jq .
# remoteHostsEnabled should be true; remoteProvisioningEnabled
# requires SYNAPSE_STORAGE_KEY too — set if missing.
```

### Per VPS (each new remote host)

1. Buy / spin up the VPS. Any Linux + Docker + systemd + sshd.
   Validated: Hetzner CX11 (Ubuntu 24.04, 2 vCPU / 2 GB RAM).
   DigitalOcean basic droplets and Vultr regular plans work
   equivalently — the script's preflight catches missing tools.
2. Dashboard → **Hosts** → **New host** — fill in name + region.
   These are free-form labels; the row appears with
   `status=unknown`.
3. Click **Setup remote install** on the row. A modal renders a
   single bash command with both secrets baked in. **Copy the
   one-liner before closing — the secrets are displayed
   once and never persisted on the dashboard side.**
4. SSH into the VPS as root (or use `sudo`). Paste:

   ```bash
   curl -fsSL https://synapse.example.com/install-agent.sh \
     | sudo bash -s -- \
       --control-url=https://synapse.example.com \
       --headscale-auth=tskey-auth-... \
       --adoption-token=syn_adopt_...
   ```

   The script logs to `/tmp/synapse-agent-install.log`. Phases
   announce themselves on stderr; secrets are filtered through
   `ui::redact` before printing.

5. Wait ~60 s. Refresh the dashboard — the host row flips to
   `online` with `agentVersion`, `dockerVersion`, OS/arch, CPU /
   RAM / disk, tailnet IP (`100.x.y.z`), and the SSH pubkey
   fingerprint (`SHA256:...`) visible.

If the install fails partway, **re-run the same one-liner** while
the tokens are still valid — every phase is idempotent (users
already present, keypair already on disk, sshd drop-in unchanged →
no-op). If the tokens have expired, mint a fresh bundle: dashboard
→ host row → **Setup remote install** again.

### Place a deployment on the remote host

Dashboard:

> **New deployment** → fill in name/type → **Place on host**
> dropdown → pick the VPS → **Create**.

The deployment row shows a small `on <host-name>` badge. The
provisioning timeline is identical to local provisioning (~1 s on
a warm Docker cache); the only externally observable difference is
that Synapse central waits on the SSH round-trip instead of the
local socket.

CLI:

```bash
synapse hosts list
# UUID            NAME       REGION       STATUS    TAILNET_IP
# 7c2…            vps-eu-1   eu-central   online    100.64.0.2

synapse deployment create --type=prod --host=7c2…
# Created prod-amber-cougar-4821 on host vps-eu-1.
```

## What this enables

- **Multi-region.** Spin up VPSes near your users; place each
  project's deployment on the geographically closest host.
- **Scale-out beyond one box.** The Synapse control plane host is
  no longer the per-deployment ceiling. Adopt a CX11, a CPX31, and
  a bare-metal server side by side; each carries its share of
  deployments.
- **Blast-radius isolation.** A buggy customer's deployment can no
  longer take down the control plane host — its container lives on
  a separate VPS. Combine with HA-per-deployment (v0.5+) for
  customers paying for stronger guarantees.
- **Cost-layer separation.** Run dev/preview deployments on a
  cheap CX11 and production on a CPX31 you keep on a longer
  retention SLA. Per-deployment `--host=` picks the layer; no
  cross-host migration is needed at create time.
- **Operator-owned identity path.** No third-party Tailscale Inc.
  account required — the identity layer ships in the same
  `docker-compose.yml` as Synapse.

## Limitations (v1.19.0)

Honest list. None of these are surprises mid-install — every limit
errors clearly when the operator hits it.

- **Cloud-path remote routing works; site-path remote does not.**
  Convex backends expose two HTTP ports: 3210 (cloud / client API)
  and 3211 (site routes — HTTP actions at their natural paths).
  The remote provisioner binds `<tailnet-ip>:<host_port>:3210`
  only; 3211 is not published on the tailnet. The proxy enforces
  this carve-out by refusing site routing for remote deployments
  (`ErrSiteUnsupported`). Workarounds: route HTTP actions through
  `/http/<route>` on the cloud port, or put the remote deployment
  on the self-host until a follow-up publishes 3211 over the
  tailnet.
- **HA-per-deployment is single-host only.** `--enable-ha` provisions
  two replicas; both land on whichever host the deployment was
  placed on. `RemoteClient.RecreateReplica` returns a clear
  `not_implemented` error in v1.18. Workaround: place HA
  deployments on the self-host (the original v0.5 path) until
  v1.19 lifts the restriction.
- **The health worker does not actively probe remote
  containers.** Liveness on remote hosts is asserted by the
  agent's heartbeat + `containerScan` (the same observe-only
  channel the Cell Control Plane uses since v1.12); the health
  worker's TCP-probe path runs against the local Docker socket
  only. In practice the agent's 15 s heartbeat catches every
  failure the active probe would catch, just one tick later.
- **There is no built-in deployment-migration between hosts.**
  Moving a deployment from host A to host B is destroy +
  recreate — the on-disk Convex Postgres data on host A doesn't
  follow the container. Operators who need this should snapshot
  via `setup.sh --backup` on the source, restore on the
  destination.
- **macOS / Windows agent: not supported.** `install-agent.sh`
  preflight hard-rejects anything other than Linux with systemd.
  Container-on-Linux is the only validated path.
- **Host SSH key rotation is re-install today.** See
  `docs/SECURITY_REMOTE_HOSTS.md` — the `--rotate-ssh-key`
  lifecycle command referenced in the migration comment is a
  Phase 4 follow-up; in v1.18.0 the documented path is to re-run
  `install-agent.sh` from a fresh **Setup remote install** bundle.

## CLI integration

Existing Cell Control Plane CLI commands accept `--host=<ref>`
where they used to take just `--project`/`--cell`:

```bash
# List hosts known to the control plane
synapse hosts list [--json]

# Mint an adoption token for an existing host row (advanced —
# the dashboard "Setup remote install" button is the normal path
# because it bundles the Headscale pre-auth key)
synapse hosts adoption-token <host-ref>

# Place a new deployment on a specific host
synapse deployment create --type=prod --host=<host-ref>

# Drift / observed-state for a host
synapse drift recompute --host=<host-ref>
synapse drift latest    --host=<host-ref>
synapse observed list   --host=<host-ref>
```

`--host=` takes the host's **name or UUID** — the backend resolves
either (`hosts.name` is globally unique), so `--host=vps-br-1` works
as well as `--host=<uuid>`. `--host=` and `--cell=` / `--project=`
are mutually exclusive on the drift commands
(`cli/lib/commands/_cellplane.js:resolveScope`).

Remove a host from the control plane once it's empty:

```bash
synapse hosts delete <host-id> --yes
```

## Removing a host

A host can be removed once it no longer runs anything. Use the
dashboard's **Remove** button on the host row, or the CLI command
above. Both call `POST /v1/hosts/{id}/delete` (instance-admin only),
which refuses the removal — `409` — unless **all** of these hold:

- It is **not** the control plane's own host (`is_synapse_host`). The
  self-host is never removable → `409 cannot_remove_self_host`.
- It has **zero live deployments** → `409 host_has_deployments` (the
  message lists the blocking names). Delete or move them first:
  `synapse deployment delete <name>` tears the container down and frees
  the host.
- It has **no in-flight provisioning jobs** for its deployments →
  `409 host_has_pending_jobs`. Wait for them to finish.

Once removed, the host's agent rows, adoption tokens, and
desired/observed/drift state cascade away; any cell that used it as its
primary host simply loses that affinity (the cell survives).

### What removal cleans up (remote hosts)

For a **remote** host, deleting it does a best-effort decommission of
the box before dropping the registry row — neither step blocks the
delete, so an unreachable VPS or a Headscale hiccup never strands the
row:

1. **Box-side agent teardown over SSH.** Synapse central dispatches the
   single `synapse-agent-teardown` sentinel through the
   `synapse-deployer-exec` forced-command wrapper, which hands it to a
   root-owned teardown script via one tightly-scoped `NOPASSWD` sudoers
   rule. The script stops/removes the `synapse-agent` unit, the binary,
   `/etc/synapse-agent`, the sshd drop-in, the wrapper, the sudoers
   rule, the SSH keys, and the `synapse-agent`/`synapse-deployer`
   system users — then self-destructs.
2. **Headscale node deregistration.** The host's tailnet node is matched
   by its `tailnet_addr` and deleted, so it drops off the tailnet.

The delete response + the `deleteHost` audit event carry a `cleanup`
summary, e.g. `{"sshTeardown":"ok","headscale":"ok"}`. Statuses:
`ok` · `unsupported` (host installed before the teardown sentinel —
run `install-agent.sh --uninstall` on the box) · `failed` (box
unreachable) · `not_found` · `skipped` (Remote Hosts SSH/Headscale not
configured).

**Hosts adopted before this version** carry the old docker-only wrapper,
so the SSH teardown returns `unsupported`. Finish the wipe on the box
directly — it works on any host and is idempotent:

```bash
sudo bash install-agent.sh --uninstall
# or via curl|bash:
curl -sSf https://raw.githubusercontent.com/Iann29/convex-synapse/main/install-agent.sh \
  | sudo bash -s -- --uninstall
```

**Escape hatch.** `POST /v1/hosts/{ref}/delete?skip_teardown=true` does a
pure registry delete (no SSH, no Headscale) — use it when you plan to
re-adopt the same box. Runbook D in
[`SECURITY_REMOTE_HOSTS.md`](SECURITY_REMOTE_HOSTS.md) is the fuller
decommission/compromise procedure.

## Troubleshooting

### Dashboard says "Remote Hosts not enabled" when I click Setup remote install

```
POST /v1/hosts/<id>/remote_setup → 503 remote_hosts_disabled
```

You haven't enabled Headscale yet — or the synapse-api container
hasn't picked up the new `.env` after enablement. v1.19+ ships a
dashboard surface for this; pre-v1.19 it was install-time only.
Verify and fix:

```bash
docker compose exec synapse-api env | grep -E 'SYNAPSE_HEADSCALE_(URL|SERVER_URL|API_KEY)'
# All three must be non-empty.

# If missing, the v1.19+ paths (pick one):
#   1. Dashboard: Admin → Remote Hosts → Configure
#   2. CLI:
cd <install-dir> && ./setup.sh --configure-headscale
# (idempotent re-run; existing secrets in .env are reused)

# Pre-v1.19 fallback (still works):
cd <install-dir> && ./setup.sh --enable-headscale
```

### Host doesn't flip to `online` after the one-liner

Pull the agent journal on the VPS:

```bash
sudo journalctl -u synapse-agent -n 100 --no-pager
```

Common patterns:

- `dial tcp <control-url>: i/o timeout` — control-plane URL is
  wrong or the VPS can't reach the public internet (firewall).
  Verify with `curl -sS <control-url>/v1/install_agent/config`
  from the VPS.
- `401 unauthorized` — adoption token expired (1 h TTL) or was
  already consumed. Mint a fresh bundle.
- `tailscale up: timeout` — Headscale unreachable or the pre-auth
  key already consumed. `dig headscale.<base-domain>` from the
  VPS; check `docker compose logs headscale --tail=50` on the
  control plane.

### Deployment placed on a remote host fails to provision

Check the provisioning job error in the dashboard (Deployments →
the failed row → **Show details**). Then on the control plane:

```bash
docker compose logs synapse-api --tail=200 | grep -E "host_id|sshprov|RemoteClient"
```

Common patterns:

- `host has no encrypted SSH key` — the host row is stuck in an
  intermediate state (agent registered but the keypair POST
  failed). Re-run `install-agent.sh` on the VPS to repair.
- `ssh: handshake failed: ssh: unable to authenticate` — the
  pubkey in `hosts.ssh_pubkey` doesn't match `authorized_keys` on
  the VPS. Almost always means the agent was re-installed on the
  VPS without minting a new bundle; rotate by minting a fresh
  bundle + re-running.
- `synapse-deployer-exec: subcommand 'X' not permitted` (in the
  remote VPS's auth log: `journalctl _COMM=sshd`) — Synapse central
  tried to dispatch a Docker subcommand the v1.18 wrapper doesn't
  whitelist. Open a bug.

### `headscale.<base-domain>` doesn't resolve

DNS first:

```bash
dig +short headscale.<base-domain>
# should return your VPS's public IP
```

If empty, you don't have a wildcard `*.<base-domain>` record or a
specific A record for `headscale.<base-domain>`. Add one and wait
for propagation (`dig +trace ...` if impatient). Caddy's
on-demand TLS handles the cert on first hit; check
`docker compose logs caddy --tail=50` for the Let's Encrypt
exchange.

### How do I read the audit log for SSH commands sent to a VPS?

On the VPS:

```bash
sudo journalctl _COMM=sshd  -t synapse-deployer-exec --since "1h ago"
```

Every accepted + refused command lands here (the wrapper logs via
`logger -p auth.notice`). The audit trail on Synapse central
covers token mints (`audit.ActionMintRemoteSetup`); per-command
audit lives on the VPS where the command actually executed.

## See also

- [`docs/SECURITY_REMOTE_HOSTS.md`](SECURITY_REMOTE_HOSTS.md) —
  threat model, what we deliberately don't defend against,
  rotation runbooks for every secret in the stack.
- [`docs/HOSTS_AND_AGENTS.md`](HOSTS_AND_AGENTS.md) — the
  observe-only agent + heartbeat / containerScan / effectiveStatus
  (predates Remote Hosts but the agent codepath is the same).
- [`docs/CONVEX_SITE_ORIGIN.md`](CONVEX_SITE_ORIGIN.md) — the
  cloud/site two-port model. Remote deployments don't change it;
  the site URL the API renders for a remote deployment carries the
  same `<name>.site.<base>` shape, currently routed to the tailnet
  IP:3211 the same way the cloud URL is routed to tailnet IP:3210.
- [`docs/DESIRED_OBSERVED_DRIFT.md`](DESIRED_OBSERVED_DRIFT.md) —
  drift treats a remote host with a stale heartbeat as
  `host_unreachable`, not `missing`. Same semantics as a local
  agent.
