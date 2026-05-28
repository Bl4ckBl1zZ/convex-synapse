# Hosts & the synapse-agent

Part of the **Cell Control Plane** (feat/cell-control-plane). A **Host** is a
machine (VPS) the control plane knows about; the **synapse-agent** is a small
Go binary that runs on a Host and reports it as live.

The agent is **observe-only**: it never creates, restarts, or removes
containers or volumes, never touches Caddy/proxy, and never modifies any
container (labelled or not). The only Docker it runs are read-only
`docker version` / `docker ps -a` probes. An apply/reconcile mode is a future
block; the `docker.allow*` flags in the config + `SYNAPSE_AGENT_APPLY` (default
`false`) are reserved for it and are unused today.

### What the agent NEVER does

- create / start / restart / stop / remove a container
- create / remove / mount a volume
- touch Caddy or the proxy
- read container env vars, the full command, logs, or mounts
- report non-`synapse.*` labels

It only ever reports **safe metadata** for `synapse.managed=true` containers:
short id, name, image, state, status, `synapse.*` labels, ports summary,
createdAt. See [SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md).

## Container observation (`docker ps -a` + containerScan)

Each heartbeat the agent lists synapse-managed containers — **including
stopped/exited ones** (`docker ps -a`), so the control plane can tell "stopped,
needs restart" apart from "gone, needs create":

```
docker ps -a --filter label=synapse.managed=true --format '{{json .}}'
```

The heartbeat carries a `containerScan` object describing whether the listing
actually worked, so the server can prune safely:

| Situation | `containerScan` |
|---|---|
| docker up, `ps -a` succeeded | `{attempted:true, succeeded:true,  complete:true,  error:null}` |
| docker absent | `{attempted:true, succeeded:false, complete:false, error:"docker_unavailable"}` |
| `docker ps -a` errored / timed out | `{attempted:true, succeeded:false, complete:false, error:"docker_scan_failed"}` |

### Pruning safety

The server upserts the reported containers into `observed_states` and then
**prunes** rows for containers no longer present — but **only when
`containerScan.succeeded && containerScan.complete`**. A failed or
docker-unavailable scan reports an empty list, and pruning then would
manufacture a false "missing" during a transient outage. `host_facts` is never
pruned. (Legacy agents without `containerScan` fall back to the old
`dockerAvailable` gate.)

This is why Drift treats a degraded scan as `host_unreachable`, never `missing`
— see [DESIRED_OBSERVED_DRIFT.md](DESIRED_OBSERVED_DRIFT.md).

## Host liveness (effectiveStatus)

The API returns two fields on every Host:

- `status` — the last stored signal (e.g. the last heartbeat said `online`).
- `effectiveStatus` — the **honest, computed** liveness, derived at read time
  from `lastHeartbeatAt` and two thresholds:

  | Condition | effectiveStatus |
  |---|---|
  | `status == draining` (operator intent) | `draining` |
  | **is the Synapse self-host** (`is_synapse_host`) | `online` — always, while the control plane is up (it runs on this box), independent of any agent heartbeat |
  | no heartbeat yet, any other host | stored `status` (e.g. `unknown`) |
  | last heartbeat ≤ `STALE_AFTER` | `online` |
  | `STALE_AFTER` < last heartbeat ≤ `OFFLINE_AFTER` | `stale` |
  | last heartbeat > `OFFLINE_AFTER` | `offline` |

Thresholds (env on the **control plane**, not the agent):

```
SYNAPSE_AGENT_STALE_AFTER_SECONDS=60     # default
SYNAPSE_AGENT_OFFLINE_AFTER_SECONDS=300  # default
```

`effectiveStatus` is computed on read (no background reaper required), so a host
that stops heartbeating drifts `online → stale → offline` automatically the
next time the dashboard or API reads it. The dashboard displays
`effectiveStatus`; `lastHeartbeatAt` remains the underlying fact.

## Agent commands

```bash
synapse-agent inspect                         # print local host facts as JSON
synapse-agent join --control-url <url> --token <adoption-token> [--config <path>]
synapse-agent run [--config <path>] [--once]  # heartbeat loop (or one shot)
synapse-agent config-path                     # print the default config path
synapse-agent version
```

`join` exchanges a one-time adoption token (minted in the dashboard under
**Hosts → Adoption token**) for a long-lived agent token and writes a config
file (mode `0600` — it holds the token). The token is shown **only once** and
is never printed by the agent.

Default config path: `/etc/synapse-agent/config.json` when running as root,
else `~/.config/synapse-agent/config.json`.

## Install on a VPS (v1.18+)

The canonical install is the dashboard-generated one-liner via
[`install-agent.sh`](../install-agent.sh) — see
[`docs/REMOTE_HOSTS.md` §Set it up](REMOTE_HOSTS.md#set-it-up) for the
full operator flow.

```bash
# On the Synapse control plane (one-time, v1.19+):
#   Open Admin → Remote Hosts in the dashboard and click Configure,
#   or shell-equivalent for automation:
setup.sh --configure-headscale
# Pre-v1.19 the install-time opt-in was `setup.sh --enable-headscale`;
# it still works for fresh installs.
# In the dashboard → Hosts → New host → "Setup remote install",
# copy the one-liner, SSH into the new VPS, paste:
curl -fsSL https://synapse.example.com/install-agent.sh \
  | sudo bash -s -- \
    --control-url=https://synapse.example.com \
    --headscale-auth=tskey-auth-... \
    --adoption-token=syn_adopt_...
```

The one-liner installs Tailscale + joins the Headscale tailnet +
downloads the `synapse-agent` binary from GitHub Releases + creates
the `synapse-deployer` SSH user + configures the hardened systemd
unit + registers with Synapse central. The host flips to `online` in
the dashboard within ~60 s.

The agent itself is the same observe-only binary documented above;
the v1.18+ install path adds the Headscale + per-host SSH plumbing
that turns the VPS into a Remote Host the control plane can
provision deployments onto. See [REMOTE_HOSTS.md](REMOTE_HOSTS.md)
for the architecture and [SECURITY_REMOTE_HOSTS.md](SECURITY_REMOTE_HOSTS.md)
for the threat model + rotation playbooks.

## Manual install (advanced — operator forks, observer-only)

For operators who forked the agent, want a build-from-source path,
or want to adopt a host *without* the v1.18+ Remote Hosts SSH
channel (observer-only, no remote provisioning).

Build the agent for Linux (from the repo's `synapse/` dir):

```bash
GOOS=linux GOARCH=amd64 go build -ldflags "-X main.Version=$(git describe --tags --always)" \
  -o synapse-agent ./cmd/synapse-agent
```

Copy `synapse-agent` and `installer-agent/templates/synapse-agent.service` to the VPS, then:

```bash
sudo install -m 0755 synapse-agent /usr/local/bin/synapse-agent
sudo mkdir -p /etc/synapse-agent /var/lib/synapse-agent

# Mint an adoption token in the dashboard (Hosts → Adoption token), then:
sudo synapse-agent join --control-url https://synapsepanel.com --token syn_...

sudo cp synapse-agent.service /etc/systemd/system/synapse-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now synapse-agent
sudo systemctl status synapse-agent
```

The Host should flip to `online` in the dashboard within one heartbeat
interval (~15s), showing agentVersion, dockerVersion, CPU/RAM/disk, and a live
`lastHeartbeatAt`.

A host adopted via this manual path stays `is_remote=false` in the
database: the worker provisions its deployments through the local
Docker socket, which only works if the control plane runs on that
host. To turn a manually-adopted box into a Remote Host the control
plane can SSH into, re-adopt it via the `install-agent.sh` flow
above (which re-uses the same row by `tailnet_addr` uniqueness).

## Agent lifecycle (instance-admin)

- **List a host's agents:** `GET /v1/hosts/{id}/agents` — agent id, status,
  connection mode, last seen, and a no-secrets observed summary.
- **Revoke an agent:** `POST /v1/host_agents/{id}/revoke` — the agent's token
  stops authenticating immediately (heartbeats 401). History + the host row are
  kept; the agent's local config is untouched (rotate or re-join to recover).
- **Rotate an agent's token:** `POST /v1/host_agents/{id}/rotate_token` — mints
  a new token (shown once), invalidates the old one, and un-revokes the agent.
  Re-run `synapse-agent join` (or update the config) with the new token.

## Security notes

- Adoption tokens and agent tokens are stored only as SHA-256 hashes; plaintext
  is shown once at creation. Tokens never appear in logs.
- Agent tokens live in `host_agents`, never `access_tokens` — an agent token
  cannot authenticate as a user.
- Heartbeat takes the host id from the **token**, never the request body, so an
  agent can only update its own host.
- Adoption tokens are single-use and expire; used/expired/revoked tokens return
  a clear error code without leaking the hash.

