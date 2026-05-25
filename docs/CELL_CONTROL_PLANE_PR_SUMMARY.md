# Cell Control Plane — PR readiness

Summary of branch **`feat/cell-control-plane`** for review/merge. Concept:
[CELL_CONTROL_PLANE.md](CELL_CONTROL_PLANE.md). Rules:
[SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md).

## What this branch does

Turns Synapse from a Convex-deployment panel into a **Cell Control Plane**:
hosts + agents (observe-only), cells + placements, service-to-service contracts,
real topology, and a **desired/observed/drift + dry-run** layer with a dashboard
to see and plan — **without applying anything**. No real apply, no agent apply,
no Amagejumpy/ai-agent-core integration.

## Blocos implemented

1–3 foundation · 4 UI · 6 agent · 6.5 liveness · 7/7.5 cell links · 8 topology ·
9a desired/observed · 9b drift+dry-run · 9b.5 observed fidelity/pruning · 9c
State&Drift/Operations UI · 10a docs (this set). Detail:
[ROADMAP_CELL_CONTROL_PLANE.md](ROADMAP_CELL_CONTROL_PLANE.md#done-blocos-19c).

## Main commits

```
16cfe98 foundation (hosts/cells/placements)      a9437eb Cells/Hosts UI
2d31590 observe-only agent                        0aace48 host liveness + lifecycle
bf3737a CellLinks + ServiceTokens                 f1762f5 link-scoped discovery
3906b95 real topology                             46c8399 DesiredState/ObservedState
8925fce observed prune fix                        08d4f9a Drift Engine + dry-run
84139d8 observed fidelity + pruning safety        30e3671 State & Drift + Operations UI
```

## Migrations added

`000017_hosts_agents` · `000018_cells` · `000019_cell_resources_placements` ·
`000020_cell_links_service_tokens` · `000021_desired_observed_state`. All
additive; each has an `.up.sql` + `.down.sql`.

## Endpoints added

See [API_CELL_CONTROL_PLANE.md](API_CELL_CONTROL_PLANE.md) for the full map:
Hosts + host_agents, Agents (register/heartbeat/desired_state), Cells (+attach,
resources, drift), CellLinks + ServiceTokens + discovery, `cell_topology`,
desired_state (+sync), drift (latest/recompute), reconcile/dry_run, operation_runs.

## UI components added

`CellsPanel`, `HostsPanel`, `CellLinksPanel`, `CellTopologyPanel`,
`StateDriftPanel`, `OperationRunsPanel`, `JsonDetails` (+ `lib/redact.ts`).
All mounted on the project page; all dry-run only.

## Test commands

```bash
# Backend
cd synapse
gofmt -l .                 # expect clean
go vet ./...
go test ./... -count=1     # integration suite (needs postgres on :5432)

# Dashboard
cd dashboard
npm run build              # next build
npx playwright test state_drift_panel.spec.ts cell_topology_panel.spec.ts \
                    cells_panel.spec.ts cell_links_panel.spec.ts topology_panel.spec.ts

# Migrations up/down on a scratch DB (golang-migrate via the binary on boot, or)
#   apply, then roll back 000021→000017 and re-apply, confirming no error.
```

## Known risks

- **eslint baseline is already red** on ~10 pre-existing dashboard files
  (`react-hooks/set-state-in-effect` from a newer plugin) — **not** introduced
  by this branch; the new 9c files are eslint-clean. Don't block on it; fix in a
  separate cleanup.
- **Real apply does not exist.** Operators must act out-of-band on drift; the
  control plane only plans.
- **No control-plane CLI yet** (the `synapse-agent` binary aside).
- **CellLink endpoint resolution can be `null`** when the target has no active
  custom domain and no deployment URL ("endpoint unresolved").
- **Legacy topology coexists** with `cell_topology` (intentional fallback).
- **State & Drift is project-level**; host/cell deep-dive is deferred.

## Checklist — before merge

- [ ] `go test ./... -count=1` green
- [ ] `go vet ./...` clean
- [ ] `gofmt -l .` clean (on changed Go files)
- [ ] `npm run build` (dashboard) green
- [ ] Relevant Playwright specs green
- [ ] Migrations `up` then `down` then `up` on a scratch DB without error
- [ ] Agent `join` + heartbeat verified on staging (host flips `online`)
- [ ] State & Drift verified on a project with Cells (sync → recompute →
      dry-run → operation run detail; **no Apply button**)
- [ ] Re-read [SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md); confirm none broken

## Checklist — after merge

- [ ] `SYNAPSE_ENABLE_CELLS=true` backfill ran (existing deployments → core cells)
- [ ] `SYNAPSE_AGENT_APPLY` confirmed unset/`false` in all environments
- [ ] Agent rollout plan (build + ship `synapse-agent`, systemd) documented for ops
- [ ] Dashboard shows the new panels; legacy topology still renders for no-cell projects

## Rollback considerations

- The layer is **additive + observe-only**, so rolling back the binary is safe:
  no host state was mutated by it.
- DB: migrations `000017–000021` are additive (new tables only). Down-migrations
  drop those tables; safe as long as no other code depends on them. Prefer
  rolling back the **app** and leaving the tables (they're inert without the
  handlers) over dropping data.
- Agents: revoke agent tokens if you remove the agent endpoints; agents then
  401 and stop (they never mutate anything regardless).
