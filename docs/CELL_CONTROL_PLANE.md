# Cell Control Plane

Synapse started as a panel for self-hosted Convex deployments (teams, projects,
multi-deployment, audit, CLI auth). The **Cell Control Plane** (branch
`feat/cell-control-plane`) adds a layer on top: it models *where* deployments
run, *what* the operator wants running, *what is actually running*, and the
*difference* between the two — and it **plans** corrective actions without ever
applying them.

This document is the entry point. For depth, see the per-topic docs linked at
the bottom.

> **Golden rule of this whole layer:** Synapse can **diagnose** and **plan**.
> Synapse does **not** apply plans. The agent is **observe-only**. There is no
> Apply button and no Docker mutation anywhere in this layer. See
> [SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md).

## Why it exists

A single VPS running a few Convex backends is easy. The moment you have
multiple machines, multiple environments (dev/staging/prod), service-to-service
contracts between backends, and a need to answer "is reality what I asked for?",
you need a control plane that:

- knows the **machines** (Hosts) and whether they're alive (Agents + liveness);
- groups deployments into **operational units** (Cells) per project/environment;
- records the **intent** (DesiredState) and the **observed reality**
  (ObservedState) and computes **Drift**;
- produces an auditable **plan** (dry-run) of what *would* fix the drift — so a
  human (or, much later, a gated apply mode) can act with full context.

It is deliberately **less** than Kubernetes: no scheduler, no distributed
database, no job broker, no service mesh. It observes, compares, and plans.

## Vocabulary

| Term | What it is |
|---|---|
| **Host** | A machine (VPS) the control plane knows about. Instance-level. |
| **Agent** (`synapse-agent`) | An **observe-only** Go process on a Host that reports liveness + observed containers. Never mutates anything. |
| **HostAdoptionToken** | A single-use token that lets an agent `join` a Host. |
| **Deployment** | An existing Convex backend resource (the thing Synapse already managed). |
| **Cell** | An operational unit *of a project* (kinds: core / runtime / integration / preview / enterprise-app). A Cell is **not** a customer and **not** a deployment. |
| **CellResource** | A resource (today: a deployment) associated with a Cell. |
| **DeploymentPlacement** | The intent that a deployment runs on a given Host inside a Cell (+ desired/observed status). |
| **CellLink** | A service-to-service **contract** between two Cells in the same project (who may talk to whom, with what commands/events). |
| **ServiceToken** | A link-scoped credential for a CellLink. Hash-at-rest, shown once. |
| **DesiredState** | Declared operational intent, derived from placements. No secrets. |
| **ObservedState** | Reality reported by the agent (host facts + synapse-managed containers). No env/command/logs/tokens. |
| **Drift** | The classified difference between DesiredState and ObservedState. |
| **Dry-run Planner** | Turns drift into a plan of *recommended* steps. Never executes. |
| **OperationRun / OperationStep** | The auditable trail of a sync / drift / dry-run operation and its planned steps. |

## Architecture (control-plane model)

```
Synapse (control plane)
├── Host (a VPS)
│     └── Agent  ── observe-only ──> heartbeat (host facts + containers)
└── Project
      └── Cell  (core / runtime / integration / preview / enterprise-app)
            ├── Deployment(s)        (Convex backends)
            ├── DeploymentPlacement  (deployment → host, desired/observed)
            ├── CellLink(s)          (contract to another Cell + ServiceToken)
            ├── DesiredState         (intent, from placements)
            ├── ObservedState        (reality, from the agent)
            └── Drift                (desired vs observed → report + dry-run plan)
```

A Convex **deployment belongs to at most one Cell**. Hosts are instance-level
and shared across projects; Cells are project-scoped.

## What exists today (Blocos 1–9c)

- **Hosts / HostAgents / HostAdoptionTokens** + APIs (instance-admin).
- **Cells / CellResources / DeploymentPlacements** + idempotent backfill of
  existing deployments into core Cells.
- **synapse-agent** — observe-only (`inspect` / `join` / `run`), heartbeat,
  `desired_state` fetch (`applyAllowed=false`), `docker ps -a` + `containerScan`.
- **Host liveness** — computed `effectiveStatus` (online / stale / offline),
  revoke / rotate agent token.
- **CellLinks + ServiceTokens** — service-to-service contracts, link-scoped
  discovery (`discovery:read`), endpoint/endpointSource resolution.
- **Real topology** — `GET /v1/projects/{id}/cell_topology` (Host → Cell →
  Deployment → Links + warnings); legacy synthetic topology still works.
- **DesiredState / ObservedState / OperationRun** foundation.
- **Drift Engine + dry-run planner** — DriftReport / DriftItems, OperationSteps
  (`planned` / `no_op` / `skipped`), endpoints for recompute / latest / dry_run.
- **Dashboard** — CellsPanel, HostsPanel, CellLinksPanel, CellTopologyPanel,
  **StateDriftPanel**, **OperationRunsPanel** (all dry-run only).

## What does NOT exist yet

- **Apply / reconcile execution.** No Docker `create` / `restart` / `rm`, no
  volume ops, no Caddy/proxy mutation. `SYNAPSE_AGENT_APPLY` defaults to `false`
  and there is no apply code path.
- **Agent apply mode.** The agent only observes.
- **Runtime Cells that actually run Amagejumpy workloads.** Cells of kind
  `runtime` / `integration` / `enterprise-app` are modelled but not functional.
- **A CLI for the control plane** (the `synapse-agent` binary aside).
- **Amagejumpy integration** — no command/event transport, no outbox/inbox.

## Relationship to Amagejumpy (Core + Satellite Cells)

Amagejumpy will have **one** user-facing **Core** (auth, users, sessions,
workspaces, billing, UI). Normal customers are **workspaces inside the Core** —
**not** one Convex deployment per customer. Future **Satellite Cells**
(runtime / integration / preview / enterprise-app) are *internal* execution
units, not customers; an Enterprise Cell is the rare exception (a dedicated
deployment for one big customer).

```
Amagejumpy Core (user-facing: auth / workspaces / billing)
   └── authorizes the end user, emits an INTERNAL command
        └── Runtime Cell (future)        executes
        └── Integration Cell (future)    talks to 3rd parties
              └── returns an event to the Core

Synapse manages the CONTRACT (CellLink), the PLACEMENT (where it runs),
and the LIVENESS (is it up?) — never the end-user's permission or session.
```

See [AMAGEJUMPY_CELL_ARCHITECTURE.md](AMAGEJUMPY_CELL_ARCHITECTURE.md) for the
full reasoning.

### Why a Cell is NOT a customer

Customers are workspaces in the Core. A Cell is an operational/runtime unit.
Mapping one Cell (or one Convex deployment) per normal customer would multiply
deployments uncontrollably and fragment auth/session — which is exactly the
regression this layer is designed to prevent.

### Why Synapse is NOT end-user auth

Synapse authenticates **operators** (the people managing infra) and **agents**
(machines). It never stores an end user's Better Auth session and never decides
an Amagejumpy user's RBAC. That belongs to the Core.

### Why Synapse is NOT the Amagejumpy runtime

Synapse manages contracts, placement, and liveness. It does not transport
Amagejumpy payloads, is not a job broker, and is not a gateway between Convex
deployments today.

### Why Synapse does NOT apply changes yet

Apply is destructive and irreversible (container/volume removal). The whole
9.x line builds the *diagnosis + plan* first, with hard safety invariants, so
that a future apply mode can be added behind an explicit, reviewed feature flag
with full audit context — not bolted on speculatively.

## Per-topic docs

- [CELLS.md](CELLS.md) — Cells, kinds, environments, isolation, placements, backfill.
- [HOSTS_AND_AGENTS.md](HOSTS_AND_AGENTS.md) — Hosts, the agent, liveness, scan, pruning.
- [CELL_LINKS_AND_SERVICE_TOKENS.md](CELL_LINKS_AND_SERVICE_TOKENS.md) — contracts + tokens + discovery.
- [DESIRED_OBSERVED_DRIFT.md](DESIRED_OBSERVED_DRIFT.md) — the intent/reality/drift core.
- [OPERATION_RUNS.md](OPERATION_RUNS.md) — operation runs vs audit log.
- [SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md) — the rules that must not break.
- [API_CELL_CONTROL_PLANE.md](API_CELL_CONTROL_PLANE.md) — endpoint map.
- [RUNBOOK_CELL_CONTROL_PLANE.md](RUNBOOK_CELL_CONTROL_PLANE.md) — operational flows.
- [AMAGEJUMPY_CELL_ARCHITECTURE.md](AMAGEJUMPY_CELL_ARCHITECTURE.md) — the conceptual model.
