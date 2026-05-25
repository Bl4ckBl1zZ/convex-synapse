# Operation Runs

Part of the [Cell Control Plane](CELL_CONTROL_PLANE.md). An **OperationRun** is
the auditable trail of a single control-plane operation (sync / drift / dry-run),
with its scope, timing, input, plan, result, and **planned steps**.

## OperationRun vs the audit log

| | Audit log (`audit_events`) | OperationRun |
|---|---|---|
| Scope | Team-wide mutating actions (createTeam, createDeployment, …) | One control-plane operation |
| Granularity | One row per action | A run + N `operation_steps` + input/plan/result |
| Purpose | Compliance / "who did what" | "what did this operation compute / plan, and did it work?" |
| Created by | Every mutating handler (best-effort) | Only the sync / drift / dry-run flows (never by heartbeats) |

They're complementary: a recompute writes **both** an `OperationRun` (the
mechanics) and may be reflected in audit (the operator action).

## Types today

| `type` | Created by | `result` / `plan` |
|---|---|---|
| `sync_desired_from_placements` | `POST .../desired_state/sync_from_placements` | `result`: `{created, updated, unchanged, superseded, total}` |
| `compute_drift` | `POST .../drift/recompute` | `result`: `{driftReportId, status, summary}` |
| `reconcile_dry_run` | `POST .../reconcile/dry_run` | `plan`: `{mode:"dry-run", applyAllowed:false, scope, summary, steps}` |

(The constants `record_observed_state` / `create_desired_state` /
`disable_desired_state` are reserved but unused.)

## Lifecycle

`queued → running → succeeded | failed | cancelled`. A run is created `running`,
does its (read-only) work, and is finished terminal with `result`/`plan` or an
`error`. Heartbeats **never** create runs.

## OperationStep

Steps belong to a run (today only `reconcile_dry_run` produces them):

| Field | Meaning |
|---|---|
| `stepIndex` | Order within the run. |
| `action` | `no_op` · `create` · `restart` · `stop` · `remove` · `investigate`. |
| `resourceType` / `resourceKey` | The target (e.g. `convex_deployment:<id>`). |
| `status` | **`planned` · `no_op` · `skipped`** only in Bloco 9 — nothing is executed, so `succeeded`/`failed` never appear. |
| `reason` | Human explanation ("observed container not running; would restart"). |
| `input` | `{willApply:false, dryRunOnly:true, dangerous, severity, driftStatus}`. |

## Reading operations in the dashboard

The **Operations** panel (`OperationRunsPanel`) on the project page lists recent
runs (type · status · scope · duration). **View details** opens a modal with the
planned steps and the **redacted** `input` / `plan` / `result` JSON (sensitive
keys are scrubbed by `redactJson`).

## Debugging a failed operation

1. Find the run in the Operations panel (status `failed`, red) or
   `GET /v1/operation_runs/{id}`.
2. Read the `error` field — it carries the failure reason.
3. Inspect `input` to see the scope it ran against.
4. For drift/dry-run, a failure is almost always a transient DB/read error (the
   compute is read-only) — re-run Recompute drift. The previous successful
   DriftReport, if any, is still returned by `drift/latest`.

## API

```
GET /v1/projects/{id}/operation_runs   list recent runs (project-member)
GET /v1/operation_runs/{id}            run + steps (member if project-scoped;
                                       instance-admin if host-only)
```

See [API_CELL_CONTROL_PLANE.md](API_CELL_CONTROL_PLANE.md#state--drift).
