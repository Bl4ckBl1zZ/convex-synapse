# Hosts & agents

A **host** is a machine that can run deployments — almost always a VPS. The box running Synapse itself is registered automatically as the **self-host**. Every other host is something you register, then optionally observe with the **agent**.

See [Cell Control Plane](/docs/en/cell-control-plane) for the big picture; this page is the how-to for hosts and the observe-only agent.

## Registering a host

From the dashboard's **Hosts** panel (or `synapse hosts create`), register a host with a name and region. Registration is **metadata only** — it does not touch any machine. You get a host row you can attach cells to and observe.

```bash
synapse hosts create --name vps-br-1 --region br
synapse hosts list
```

Host management (create, drain, adoption tokens, agent revoke/rotate) is **instance-admin** only.

## The agent

The `synapse-agent` is a small, single-binary Go program you run **on the host you want to observe**. It is **observe-only**:

- It reads `docker version` and `docker ps -a` (a read-only container scan). That's all.
- It **never** creates, starts, restarts, or removes containers, volumes, or anything else.
- It reports a **heartbeat** plus the observed containers and a `containerScan` health summary.
- It is gated by `SYNAPSE_AGENT_APPLY` — default `false`, and apply is **not implemented**.

### What it reports (and what it never reports)

| Reported | Never reported |
|---|---|
| Container id, name, image, state, status, ports | Environment variables |
| `synapse.*` labels (managed, deployment_id, project_id, cell_id) | Command / entrypoint |
| Host facts (CPU, RAM, disk), docker availability | Mounts, volumes' contents |
| `containerScan` (attempted / succeeded / complete) | Logs, secrets, admin keys, connection strings |

Labels are filtered to the `synapse.*` namespace on both the agent and the server, so nothing sensitive is ever stored as observed state.

### Install & join

1. Get the binary from the GitHub Release assets (`synapse-agent-linux-amd64` / `-arm64`) and put it on the host, e.g. `/usr/local/bin/synapse-agent`.
2. Mint a **single-use adoption token** for the host (dashboard **Hosts → Adoption token**, or `synapse hosts adoption-token`). It prints a ready-to-paste join command.
3. Join — this registers the agent and writes a `0600` config (the token is never printed again):

```bash
synapse-agent join --control-url https://your-host --token <adoption-token> \
  --config /etc/synapse-agent/config.json
```

4. Run it. `--once` does a single heartbeat (handy for testing); without it, the agent heartbeats on an interval (default every 15s):

```bash
synapse-agent run --config /etc/synapse-agent/config.json          # foreground loop
synapse-agent run --once --config /etc/synapse-agent/config.json    # one heartbeat, exit
```

### Run it as a service

For continuous observation, install the systemd unit (shipped at `installer/templates/synapse-agent.service`):

```ini
[Service]
ExecStart=/usr/local/bin/synapse-agent run --config /etc/synapse-agent/config.json
Restart=always
NoNewPrivileges=true
```

```bash
systemctl enable --now synapse-agent
```

Without a continuously-running agent, a host's observed state goes stale and it reads as `stale` then `offline` — which is honest, not an error (see liveness below).

## Liveness: online / stale / offline

A host's **effectiveStatus** is computed from its last heartbeat:

| Status | Meaning |
|---|---|
| `online` | Heartbeat within the last 60s. |
| `stale` | Heartbeat older than 60s but within 5 minutes. |
| `offline` | No heartbeat for over 5 minutes (or none ever). |
| `draining` | Operator marked it draining — takes precedence over the above. |

**The self-host is special.** The machine running Synapse is alive by definition — it's serving you the dashboard right now — so it always reads `online` regardless of whether an agent is running on it, unless you explicitly drain it.

> **Liveness is not the same as the panel being reachable.** "Online" means *an agent is reporting* (or it's the self-host). A non-self host with no agent will read `offline` even though the box may be perfectly healthy — Synapse just can't see it without the agent.

## Liveness vs. trust (why a stale host never invents drift)

Liveness (above) and **trust** (can we believe the observed containers?) are separate. Drift only trusts a host's observation when it is online **and** the agent's container scan succeeded and was complete. If a host is stale, offline, or its scan failed, drift reports the resources there as `host_unreachable` — never a misleading `missing`. This is why turning the agent off is safe: you lose freshness, not correctness. See [State & drift](/docs/en/state-and-drift).

## Revoking / rotating agent access

If a host is decommissioned or a token leaks, revoke or rotate the agent from the dashboard (Host **Details**) or the CLI:

```bash
synapse hosts agents --host <host-id>     # list agents on a host
# revoke / rotate via the dashboard, or the host_agents endpoints
```

Revoking an agent token makes its next heartbeat `401`; the host then ages to `offline`.
