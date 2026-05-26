# State & drift

This is the heart of the [Cell Control Plane](/docs/en/cell-control-plane): compare what you **want** running against what is **actually** running, classify the gap, and produce a **plan** — without ever applying it.

## Desired vs. observed

| | Where it comes from | What it says |
|---|---|---|
| **Desired state** | Synced from your placements (`synapse desired sync`) | "Deployment X should be `running` on host Y." Versioned; superseded when it changes. |
| **Observed state** | Reported by the [agent](/docs/en/hosts-and-agents) | "Container Z exists on host Y, state `running`, with these `synapse.*` labels." |

Desired and observed are correlated by the **`synapse.deployment_id`** label (the deployment's UUID) on the same host — not by name. Provisioned containers carry `synapse.deployment_id` + `synapse.project_id`; older containers from before this scheme are matched by a name fallback (and flagged so you can refresh the label). **Neither side ever carries a secret** — only safe identity + state fields.

## Drift statuses

Recomputing drift classifies every desired/observed pair:

| Status | Meaning | Recommended action |
|---|---|---|
| `in_sync` | Desired and observed agree. | none |
| `missing` | Desired wants it running, but no container is observed (on a **trusted** host). | investigate / create |
| `drifted` | Container exists but its state diverges (e.g. desired running, observed exited). | restart / investigate |
| `unmanaged` | A managed container exists with no matching desired state. | investigate (never auto-remove) |
| `orphaned` | An active desired state points at a deployment that was deleted. | clean up the stale desired |
| `host_unreachable` | The host can't be trusted (offline / stale / docker down / scan incomplete). | investigate the host |
| `ignored` | Explicitly ignored. | — |

### The trust gate (no false "missing")

Drift only declares something `missing` when the host is genuinely **trusted**: online, with a fresh, complete container scan. If the host is offline/stale, docker is down, or the scan was incomplete, the resource is reported `host_unreachable` instead — a stale agent can never make a running deployment look missing. (Liveness and trust are separate; see [Hosts & agents](/docs/en/hosts-and-agents).)

## The dry-run planner

From the dashboard's **State & Drift** panel or the CLI, the loop is:

```bash
synapse desired sync       --project <id>   # desired state from placements
synapse drift recompute    --project <id>   # classify the gap (writes a report)
synapse drift latest       --project <id>   # read the most recent report
synapse reconcile dry-run  --project <id>   # turn the drift into a *planned* set of steps
```

Every plan step is `planned`, `no_op`, or `skipped` — **never executed**. Each carries `willApply=false`, and the operation as a whole carries `applyAllowed=false`. The dashboard shows this as **DRY-RUN ONLY** with the note "Nothing was applied to hosts."

> **There is no apply.** The dashboard has no Apply button, the CLI has no apply command (`synapse reconcile dry-run --apply` errors with "apply is not implemented"), and a request that sends `apply:true` to the server is rejected with `400 apply_not_supported`. Reconcile diagnoses and recommends; you act.

## Operation runs

Every sync, recompute, and dry-run is recorded as an **operation run** (type `compute_drift`, `sync_desired_from_placements`, …) with its input, result, and steps — visible in the **Operations** panel (marked **READ-ONLY**) or via `synapse operations list`. There is no operation type that applies changes; the history is a diagnostic trail, not a change log.

```bash
synapse operations list --project <id>
```

## Reading the panel

- **Drift summary** counts each status; a clean report is `in_sync` with everything else at 0.
- **Drift items** show the per-resource verdict + a redacted `diff` (secrets are stripped from every rendered JSON).
- Notes call out the important cases: `host_unreachable` → "observation cannot be trusted"; a legacy-label match → "recommend refreshing the deployment label"; a degraded scan → "container scan failed or incomplete".

It is a snapshot, computed when you recompute — not a live feed. With the agent running continuously, the **observed** side stays fresh; the **drift report** still updates when you (or a scheduled run) recompute.
