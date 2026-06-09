# Cell Control Plane — Apply / Reconcile (Bloco 10)

Status: **in progress** · Default: **OFF** (`SYNAPSE_APPLY_ENABLED=false`)
Supersedes the observe-only posture of Blocos 9/9b/9c **only when explicitly
enabled by the operator**, and only for the safe action set in Phase 1.

---

## 1. Context — why this exists

The Cell Control Plane already models intent (`desired_states`, derived from
cell placements), observes reality (`observed_states`, from agent heartbeats),
and computes the difference (`drift_reports` / `drift_items`) plus a step-by-step
repair **plan** (`reconcile/dry_run`). It stops there: every plan step carries
`willApply:false`, `applyAllowed:false`, and any request with `apply:true` is
refused `400 apply_not_supported` (`drift.go::applyRejected`). It is a
thermostat that measures but never turns on the heater.

Bloco 10 turns the heater on — **carefully, reversibly, and gated**. After this,
an operator can say "make reality match intent" and the control plane will
create a missing deployment's container or restart a stopped one, without
hand-running `docker` on the box.

This is a deliberate reversal of a deliberate safety posture, so the design is
built around *never being able to do harm by accident*: it is off by default,
central-driven (the agent never gains mutate powers), idempotent, refuses
data-destroying actions in Phase 1, and writes a full execution ledger.

---

## 2. The one decision that makes this safe: **central-driven, not agent-driven**

There are two ways to execute a reconcile:

| Approach | Who mutates | Verdict |
|---|---|---|
| **Agent-driven** (`SYNAPSE_AGENT_APPLY`) | the per-host agent pulls desired state and runs `docker` on its own box | ❌ **Rejected.** Distributed mutation, no central lease enforcement, and it would force us to grant the observe-only agent create/stop/remove powers — reversing invariants 5–8. |
| **Central-driven** (this plan) | `synapse-api` enqueues a `provisioning_jobs` row; the existing `provisioner.Worker` executes it via local Docker **or** `RemoteClient` over SSH | ✅ **Chosen.** Reuses the proven, durable, multi-node-safe queue and the *same* code path `create_deployment` already uses. The agent stays observe-only **forever**. |

**Consequence for safety:** invariants 5–8 ("the agent is observe-only; its only
Docker calls are read-only") are **preserved, not relaxed**. The agent never
reconciles. `SYNAPSE_AGENT_APPLY` stays dead code and is documented as
"never to be enabled — superseded by central-driven apply". Only the central
control plane mutates, through the audited queue it already owns.

```
            ┌──────────────── observe-only (UNCHANGED) ───────────────┐
 agent ─────┤ docker ps -a / version  →  POST /v1/agents/heartbeat    │
            └─────────────────────────────────────────────────────────┘
                                  observed_states
                                        │
 desired_states ── drift engine ── drift_report + plan ──(operator clicks Apply)
                                        │
                            POST .../reconcile/apply   (gated, RBAC)
                                        │
                              OperationRun(reconcile_apply)
                                        │ enqueues
                              provisioning_jobs(kind=reconcile)
                                        │ claimed by
                              provisioner.Worker  ──► dockerForJob
                                        │              ├─ local *docker.Client
                                        │              └─ *docker.RemoteClient (SSH)
                                        ▼
                       container created / restarted   →  operation_step result
                                        ▼
                       observed-state refresh + drift recompute (verify)
```

---

## 3. Action set & phasing

The drift planner already classifies each item into an action
(`drift.go::buildPlanSteps`). We split them by blast radius:

| Action | Drift status | Data loss? | Phase | Phase-1 behaviour |
|---|---|---|---|---|
| `create` | `missing` (desired running, no container) | No — re-provisions from the **existing** `deployments` row (which already holds admin key / instance secret / storage) | **1** | executed |
| `restart` | `drifted` (exists, not running, desired running) | No | **1** | executed |
| `stop` | `drifted` (running, desired stopped) | No (container kept) | **2** | `skipped` |
| `remove` | `absent` desired, container exists | **YES** (volume) | **2** | `skipped` (already "not implemented") |
| `investigate` | `unmanaged` / `orphaned` | n/a | never auto | `skipped` (operator-only) |
| `no_op` | `in_sync` / `ignored` | n/a | — | `no_op` |

**Phase 1 ships `create` + `restart` only.** They cannot destroy data: `create`
only fires when *no* container is observed (idempotency guarantees we never
double-create), and `restart` bounces an existing container in place.

**Phase 2** (`stop` / `remove`) is designed here but ships behind a second gate
(`SYNAPSE_APPLY_DANGEROUS=false`) and requires per-request explicit confirmation
(see §6). `remove` always keeps the data volume (`keepVolume=true`) — the
operator must still hand-run a force-delete to drop data, exactly like
`deleteDeployment` today.

**Why `create` is safe even though desired_state carries no secrets:** the
desired-state row deliberately holds no admin key / env / DB creds. It doesn't
need to — it is keyed to a `deployment_id`, and the `deployments` row already
holds `admin_key`, `instance_secret`, and (for HA) the encrypted
`deployment_storage`. A `create` reconcile enqueues an ordinary provision job
for that `deployment_id`; the worker re-provisions from the canonical row, the
same way a crashed-mid-provision recovery does. No secret ever travels through
the CCP plane.

---

## 4. Execution model — the OperationRun ledger

`operation_runs` + `operation_steps` (migration 000021) are already
apply-ready: `operation_steps.status` already allows `succeeded`/`failed`, and
both tables have `result_json` / `error` / `finished_at`. Bloco 9 just never
wrote those. Bloco 10 fills them.

```
operation_runs(type='reconcile_apply')
  status: queued → running → (succeeded | failed | cancelled)

operation_steps  (one per plan step)
  status: planned → (skipped | no_op)               # not applicable / dangerous-in-phase-1
        | planned → queued → running → succeeded     # applied OK
        | planned → queued → running → failed        # apply errored (best-effort: other steps continue)
```

- One `OperationRun` per apply request. Its `plan_json` is the frozen plan we
  acted on; `result_json` is the rollup `{succeeded, failed, skipped, noOp}`.
- One `operation_step` per plan step, carrying `action`, `resource_key`
  (`convex_deployment:<id>`), and `input_json` (`dangerous`, `driftStatus`,
  `severity`). Each applicable step is linked to exactly one
  `provisioning_jobs` row.
- The worker updates the **step** as it executes, then recomputes the **run**
  aggregate (running while any step is queued/running; succeeded if all
  terminal steps succeeded; failed if any failed). This is a pure rollup so a
  crashed worker re-derives it on restart.

---

## 5. Data model — migration 000029

Reuse the `provisioning_jobs` queue (durable, multi-node-safe, `SELECT … FOR
UPDATE SKIP LOCKED`). Widen it for reconcile work:

```sql
-- widen kind
ALTER TABLE provisioning_jobs DROP CONSTRAINT provisioning_jobs_kind_check;
ALTER TABLE provisioning_jobs ADD  CONSTRAINT provisioning_jobs_kind_check
    CHECK (kind IN ('provision','upgrade_to_ha','reconcile'));

-- reconcile linkage (NULL for non-reconcile jobs)
ALTER TABLE provisioning_jobs
    ADD COLUMN reconcile_action  TEXT
        CHECK (reconcile_action IS NULL OR
               reconcile_action IN ('create','restart','stop','remove')),
    ADD COLUMN operation_run_id  UUID REFERENCES operation_runs(id)  ON DELETE CASCADE,
    ADD COLUMN operation_step_id UUID REFERENCES operation_steps(id) ON DELETE CASCADE;

-- idempotency / single-flight: at most one un-finished reconcile job per step.
CREATE UNIQUE INDEX provisioning_jobs_reconcile_step_inflight
    ON provisioning_jobs (operation_step_id)
    WHERE kind = 'reconcile' AND status IN ('pending','claimed');
```

No new tables. `operation_runs`/`operation_steps` already exist; we only add a
new `type` value (`reconcile_apply`) and start writing terminal step statuses.

---

## 6. Guardrails — covering the failure modes

Each is a concrete, testable rule. Numbered for the safety-invariant cross-ref
(§8).

- **G1 — Off by default.** `SYNAPSE_APPLY_ENABLED=false` ⇒ the apply endpoint
  returns `404 not_found` (indistinguishable from "feature absent"). The
  dashboard never renders an Apply button. Kill-switch is instant.
- **G2 — RBAC.** Apply requires `canAdminProject` (project-admin), the same gate
  as destructive deployment ops. Read/plan stays any-member.
- **G3 — Fresh plan (TOCTOU).** Apply does **not** trust the plan the operator
  saw. It recomputes drift inside the request and acts on the freshly computed
  steps, recording the new `drift_report_id` on the run. A deployment that
  stopped drifting between view and click becomes a `no_op`, not a blind action.
- **G4 — Idempotency.** Before a `create`, the worker re-reads the deployment +
  observed state; if a container already exists it writes `no_op`, never a
  second container. The partial unique index (§5) makes a duplicate in-flight
  reconcile job for the same step impossible.
- **G5 — Single-flight per deployment / lease respect.** Apply refuses to
  enqueue a reconcile for a deployment that already has a `pending`/`claimed`
  `provision`/`upgrade_to_ha`/`reconcile` job — the deployment is mid-flight;
  reconciling it would race the Convex single-writer lease. The step is recorded
  `skipped` with reason `deployment_busy`.
- **G6 — Dangerous actions gated twice.** `stop`/`remove` need **both**
  `SYNAPSE_APPLY_DANGEROUS=true` **and** a per-request `confirm` token equal to
  the deployment name, **and** `force_dangerous:true` in the body. `remove`
  keeps the data volume. Absent any of these, the step is `skipped`.
- **G7 — Adopted deployments are never reconciled.** We don't own their
  container lifecycle (same rule as delete/restart). Step `skipped`, reason
  `adopted`.
- **G8 — Host trust.** Only act when the host's observation is trusted (online +
  docker available + scan succeeded). `host_unreachable` steps are `skipped` —
  the planner already classifies these.
- **G9 — Tenant isolation (unchanged).** Reuses scoped container/volume names
  (`convex-<name>` / `synapse-data-<name>`) and the `synapse-deployer-exec`
  whitelist on remote hosts. Apply gains **no** new host powers; it can only do
  what `create_deployment` already does.
- **G10 — Full audit.** `applyStarted` audit event on request; per-action audit
  on each executed step; the OperationRun + steps are the durable ledger.
- **G11 — Best-effort, isolated failures.** One step failing does not abort the
  others; the run ends `failed` if any step failed, `succeeded` if all terminal
  steps succeeded. No partial-rollback magic — each action is independently
  idempotent and re-runnable.
- **G12 — Post-apply verification.** After a reconcile job reaches a terminal
  state, the worker requests an observed-state refresh signal and a drift
  recompute so the dashboard shows convergence (or a still-drifted item if the
  action didn't take).

---

## 7. API surface

```
POST /v1/projects/{id}/reconcile/apply        # project-scoped
POST /v1/cells/{id}/reconcile/apply           # cell-scoped
POST /v1/hosts/{ref}/reconcile/apply          # host-scoped (instance-admin)
```

Request body:
```json
{
  "force_dangerous": false,         // Phase 2 only; default false
  "confirm": "<deployment-name>",   // required per dangerous step
  "only": ["<deployment-id>", ...]  // optional allow-list; default = all applicable
}
```

Response `202 Accepted`:
```json
{
  "operationRunId": "<uuid>",
  "status": "running",
  "summary": { "queued": 2, "skipped": 3, "noOp": 5, "dangerousSkipped": 1 }
}
```

Progress: existing `GET /v1/operation_runs/{id}` (+ `?include=steps`).
`apply:true` on the legacy `reconcile/dry_run` endpoints stays **rejected** —
apply is its own explicit verb, never a flag on the dry-run path.

---

## 8. Safety-invariant re-review (SAFETY_INVARIANTS.md)

| # | Invariant (Bloco 9) | Bloco 10 |
|---|---|---|
| 5 | Agent is observe-only: no create/start/restart/stop/remove | **UNCHANGED** — apply is central-driven; the agent never mutates |
| 6 | Agent's only Docker calls are read-only | **UNCHANGED** |
| 7 | `SYNAPSE_AGENT_APPLY` defaults false, no apply path | **UNCHANGED** — stays dead; superseded by central apply |
| 8 | `/v1/agents/desired_state` returns `applyAllowed:false` | **UNCHANGED** — the agent is told nothing changed |
| 9 | Dashboard has no Apply button | **RELAXED (gated)** — button appears only when `SYNAPSE_APPLY_ENABLED` and never sends `apply:true` to dry-run; it calls the explicit apply verb |
| 10 | `apply:true` on reconcile/drift → `400` | **UNCHANGED** — the flag stays rejected; apply is a separate endpoint |
| 11 | Dry-run never executes steps | **UNCHANGED** — dry-run still never executes; only the new apply endpoint does |
| 12 | Docker mutation forbidden | **RELAXED (gated, central-only)** — the central worker may create/restart (Phase 1) / stop/remove (Phase 2) under G1–G12; the agent still may not |
| 13 | Caddy / proxy mutation forbidden | **UNCHANGED** — apply touches containers only; proxy resolves dynamically |

Net: of the nine, **six are untouched**, **two are gated-relaxed for the
central plane only**, and the agent-facing posture is fully preserved.

---

## 9. Implementation slices

1. **Foundation** — `SYNAPSE_APPLY_ENABLED` (+ `SYNAPSE_APPLY_DANGEROUS`) config;
   migration 000029; safety-invariants doc update.
2. **Executor** — `provisioner.Worker` handles `kind=reconcile`: idempotency,
   dispatch `create`(Provision)/`restart`(Restart) via `dockerForJob`, write
   `operation_step` result, roll up the run, signal verification.
3. **API** — the `reconcile/apply` endpoints: gate, RBAC, fresh recompute, build
   the OperationRun + steps, enqueue jobs, audit. Phase-2 dangerous guards
   present but gated off.
4. **Dashboard** — gated Apply button + confirm + progress modal polling the run.
5. **Tests** — Go integration (happy-path create/restart, idempotency no-op,
   gate-off → 404, RBAC → 403, dangerous skipped, busy → skipped, adopted →
   skipped); Playwright (button hidden when disabled).
6. **Verify** — build/vet/test, bats unaffected, real-VPS smoke for the remote
   reconcile path.

---

## 10. Explicitly out of scope (this bloco)

- Agent-driven apply (`SYNAPSE_AGENT_APPLY`) — permanently superseded.
- Auto-apply / continuous reconciliation loops — apply is always operator-
  initiated in Bloco 10. A scheduler is a future bloco with its own review.
- Proxy/Caddy mutation (invariant 13 stays).
- HA-replica rebalancing across hosts (needs gap #3, HA-on-remote, first).
- Cross-host migration (gap #5).
