# Desired State, Observed State & Drift

The heart of the [Cell Control Plane](CELL_CONTROL_PLANE.md). Synapse records
what it **wants** (DesiredState), what the agent **sees** (ObservedState),
**compares** them (Drift), and **plans** a fix (dry-run) — and applies
**nothing**.

```
DeploymentPlacement ── syncDesiredFromPlacements ──> DesiredState
Agent heartbeat ───────────────────────────────────> ObservedState
DesiredState + ObservedState ── Drift Engine ──────> DriftReport + DriftItems
DriftReport ── Dry-run Planner ────────────────────> OperationRun (reconcile_dry_run)
OperationRun ──────────────────────────────────────> OperationSteps (planned / no_op / skipped)
```

## DesiredState — the intent

- **Origin:** `deployment_placements`. `syncDesiredFromPlacements` (project
  admin) turns each placement *with a host* into one active desired state of
  type `convex_deployment`.
- **`resourceKey`:** `convex_deployment:<deploymentId>`.
- **`desiredHash`:** a deterministic SHA-256 of the canonical desired JSON. The
  sync is **idempotent** — unchanged placements change nothing; a placement that
  moved host **supersedes** the old active desired and creates a fresh one
  (versioned). At most one **active** desired per `(host, type, key)`.
- **No secrets.** The desired JSON carries only placement intent +
  `synapse.*` labels: `deploymentId`, `cellId`, `hostId`, `desiredStatus`
  (`running`/`stopped`/`absent`), and the `synapse.managed` / `synapse.project_id`
  / `synapse.cell_id` / `synapse.deployment_id` labels. No env, admin keys,
  instance secrets, DB URLs, or tokens.

## ObservedState — the reality

- **Origin:** the agent's heartbeat (best-effort, recorded after the liveness
  commit so a bad payload never blocks liveness).
- **`host_facts`:** hostname, os, arch, dockerAvailable, dockerVersion,
  cpu/mem/disk, and the `containerScan` outcome.
- **`docker_container`:** one row per `synapse.managed=true` container the agent
  reported (`docker ps -a`, so running **and** exited). Safe metadata only:
  id, name, image, state, status, `synapse.*` labels, ports, createdAt.
- **Never** env vars, full command, logs, mounts, or tokens. Labels are
  re-filtered to `synapse.*` server-side as defense-in-depth.
- **Pruning safety:** vanished containers are pruned **only when the scan
  succeeded and was complete** — see
  [HOSTS_AND_AGENTS.md](HOSTS_AND_AGENTS.md#pruning-safety).

## Host trust — can we believe the observation?

Drift only treats an absence as `missing` when the host's observation is
**trustworthy**. A host is trusted when **all** hold:

- it has a heartbeat (`lastHeartbeatAt` set — even the synapse self-host without
  an agent is *not* trusted for container observation);
- **liveness** is `online` (heartbeat fresh — this is the heartbeat-only health,
  ignoring lifecycle);
- `host_facts.dockerAvailable` is not explicitly `false`;
- the container scan is not degraded (`succeeded && complete`).

Otherwise the desired resources on that host are reported as
**`host_unreachable`** (severity `critical` if offline, else `warning`),
recommended action `investigate` — **never `missing`**. This prevents a docker
outage, a stale agent, or a backfilled host with no agent from looking like
"everything vanished, create it all".

### Liveness vs lifecycle (draining)

Liveness (`online`/`stale`/`offline`) comes from the heartbeat. Lifecycle
(`draining`) is operator intent. They are **separate**: a host that is
`draining` but still `online` with a good scan **is trusted**, so its real drift
(e.g. an exited container → `restart`) is **diagnosed, not masked**. The item's
diff is annotated `lifecycle: "draining"` for visibility. (`effectiveStatus`,
used by the Hosts/topology display, still shows `draining`; the liveness/lifecycle
split lives only in the drift trust path.)

## Drift statuses

Correlation is by **label + host**: a desired `convex_deployment:<id>` matches an
observed `docker_container` where `labels["synapse.deployment_id"] == <id>` on
the same host (not by container name).

| `driftStatus` | When | Severity | `recommendedAction` |
|---|---|---|---|
| `in_sync` | desired + matching observed agree (e.g. desired running, observed running) | info | none |
| `missing` | desired `running`, **no** observed, host **trusted** | critical | create |
| `drifted` | both exist but diverge: observed not running (→restart), running-but-desired-stopped (→stop), desired-absent-but-exists (→remove), or label mismatch (→investigate) | critical / warning | restart / stop / remove / investigate |
| `unmanaged` | observed `synapse.managed` container with **no** active desired, on a **trusted** host | warning | investigate |
| `orphaned` | active desired points at a deployment that no longer exists | warning | investigate |
| `host_unreachable` | host has no heartbeat / stale / offline / docker unavailable / scan degraded | warning or critical | investigate |
| `ignored` | observed resource that shouldn't be considered (e.g. a non-managed container that slipped through) | info | none |

### recommendedAction vocabulary

`none` · `create` · `update` · `restart` · `stop` · `remove` · `investigate`.
These are **recommendations only**. `remove` is flagged **dangerous**; the
dashboard renders "Dry-run only. Removal is not implemented."

### How to read each status

- **in_sync** — nothing to do.
- **missing** — the desired backend isn't running on a host we *can* see. The
  plan would *create* it. (In production a stopped container the agent reports
  as `exited` shows as `drifted/restart`; a truly-gone one shows as `missing`.)
- **drifted** — it exists but isn't in the desired shape; the action says how
  the plan would converge it.
- **unmanaged** — a synapse container with no matching intent. Investigate
  before doing anything (v0 never recommends `remove` here).
- **orphaned** — the control-plane row outlived its deployment. Deleting a
  deployment now cleans up its desired state, placement, cell-resource, and the
  cell's `primary_deployment_id` automatically, so this is rare. It shows when a
  desired row is still active for a soft-deleted deployment: `status='deleted'`
  counts as "no longer exists" → `orphaned`, never a misleading `missing →
  create`.
- **host_unreachable** — don't trust the observation; check the host / agent /
  docker scan. **Not** a "create".
- **ignored** — noise; safe to skip.

## Dry-run reconcile

`POST .../reconcile/dry_run` runs a `reconcile_dry_run`
[OperationRun](OPERATION_RUNS.md): it recomputes drift and maps each item to a
**planned** OperationStep — and executes nothing.

| Drift item | Step action | Step status |
|---|---|---|
| in_sync | no_op | no_op |
| missing | create | planned |
| drifted (restart/stop/remove) | restart / stop / remove | planned |
| unmanaged / orphaned | investigate | planned |
| host_unreachable | investigate | **skipped** (can't plan against an untrusted host) |
| ignored | no_op | skipped |

The persisted `planJson` always carries **`applyAllowed: false`**, and every
step carries **`willApply: false`**. `remove` steps are marked `dangerous` with
"dry-run only — removal not implemented". Nothing is sent to the agent; no
Docker, proxy, desired_state, or observed_state is touched.

> An `apply: true` request body is rejected `400 apply_not_supported`. See
> [SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md).

## API

See [API_CELL_CONTROL_PLANE.md](API_CELL_CONTROL_PLANE.md#state--drift). Scopes:
host / cell / project; reads are member-visible, recompute/dry_run are
project-admin (cell/project) or instance-admin (host).
