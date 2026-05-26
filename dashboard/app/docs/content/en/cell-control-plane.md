# Cell Control Plane

The Cell Control Plane turns Synapse from a per-deployment panel into a map of your whole fleet: which **machines** you run on, how deployments are **grouped**, what you **want** running, what is **actually** running, and where the two **drift** apart.

Its golden rule is **observe → compare → plan, never apply**. The Cell Control Plane diagnoses and proposes; it never changes a host on its own. The agent that watches your machines is read-only, there is no "Apply" button anywhere, reconcile is dry-run only, and any request that asks the server to apply is rejected with a `400`.

> **Why "never apply"?** Acting on infrastructure automatically is where control planes get dangerous. Synapse deliberately stops at the plan: it tells you exactly what diverged and what it *would* do, and leaves the doing to you.

## Vocabulary

| Term | What it is |
|---|---|
| **Host** | A machine (a VPS) that can run deployments. The box running Synapse itself is the **self-host**. |
| **Agent** | A small **observe-only** program you run on a host. It reports what containers exist (read-only `docker ps -a`) plus a heartbeat. It never creates, restarts, or removes anything. |
| **Cell** | An operational unit of a project that groups deployments. Kinds: `core`, `runtime`, `integration`, `preview`, `enterprise-app`. A cell is **not** a customer and **not** a deployment. |
| **Placement** | The record of *where* a deployment runs — which host, which cell, and its desired status. |
| **Cell Link** | A service-to-service **contract** between two cells (who may call whom, which commands/events are allowed). It registers the relationship; it does not carry traffic. |
| **Desired state** | What the control plane *wants*: this deployment should be running, on this host. |
| **Observed state** | What the agent *saw*: this container exists, in this state, with these labels. |
| **Drift** | The gap between desired and observed, classified (`in_sync`, `missing`, `drifted`, …). |

## The model

```
Project
  └─ Cell (core-prod-…)        ← operational unit (groups deployments)
       └─ Placement            ← deployment X runs on host Y, desired: running
            └─ Deployment      ← a real Convex backend container

Host (a VPS)                   ← observed by an agent (read-only)
```

Synapse manages **infrastructure** — placement, routes, health, drift. It does **not** manage your application's own end-user auth, RBAC, or runtime. A Cell is a Synapse concept for organizing deployments, not a tenant of your app.

## What you can do

- **Register hosts** and observe them with the agent → see liveness and what is actually running on each box.
- **Group deployments into cells** and view the **topology** (Host → Cell → Deployment), with warnings for anything unhealthy or unplaced.
- **Sync desired state** from your placements, **recompute drift**, and run a **dry-run reconcile** to see the plan — from the dashboard or the `synapse` CLI.
- Register service-to-service contracts with **cell links** + **service tokens**.

## Safety, in one place

- The **agent is observe-only**: read-only `docker version` / `docker ps -a`, nothing else. It is gated by `SYNAPSE_AGENT_APPLY`, which defaults to `false` and is not implemented.
- Every drift plan carries `applyAllowed=false`; the dashboard has **no Apply button**; the CLI has **no apply command** (`synapse reconcile dry-run --apply` errors).
- **No secrets** ever travel through labels, desired state, or observed state — no env vars, admin keys, connection strings, or tokens.

## Read on

- [Hosts & agents](/docs/en/hosts-and-agents) — register a host, run the observe-only agent.
- [Cells, links & topology](/docs/en/cells-links-topology) — group deployments, wire contracts, read the map.
- [State & drift](/docs/en/state-and-drift) — desired vs observed and the dry-run planner.
- The `synapse` [CLI reference](/docs/en/cli) covers the `hosts` / `cells` / `cell-links` / `topology` / `drift` / `reconcile` / `operations` commands.
