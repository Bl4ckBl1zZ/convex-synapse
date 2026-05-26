# Cells, links & topology

A **cell** is an operational unit of a project that groups deployments. Cells, the **placements** that put deployments in them, the **cell links** that wire contracts between them, and the **topology** view that draws the whole thing are the organizing layer of the [Cell Control Plane](/docs/en/cell-control-plane).

## Cells

A cell has a **kind** that describes its role:

| Kind | Typical use |
|---|---|
| `core` | The primary cell of a project (e.g. `core-prod-…`, `core-dev-…`). |
| `runtime` | A runtime/workload cell. |
| `integration` | Integration-facing services. |
| `preview` | Ephemeral / preview environments. |
| `enterprise-app` | A dedicated cell for an enterprise customer's app. |

When you enable cells, Synapse runs an **idempotent backfill** that creates a `core` cell for each existing deployment, so an upgrade doesn't leave your fleet uncategorized. From there you create and arrange cells yourself.

```bash
synapse cells list --project <project-id>
synapse cells create --project <project-id> --name core-prod-br-1 --kind core
```

### Placements: putting a deployment in a cell

A **placement** records that a deployment runs in a cell, on a host, with a desired status. Attaching a deployment to a cell creates the placement:

```bash
synapse cells attach-deployment --cell <cell-id> --deployment <name>
synapse cells attach-host       --cell <cell-id> --host <host-id-or-name>
```

`drain` marks a cell as draining (operator intent) — it's a signal, not an action; nothing is moved or stopped.

### Deleting a deployment cleans up its cell

When you delete a deployment, Synapse clears its Cell Control Plane footprint — the desired state is superseded, the placement and cell-resource link are dropped, and the cell's primary-deployment pointer is cleared — so the deleted deployment stops showing up under its cell. The **cell itself is left in place** (an empty cell is harmless and can be reused). To remove an empty cell, drain it / remove it explicitly.

## Cell links & service tokens

A **cell link** is a **contract** between two cells in the same project: it registers that *source* cell may talk to *target* cell over a protocol, with an allow-list of commands/events. It is metadata — **it does not transport any payload**.

```bash
synapse cell-links create --project <id> --source <cell> --target <cell> --protocol <p>
synapse cell-links list   --project <id>
```

Constraints that keep links honest:

- **Intra-project only** — you can't link cells across projects, and a cell can't link to itself.
- **One active link** per `(source, target, protocol)`.
- The link can resolve an **endpoint** from existing routing (an active `api` custom domain → the deployment URL → `null` if neither). No new routing is created.

### Service tokens

A link whose `authMode` is `service_token` can mint **service tokens** (prefix `syn_svc_`) — credentials a service presents to **discover** its own link:

- Default scope `discovery:read`; discovery requires it.
- The plaintext token is shown **once** at creation; only a hash is stored. Revoke at any time.
- The public discovery endpoint returns **only the token's own link** (not sibling links), and rejects revoked or expired tokens.

Links with `authMode` `mtls` or `none` don't mint tokens.

## Topology

The **topology** view assembles the live map of a project — Host → Cell → Deployment — from real placements, routes, and host status:

```bash
synapse topology show --project <project-id>
```

It returns hosts (with liveness), cells (with their deployments + resolved URLs), link edges, unplaced cells, unassigned deployments, and a list of **read-only warnings** — e.g.:

- a cell with no primary deployment,
- a deployment not assigned to any cell,
- a host that is offline/stale but still has active cells,
- a link with no resolvable endpoint or no token.

Warnings are diagnostics: they tell you what to look at, they never change anything. When no cells exist yet, topology falls back to a synthetic single-host view so the page still renders.
