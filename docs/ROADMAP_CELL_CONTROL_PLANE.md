# Cell Control Plane — Roadmap

Scoped to the [Cell Control Plane](CELL_CONTROL_PLANE.md) — **shipped in
`v1.12.2`, merged to `main`**. For the general Synapse roadmap see
[ROADMAP.md](ROADMAP.md).

> **Not implemented and not scheduled without explicit review:** real apply,
> agent apply mode, Amagejumpy integration, ai-agent-core integration.

## Done — SHIPPED as `v1.12.2` (Blocos 1–14.1)

Merged to `main` (PR #116), released as `v1.12.2` (latest GitHub Release),
deployed to production (synapsepanel.com) and smoke-verified, CLI published
`@iann29/synapse@1.10.0`.

- **1–3** — Hosts / HostAgents / HostAdoptionTokens / Cells / CellResources /
  DeploymentPlacements + idempotent backfill + APIs (`16cfe98`).
- **4** — Cells/Hosts dashboard UI (CellsPanel, HostsPanel, adoption modal,
  Cell badge) (`a9437eb`).
- **6** — observe-only `synapse-agent` (inspect/join/run) + register/heartbeat/
  desired_state (`2d31590`).
- **6.5** — host liveness `effectiveStatus`, agent revoke/rotate, systemd docs
  (`0aace48`).
- **7 / 7.5** — CellLinks + ServiceTokens; link-scoped discovery,
  `discovery:read`, endpoint/endpointSource, token `effectiveStatus`
  (`bf3737a`, `f1762f5`).
- **8** — real `cell_topology` (Host → Cell → Deployment → Links + warnings);
  legacy fallback intact (`3906b95`).
- **9a** — DesiredState / ObservedState / OperationRun; `desired_state`
  endpoint with `applyAllowed:false` (`46c8399`).
- **9b** — Drift Engine, DriftReport/Items, reconcile dry-run planner,
  OperationSteps; `apply:true` → 400 (`08d4f9a`, prune fix `8925fce`).
- **9b.5** — agent `docker ps -a`, `containerScan`, scan-aware pruning, drift
  trust, liveness-vs-draining split (`84139d8`).
- **9c** — StateDriftPanel + OperationRunsPanel + JsonDetails/redactJson;
  dry-run-only UI, no Apply button (`30e3671`).
- **10a** — this documentation set.
- **5** — operator **CLI** (`synapse` npm `@iann29/synapse`): hosts / agents /
  cells / cell-links / service-tokens / topology / desired / observed / drift /
  reconcile dry-run / operations. HTTP-only, `--json`, redacted output, no
  `apply` command (`reconcile --apply` errors).
- **11** — pre-merge hardening (full test matrix, migration rehearsal, live
  smoke, security review); CLI EPIPE fix (`a105211`).
- **12 / 12.5 / 12.6** — release prep + real staging-VPS verification; found +
  fixed the provisioner-label drift blocker (`deaee89`).
- **13** — RC tag + **production deploy** to synapsepanel.com (backup → upgrade
  → smoke); cut `v1.12.0`/`v1.12.2`, **merged to `main`** (PR #116), GitHub
  Release latest, CLI published `@iann29/synapse@1.10.0`.
- **14 / 14.1** — post-deploy fixes found in prod: deployment-delete cleans up
  Cell Control Plane state (`v1.12.1`); self-host reads online, delete clears
  `primary_deployment_id`, stale dashboard banner removed (`v1.12.2`).
- **docs** — in-dashboard `/docs` Cell Control Plane pages (Overview, Hosts &
  agents, Cells/links/topology, State & drift) in en + pt-BR.

## Next (incremental, still observe/plan only)

- **Host/cell deep-dive** in StateDriftPanel (scope selector) — today it's
  project-level + adjacency to topology.
- **Drift badges per cell** inside CellTopologyPanel.
- `synapse-agent` **install helper** (in `setup.sh` or a `install-service`
  subcommand) + a packaged/released agent binary.
- Finish + cross-link the docs.

## Later (requires explicit design + review)

- Richer **DesiredState** (routes, env intent, replica counts).
- **Safe apply (experimental)** — gated, non-destructive first, behind a
  reviewed feature flag.
- **Agent apply mode** — behind `SYNAPSE_AGENT_APPLY` (today hard-`false`).
- **Caddy / proxy reconcile**.
- **Backup / restore** of cell/placement state.
- **Amagejumpy Core / Satellite** integration (command/event transport, runtime
  cells) — see [AMAGEJUMPY_CELL_ARCHITECTURE.md](AMAGEJUMPY_CELL_ARCHITECTURE.md).
- Functional **runtime / integration / enterprise-app** cells.

## Explicitly NOT in this branch

- ❌ Real apply / reconcile execution (no Docker/Caddy/volume mutation).
- ❌ Agent apply mode.
- ❌ Amagejumpy command/event transport, outbox/inbox, runtime workloads.
- ❌ ai-agent-core integration.
- ❌ Kubernetes, distributed DB, job broker, end-user auth/RBAC.
