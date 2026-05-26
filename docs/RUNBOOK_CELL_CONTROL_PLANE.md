# Cell Control Plane — Runbook

Operational flows for the [Cell Control Plane](CELL_CONTROL_PLANE.md). Endpoints
are in [API_CELL_CONTROL_PLANE.md](API_CELL_CONTROL_PLANE.md). Everything here is
observe + plan; nothing applies changes to a host.

Agent loop, for reference:

```
synapse-agent
  inspect   → print local host facts (JSON), no network
  join      → exchange a one-time adoption token for a long-lived agent token
  run       → loop every ~15s:
                collect host facts + `docker ps -a` (synapse.managed)
                POST /v1/agents/heartbeat   (observed + containerScan)
                GET  /v1/agents/desired_state  (applyAllowed=false — observe only)
```

## CLI quick reference (`synapse`, Bloco 5)

The flows below show dashboard + curl; the `synapse` CLI (npm `@iann29/synapse`)
wraps the same HTTP endpoints — diagnose + plan only, **no apply** (there is no
`apply` command and `reconcile --apply` errors). `synapse login <url>` first.
Add `--json` to any command for machine output.

```
# Hosts + agents (flow A / E)
synapse hosts list | show <id> | create --name <n> [--provider --region --label k=v]
synapse hosts adoption-token <id>        # token + join command, shown once
synapse hosts drain <id> | hosts agents <id>
synapse agents revoke <id> | agents rotate-token <id>

# Cells (flow B)
synapse cells list --project <id> | cells create --project <id> --name <n> --kind <k> --env <e>
synapse cells attach-deployment <cell> <deployment> | cells attach-host <cell> <host>
synapse cells resources <cell> | cells drain <cell>

# Cell links + service tokens (flow C)
synapse cell-links list --project <id>
synapse cell-links create --project <id> --from <cell> --to <cell> --protocol outbox --auth service_token \
  --allow-command <cmd> --allow-event <evt>
synapse cell-links disable <link-id>
synapse service-tokens create <link-id> --scope discovery:read    # token shown once
synapse service-tokens list <link-id> | service-tokens revoke <token-id>

# Topology (between B and C)
synapse topology show --project <id>

# Desired / observed / drift / dry-run (flow D)
synapse desired sync --project <id> | desired list (--project <id> | --host <id>)
synapse observed list --host <id>
synapse drift recompute (--project|--cell|--host <id>) | drift latest (--project|--cell|--host <id>)
synapse reconcile dry-run (--project|--cell|--host <id>)   # applyAllowed=false; no apply

# Operation runs
synapse operations list --project <id> | operations show <run-id>
```

## A. Create a Host and connect an Agent

1. **Create the host** (instance-admin): dashboard **Hosts → New host**, or
   `POST /v1/hosts {"name":"vps-br-1","region":"br"}`.
2. **Mint an adoption token:** **Hosts → Adoption token** (or
   `POST /v1/hosts/{id}/adoption_token`). Copy the join command — the token is
   shown **once**.
3. **On the VPS**, install + join (see
   [HOSTS_AND_AGENTS.md](HOSTS_AND_AGENTS.md#install-as-a-systemd-service-on-a-vps)):
   ```bash
   sudo install -m 0755 synapse-agent /usr/local/bin/synapse-agent
   sudo synapse-agent join --control-url https://<synapse> --token syn_adopt_...
   sudo cp synapse-agent.service /etc/systemd/system/ && sudo systemctl enable --now synapse-agent
   ```
4. **Verify heartbeat:** the host flips to `online` within ~15s, showing
   agentVersion / dockerVersion / cpu-mem-disk and a live `lastHeartbeatAt`.

## B. Create a Cell

1. **Create** a `core` (or other kind) cell: **Cells → New cell**, or
   `POST /v1/projects/{id}/cells {"name":"core-prod-br-1","kind":"core","environment":"prod","region":"br"}`.
2. **Attach a host:** `POST /v1/cells/{id}/attach_host {"hostId":"<id-or-name>"}`.
3. **Attach a deployment:** `POST /v1/cells/{id}/attach_deployment {"deploymentName":"lush-heron-4656"}`
   → creates the CellResource + a DeploymentPlacement (deployment → host).
   (A deployment can only live in one cell; 409 otherwise.)

## C. Create a CellLink (contract)

1. **Create** `core → runtime`:
   `POST /v1/projects/{id}/cell_links {"sourceCellId":"<core>","targetCellId":"<runtime>","protocol":"outbox","authMode":"service_token","allowedCommands":["run"],"allowedEvents":["done"]}`.
2. **Mint a service token:** `POST /v1/cell_links/{id}/service_tokens {"name":"core→runtime","scopes":["discovery:read"]}`
   → plaintext `syn_svc_…` returned **once**.
3. **Test discovery** (server-to-server):
   `GET /v1/internal/cell_links/discovery` with `Authorization: Bearer syn_svc_…`
   → returns the single link + resolved `endpoint` / `endpointSource`.

## D. Desired / Observed / Drift

1. **Sync desired from placements:** dashboard **State & Drift → Sync desired
   from placements**, or `POST /v1/projects/{id}/desired_state/sync_from_placements`.
   Returns `{created, updated, …}`. **No host change.**
2. **Check observed** (per host, instance-admin):
   `GET /v1/hosts/{id}/observed_state` — host_facts + synapse-managed containers.
3. **Recompute drift:** **Recompute drift**, or
   `POST /v1/projects/{id}/drift/recompute` → DriftReport + items.
4. **Dry-run reconcile:** **Dry-run reconcile**, or
   `POST /v1/projects/{id}/reconcile/dry_run` → an OperationRun with **planned**
   steps (`applyAllowed:false`, `willApply:false`). **Nothing is sent to the
   agent.**
5. **Read the OperationRun:** **Operations → View details**, or
   `GET /v1/operation_runs/{id}` → steps + plan/result.

## E. Common diagnostics

| Symptom | Likely cause | Read it as |
|---|---|---|
| Host shows `offline` / `stale` | Agent not heartbeating (service down, network) | Restart `synapse-agent`; check `systemctl status`. Drift shows `host_unreachable`, **not** missing. |
| Heartbeats 401 | Agent token revoked | Rotate token (`/rotate_token`) and re-join, or re-`join` with a new adoption token. |
| Drift item `host_unreachable` with "scan failed" | `docker ps -a` failed / docker daemon down (`containerScan.succeeded=false`) | Fix docker on the host; observed isn't trusted, so nothing was pruned. |
| Drift item `drifted` / `restart` | Desired `running`, container `exited` | The plan *would* restart it. Investigate why it exited. |
| Drift item `missing` / `create` | Desired `running`, no container, host **trusted** | The container really isn't there; plan would create it. |
| Topology shows "endpoint unresolved" | Target cell has no active custom domain and no deployment URL | Add an `api` custom domain to the target deployment, or expect `endpoint:null`. |
| Cell warning "no primary deployment" | Cell created but no deployment attached | Attach a deployment. |
| CellLink warning "no token" | Link `authMode=service_token` but no active token minted | Mint a service token. |
| Drift item `remove` (dangerous) | Desired `absent` but a container exists | **Dry-run only — removal is not implemented.** Decide manually. |
| Drift item `unmanaged` | A `synapse.managed` container with no active desired | Investigate (v0 never auto-recommends remove). Re-sync desired if it should be managed. |
| Drift item `orphaned` | Active desired points at a deleted deployment | Re-run sync desired — it supersedes the orphan. |

## What you cannot do here (by design)

There is no "Apply", "Fix", or "Restart now". The control plane plans; a human
acts out-of-band (or a future, explicitly-reviewed apply mode will). See
[SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md).
