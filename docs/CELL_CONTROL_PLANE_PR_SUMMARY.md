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
State&Drift/Operations UI · 10a docs (this set) · 5 operator CLI. Detail:
[ROADMAP_CELL_CONTROL_PLANE.md](ROADMAP_CELL_CONTROL_PLANE.md#done-blocos-19c).

## Main commits

```
16cfe98 foundation (hosts/cells/placements)      a9437eb Cells/Hosts UI
2d31590 observe-only agent                        0aace48 host liveness + lifecycle
bf3737a CellLinks + ServiceTokens                 f1762f5 link-scoped discovery
3906b95 real topology                             46c8399 DesiredState/ObservedState
8925fce observed prune fix                        08d4f9a Drift Engine + dry-run
84139d8 observed fidelity + pruning safety        30e3671 State & Drift + Operations UI
a1b0840 docs consolidation (Bloco 10a)            583cfcd CLI commands (Bloco 5)
<Bloco 11> CLI EPIPE clean-exit fix + this verification pass
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

## CLI commands added (Bloco 5)

`synapse` (npm `@iann29/synapse`, `cli/`) — HTTP-only, zero-dep, `--json` on
every command, sensitive keys redacted in plan/drift/operation output:
`hosts {list,show,create,adoption-token,drain,agents}`,
`agents {revoke,rotate-token}`,
`cells {list,show,create,attach-deployment,attach-host,resources,drain}`,
`cell-links {list,create,disable}`, `service-tokens {create,list,revoke}`,
`topology show`, `desired {sync,list}`, `observed list`,
`drift {recompute,latest}`, `reconcile dry-run`, `operations {list,show}`.
**No `apply` command**; `reconcile --apply` errors; no Docker/SSH/DB access.

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

# CLI (npm @iann29/synapse)
cd cli && node --test      # 266 tests (zero-dep)

# Migrations up/down on a scratch DB (golang-migrate via the binary on boot, or)
#   apply, then roll back 000021→000017 and re-apply, confirming no error.
```

## Bloco 11 — verification results (pre-merge)

Run at HEAD `583cfcd` + the EPIPE fix. Full matrix green:

| Check | Result |
|---|---|
| `gofmt -l` (changed Go) · `go vet ./...` | clean · exit 0 |
| `go test ./... -count=1` | all `ok` (integration ~69s) |
| `go build ./cmd/synapse-agent` | OK |
| CLI `node --test` | 266 pass / 0 fail · no `apply` command |
| dashboard `tsc --noEmit` · `npm run build` | exit 0 · build OK |
| Playwright (cells / cell-links / topology / state-drift / project regression) | 19/19 |
| `git diff --check` (whole branch) | clean |
| eslint | 23 err/5 warn — **all pre-existing** baseline; branch CCP files clean |

**Migration rehearsal** (scratch DB, golang-migrate over the embedded FS):
up → version 21, down → all tables dropped (correct order, no FK errors),
re-up → version 21. Constraints verified on the live DB: one-cell-per-deployment
(`cell_resources_convex_deployment_idx`, partial unique), `cell_links_check`
(`source_cell_id <> target_cell_id`), `cell_links_active_uniq`,
`service_tokens_token_hash_key`, `desired_states_active_uniq`,
`observed_states_*_key`, adoption/agent token-hash uniques.

**Live smoke** (local stack): host created → adoption token → `synapse-agent
join` + `run --once` → host **online**; core+runtime cells → attach host → cell
link → service token → discovery active **200** / revoked **401**; desired sync
→ drift recompute (clean) → reconcile dry-run (`applyAllowed=false`) →
operation runs recorded; CLI `hosts list` / `topology show` / `drift latest` /
`reconcile dry-run` all render; dry-run UI has no Apply button (Playwright).

**Security review:** `applyAllowed` only ever `false`; `apply:true` → 400
`apply_not_supported`; `AgentApply` defaults false; drift.go has zero docker/
provisioner calls; agent runs only read-only `docker version` + `ps -a`; no
`token_hash` in UI/CLI; `redactJson` in both dashboard + CLI; ObservedState is
`synapse.*` labels only (no env/command/logs/mounts); dry-run steps only
planned/no_op/skipped; hosts instance-admin, discovery requires `discovery:read`.

## Known risks

- **eslint baseline is already red** on ~18 pre-existing files
  (`react-hooks/set-state-in-effect` + a `prefer-const` in `invites.spec.ts`,
  from a newer plugin) — **not** introduced by this branch (0 branch commits
  touch them); every branch Cell-Control-Plane file is eslint-clean. Don't block
  on it; fix in a separate cleanup pass.
- **Real apply does not exist** (by design). Operators act out-of-band on drift;
  the control plane only plans. The CLI has no `apply`; `reconcile --apply` errors.
- **CellLink endpoint resolution can be `null`** when the target has no active
  custom domain and no deployment URL ("endpoint unresolved").
- **Legacy topology coexists** with `cell_topology` (intentional fallback).
- **State & Drift is project-level**; host/cell deep-dive is deferred.

## Checklist — before merge

- [x] `go test ./... -count=1` green (Bloco 11)
- [x] `go vet ./...` clean
- [x] `gofmt -l .` clean (on changed Go files)
- [x] `npm run build` (dashboard) green
- [x] Relevant Playwright specs green (19/19)
- [x] Migrations `up` then `down` then `up` on a scratch DB without error
- [x] Agent `join` + `run --once` verified locally (host flips `online`)
- [x] State & Drift verified (sync → recompute → dry-run → operation run;
      **no Apply button** — Playwright asserts 0 apply controls)
- [x] CLI verified end-to-end (no `apply` command; `reconcile --apply` errors)
- [x] Re-read [SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md); none broken
- [x] Final review on a real **staging VPS** (Hetzner; found + fixed one drift
      blocker, then re-verified green — see below)

## Staging verification (Bloco 12.5 / 12.6)

Deployed to a clean Hetzner VPS via `setup.sh` and drove observe → compare →
plan against **real** provisioned backends. Found one release blocker: the
provisioner stamped `synapse.deployment=<name>` but drift correlates on
`synapse.deployment_id=<UUID>`, so every real deployment showed
`missing → would create` (local tests missed it — they hand-seeded the UUID
label). Fixed in commit `deaee89`: provisioner now stamps
`synapse.deployment_id` + `synapse.project_id` on every container-creating
path, with a name-based drift fallback for pre-fix containers (annotated
`legacyLabelFallback` + `recommendedLabelRefresh`, never masking a wrong
`deployment_id`). No new migration; no apply path. Re-verified green: new
deployment `in_sync` via primary UUID match, legacy deployment `in_sync` via
fallback, project recompute `clean` (`missing 0`), CLI `→ no-op`, `--apply`
still rejected, both hosts `online`, dashboard + API 200.

## Recommendation

**Ready for merge after review; ready for staging — hold prod for the
maintainer's go.** All automated gates + the local migration rehearsal,
end-to-end live smoke, security review, **and a real staging-VPS pass** are
green. One blocker was found on staging and fixed in-band (`deaee89`), then
re-verified on the same VPS. Remaining items are non-blocking follow-ups
(eslint baseline cleanup, host/cell deep-dive UI, the deferred
explicitly-gated apply mode). No RC/prod tag is cut in this pass — that is the
maintainer's call per the release process.

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
