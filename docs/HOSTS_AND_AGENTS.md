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
  | no heartbeat yet, is the Synapse host | `online` |
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

## Install as a systemd service on a VPS

Build the agent for Linux (from the repo's `synapse/` dir):

```bash
GOOS=linux GOARCH=amd64 go build -ldflags "-X main.Version=$(git describe --tags --always)" \
  -o synapse-agent ./cmd/synapse-agent
```

Copy `synapse-agent` and `installer/templates/synapse-agent.service` to the VPS, then:

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

## TODO (future blocks)

- systemd install helper in `setup.sh` / a `synapse-agent install-service`
  subcommand (today the install is the manual steps above).
- desired-state + reconcile (apply mode) — gated, non-destructive first.
- persist `offline` via a reaper if a stored status is ever needed for queries
  (today effectiveStatus is computed on read).
