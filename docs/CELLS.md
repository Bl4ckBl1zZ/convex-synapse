# Cells

Part of the [Cell Control Plane](CELL_CONTROL_PLANE.md). A **Cell** is an
operational unit *of a project* — a named grouping of one or more Convex
deployments plus the host they're placed on and the contracts they expose.

A Cell is **not** a customer and **not** a deployment. Customers (in the
Amagejumpy model) are workspaces inside the Core; a Cell is a runtime/operational
unit. See [AMAGEJUMPY_CELL_ARCHITECTURE.md](AMAGEJUMPY_CELL_ARCHITECTURE.md).

## Kinds

| Kind | Purpose | Status today |
|---|---|---|
| `core` | The project's primary backend(s) — the always-on Convex deployment. | **Used** (backfill creates these). |
| `runtime` | Future internal execution Cell for Amagejumpy workloads. | Modelled, not functional. |
| `integration` | Future Cell that talks to third parties. | Modelled, not functional. |
| `preview` | Ephemeral preview environments. | Modelled. |
| `enterprise-app` | Dedicated Cell for one large customer (the exception). | Modelled. |

## Environments

`dev` · `staging` · `prod` · `preview` — informational + naming. Synapse
self-hosted is single-region, so the region code is descriptive.

## Isolation tiers

`shared` · `premium` · `dedicated` · `internal` — describe how isolated a Cell's
resources are. Informational today; reserved to drive future placement policy.

## Status

`active` · `inactive` · `draining` · `migrating` · `maintenance`. `draining` is
operator intent (winding down); note that for **drift**, draining is treated as
*lifecycle*, not *liveness* — a draining-but-online host still has its drift
diagnosed (see [DESIRED_OBSERVED_DRIFT.md](DESIRED_OBSERVED_DRIFT.md)).

## CellResource

A `CellResource` ties a resource to a Cell. Today the only resource type is a
Convex **deployment** (`resource_type=deployment`). Attaching a deployment to a
Cell creates the CellResource and a DeploymentPlacement.

## DeploymentPlacement

A placement is the **intent** that a deployment runs on a specific Host inside a
Cell. It carries:

- `host_id` — where it should run (nullable until a host is attached);
- `desired_status` — `running` | `stopped` | `absent`;
- `observed_status` — `running` | `stopped` | `failed` | `unknown`
  (a rollup convenience; the authoritative observation lives in ObservedState).

Placements are the **source of DesiredState** — `syncDesiredFromPlacements`
turns each placement-with-a-host into a `convex_deployment` desired state.

## Key rule: one Cell per deployment

> A Convex deployment belongs to **at most one Cell**.

`attach_deployment` refuses (409 `deployment_already_attached`) if the
deployment already lives in another Cell. This keeps "where does X run?"
unambiguous and is what makes placement + drift well-defined.

## Backfill of existing deployments

On startup, an idempotent backfill (`internal/cells/backfill.go`, advisory-lock
guarded, gated by `SYNAPSE_ENABLE_CELLS=true`) turns existing deployments into
**core** Cells + placements so the control plane has a baseline without manual
setup. Cell names use the region (`SYNAPSE_REGION`) for determinism, e.g.
`core-prod-br-1`.

## Examples (Amagejumpy mapping)

```
team amage.ia → project amagejumpy
  Cell core-dev-br-1   (kind=core, env=dev)   → deployment brave-dolphin-1060
  Cell core-prod-br-1  (kind=core, env=prod)  → deployment lush-heron-4656
  Cell runtime-prod-br-1 (kind=runtime)       → future runtime (not functional)
```

## API

See [API_CELL_CONTROL_PLANE.md](API_CELL_CONTROL_PLANE.md#cells). In short:

```
GET  /v1/projects/{id}/cells            list
POST /v1/projects/{id}/cells            create
GET  /v1/cells/{id}                     get
PATCH /v1/cells/{id}                    update (name/desc/status/region/tier)
POST /v1/cells/{id}/drain               set status=draining
POST /v1/cells/{id}/attach_deployment   attach a deployment (creates placement)
POST /v1/cells/{id}/attach_host         set the cell's primary host
GET  /v1/cells/{id}/resources           list CellResources + placements
```

RBAC: project-scoped — reuses the project's membership (`effectiveProjectRole`).
Reads are any member; writes gate on project admin/member per the existing
project RBAC.
