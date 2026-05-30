# Host Removal — Investigation & Implementation Map

> Status: investigation complete (branch `investigate/host-removal`). All
> load-bearing facts re-verified against `/home/ian/convex-2` on 2026-05-30.
> Where a claim went back-and-forth during review, this report states the
> settled answer and shows the evidence.

## 0. Executive summary

Synapse can **drain** a host (cosmetic `status='draining'` flag) but cannot
**remove** one. Removal is missing for three reasons, in descending severity:

1. **A hard DB constraint** — `deployments.host_id … REFERENCES hosts(id) ON
   DELETE RESTRICT` (`000026_deployments_host_id.up.sql:27-28`) physically
   forbids deleting a `hosts` row while any deployment points at it. The column
   is `NOT NULL` (line 36), so there is no orphan/escape state.
2. **The self-host is singular and load-bearing** — exactly one
   `hosts.is_synapse_host=true` row (the `synapse-host` seed at `000026:22-24`;
   uniqueness enforced by `hosts_one_synapse_host_idx` in
   `000017_hosts_agents.up.sql`) runs the control plane, and every legacy
   deployment is backfilled onto it (`000026:32-34`). It must be permanently
   non-removable.
3. **Off-box state Synapse can't clean up** — a remote host carries a Headscale
   tailnet node, an on-VPS systemd unit, system users, and SSH keys. Synapse
   stores the tailnet *IP* (`hosts.tailnet_addr`) but **not the Headscale node
   ID** (no column exists), and the `synapse-deployer-exec` forced-command
   wrapper only whitelists Docker subcommands — so there is no remote teardown
   path.

Verification good news: the Headscale client **already has** `DeleteNode`,
`ExpireNode`, `ListNodes`, and `GetNode`
(`internal/headscale/client.go:242,266,279,286`); `sshprov.Client` already
exists; audit `TargetHost` already exists (`audit.go:208`) — but there is **no
`ActionDeleteHost`**: `audit.go:158-161` has `createHost`/`updateHost`/
`drainHost`/`createHostAdoptionToken`, not delete.

The feature is buildable as an **instance-admin `POST /v1/hosts/{id}/delete`**:
a registry/DB removal with **best-effort Headscale teardown** and **documented
manual on-VPS cleanup**, gated by (a) a self-host guard, (b) a
zero-active-deployments precondition, and (c) a zero-pending/active
`provisioning_jobs` precondition. A new `headscale_node_id` column makes
teardown deterministic; a `ListNodes`-by-IP fallback keeps it correct without
it.

**Migration numbering (settled):** the highest existing migration is
**`000027_admin_jobs_headscale`**. The next free number is **`000028`**.

---

## 1. Why only DRAIN exists today

### 1.1 DRAIN is one UPDATE; REMOVE is a constraint fight

`drainHost` (`hosts.go:437-461`) is a single statement:

```sql
UPDATE hosts SET status = $2, updated_at = now() WHERE id = $1 RETURNING …
-- $2 = models.HostStatusDraining
```

No deletions, no cascades, no off-box work, no FK to satisfy. It is an *intent
flag* — and an **advisory-only** one: nothing in the provisioner honors it (see
§1.6), so today "drain" does not even stop new work from landing on the host.
REMOVE, by contrast, must satisfy a constraint that exists specifically to
block it.

### 1.2 BLOCKER #1 (hard): `deployments.host_id ON DELETE RESTRICT`

Verified verbatim (`000026_deployments_host_id.up.sql:27-28`, then `:36`):

```sql
ALTER TABLE deployments
    ADD COLUMN host_id UUID REFERENCES hosts(id) ON DELETE RESTRICT;
-- …
ALTER TABLE deployments ALTER COLUMN host_id SET NOT NULL;
```

Postgres rejects `DELETE FROM hosts WHERE id=$1` with an FK violation the
instant any deployment references that host. This is intentional: deployments
are long-lived; RESTRICT prevents orphaning a running Convex backend. Note:
RESTRICT keys off **all** rows including soft-deleted ones (`status='deleted'`
deployments keep their `host_id`), so even a host with only soft-deleted
deployments will trip the FK on a raw `DELETE` — the precondition (§2.2) avoids
ever issuing the DELETE in that case.

### 1.3 BLOCKER #2 (hard): the self-host is singular and mandatory

`000026:22-24` seeds `name='synapse-host', is_synapse_host=TRUE`;
`hosts_one_synapse_host_idx … WHERE is_synapse_host` (in `000017`) guarantees
exactly one such row; `effectiveHostStatus` special-cases it as permanently
online (`hosts.go:90-92`: `if hst.IsSynapseHost { return HostStatusOnline }`).
Deleting it would trip the RESTRICT FK (all legacy deployments live on it)
**and** leave the control plane without a host identity. **Permanently
non-removable.**

### 1.4 Blast radius — every FK that references `hosts(id)`

Confirmed against the migrations (`grep "hosts(id)"`):

| Table | Column | ON DELETE | Effect when host deleted | Source |
|---|---|---|---|---|
| `deployments` | `host_id` | **RESTRICT** | Blocks the delete (the gate) | `000026:28` |
| `host_agents` | `host_id` | CASCADE | Agent rows deleted (intended) | `000017:59` |
| `host_adoption_tokens` | `host_id` | CASCADE | Pending tokens deleted (intended) | `000017:86` |
| `desired_states` | `host_id` | CASCADE | Provisioning intent lost | `000021:19` |
| `observed_states` | `host_id` | CASCADE | Last-known reality lost | `000021:49` |
| `drift_reports` | `host_id` | CASCADE | Reconciliation history lost (drift_items cascade off drift_reports) | `000021:120` |
| `drift_items` | `host_id` | SET NULL | host_id nulled (row survives) | `000021:135` |
| `cells` | `primary_host_id` | SET NULL | Cell loses host affinity (survives) | `000018:42` |
| `deployment_placements` | `host_id` | SET NULL | Placement loses host (survives) | `000019:59` |
| `operation_runs` | `host_id` | SET NULL | Audit trail keeps row, loses host link | `000021:76` |

The CASCADEs on `desired_states` / `observed_states` / `drift_reports` are the
substantive concern — but they are **acceptable once the host has zero
deployments**: intent/observation/drift for an empty host is moot. The risk
only materializes if you force-delete *with* deployments still attached. That is
the second argument (after RESTRICT) for a **deployments-must-be-zero
precondition** rather than a force-cascade.

### 1.5 Off-box cleanup gaps (what makes remote removal genuinely hard)

A host adopted via `install-agent.sh` left state **outside** Synapse's Postgres:

- **Headscale tailnet node.** `register()` (`agents.go` ~line 195) stores
  `tailnet_addr`, `ssh_pubkey`, `ssh_user`, `ssh_port` and flips
  `is_remote=TRUE` — but stores **no Headscale node ID**.
  `DeleteNode(nodeID)`/`ExpireNode(nodeID)` (`client.go:279,286`) need the
  server-assigned node ID, so today the only path is `ListNodes`
  (`client.go:242`) + match by `tailnet_addr` — fragile if IPs are reused.
- **On-VPS systemd unit + users + keys.** `install-agent.sh` created the
  `synapse-deployer` user, the forced-command wrapper, an sshd drop-in, and the
  agent unit. The `synapse-deployer-exec` wrapper whitelists Docker subcommands
  only — Synapse cannot SSH in and run an uninstall. **This is inherently
  manual** (or needs a new agent `self_destruct` verb).
- **Encrypted SSH key.** `hosts.ssh_privkey_encrypted` (migration `000025`) —
  deleting the host row drops it; harmless, but worth noting it was the
  credential for that host.

### 1.6 The deeper reason: drain was never wired to scheduling

The provisioner picks a host via explicit `host_id` on the deployment, not by
scanning for non-draining hosts. `grep draining internal/provisioner` returns
nothing. So `status='draining'` is **purely cosmetic** today — which is exactly
why removal was never finished: the whole host-lifecycle (drain → cordon →
migrate → remove) was scaffolded at the *data* layer (`000017`–`000026`) but
only the cosmetic first step shipped in the API/UI.

---

## 2. What "remove a host" must actually mean

### 2.1 Three classes of host

| Class | `is_synapse_host` | `is_remote` | Removable? |
|---|---|---|---|
| **Self-host** (`synapse-host`) | true | false | **Never.** Hard-blocked in handler. |
| **Manual host** (created via `POST /v1/hosts`, never adopted) | false | false | Yes — pure DB row + cascades. No off-box work. |
| **Remote host** (adopted via `install-agent.sh`) | false | true | Yes — DB row + **Headscale teardown** + **manual on-VPS cleanup note**. |

### 2.2 Preconditions (the safe-removal contract)

A host may be removed **iff**:

1. It is **not** the self-host (`is_synapse_host=false`). → else
   `409 cannot_remove_self_host`.
2. It has **zero non-deleted deployments**:
   `SELECT count(*) FROM deployments WHERE host_id=$1 AND status<>'deleted'` = 0.
   → else `409 host_has_deployments` with the count.
   - **Refinement:** because `ON DELETE RESTRICT` counts *soft-deleted* rows
     too, the actual `DELETE FROM hosts` must be preceded by reassigning
     soft-deleted deployments' `host_id` to the self-host (keeps audit/history
     rows intact) inside the same transaction.
3. It has **zero in-flight `provisioning_jobs`** targeting deployments on this
   host. `provisioning_jobs` has **no `host_id`** (verified) — it cascades off
   `deployment_id` only — so check via join: no `pending`/`running` job whose
   deployment's `host_id=$1`. → else `409 host_has_active_jobs`. (Prevents a job
   claiming a deployment mid-delete.)

### 2.3 What removal does NOT do (Tier-1 honesty)

- Does **not** destroy or migrate deployments — operator must drain/destroy
  them first (the precondition enforces this).
- Does **not** SSH into the remote VPS to uninstall the agent — returns a
  `manualCleanup` note in the response + dashboard banner with the exact
  commands.
- Does **not** guarantee Headscale node removal if the node ID can't be
  resolved — teardown is **best-effort**, surfaced as
  `headscaleTeardown: "ok"|"skipped"|"failed"` in the response.

---

## 3. Full implementation map (ordered, exact files)

### Step 1 — DB migration `000028_hosts_headscale_node_id`

**New files:** `synapse/internal/db/migrations/000028_hosts_headscale_node_id.up.sql` / `.down.sql`

```sql
-- up
ALTER TABLE hosts ADD COLUMN headscale_node_id TEXT;
-- (nullable; populated by register() going forward, backfilled best-effort by ListNodes match)
```

Reason: makes Headscale teardown deterministic instead of IP-matching. **No
schema change to the FK** — keep `ON DELETE RESTRICT` and satisfy it via
preconditions. `.down.sql` drops the column.

### Step 2 — Model + agent register wiring

- `synapse/internal/models/models.go`: add `HeadscaleNodeID string` to `Host`
  (json `headscaleNodeId,omitempty`); extend `hostColumns` const
  (`hosts.go:212-214`) and `scanHost` (`hosts.go:220-240`).
- `synapse/internal/api/agents.go` `register()` (~line 195): after Headscale
  registration, resolve + persist `headscale_node_id` (via `ListNodes` match on
  the freshly-assigned `tailnet_addr`). Best-effort; non-fatal.

### Step 3 — Audit action

`synapse/internal/audit/audit.go` (line 158-161, right after
`ActionCreateHostAdoptionToken`): add `ActionDeleteHost = "deleteHost"` (follow
the existing string-style convention — `createHost`/`drainHost`/etc., not a
dotted form). `TargetHost` already exists at line 208.

### Step 4 — Backend handler + route

- `synapse/internal/api/hosts.go` `Routes()` (line 119-141): add
  `r.Post("/delete", h.deleteHost)` inside the `/{hostID}` group —
  **recommend POST `/delete`** (matches `drain`/`remote_setup` verb convention,
  CLI/curl-friendly, avoids any proxy that strips DELETE bodies).
- New `deleteHost(w, r)` handler implementing §2.2 preconditions in a
  transaction:
  1. `loadHost` (existing helper, `hosts.go:717`).
  2. Guard `is_synapse_host` → 409.
  3. Count non-deleted deployments → 409 if >0.
  4. Count in-flight jobs via join → 409 if >0.
  5. `BEGIN` + `SELECT … FOR UPDATE` on the host row; reassign soft-deleted
     deployments' `host_id` to self-host; `DELETE FROM hosts WHERE id=$1`
     (cascades clean agents/tokens/states/drift); `COMMIT`.
  6. **After commit**, best-effort Headscale teardown: if `is_remote` and
     `headscale_node_id` known → `ExpireNode` then `DeleteNode`; else
     `ListNodes`+match by `tailnet_addr`; capture `ok|skipped|failed`.
  7. `audit.Record(ActionDeleteHost)`.
  8. Respond `200 {id, headscaleTeardown, manualCleanup:[…]}`.
- Optional follow-up `internal/api/agents.go`: a `self_destruct` desired-state
  the agent polls — out of scope for v1; documented as the future automation of
  the manual step.

### Step 5 — CLI

- `cli/lib/https/hosts.js`: add `deleteHost(id)` → `POST /v1/hosts/{id}/delete`.
- `cli/lib/commands/cellplane-hosts.js`: add `hosts delete <id> [--yes]`
  subcommand following the `cells delete --yes` confirmation pattern; print
  `manualCleanup` + `headscaleTeardown` status; on 409 print the precondition
  that failed and the remediation.

### Step 6 — Dashboard

- `dashboard/components/HostsPanel.tsx` (or `RemoteHostsAdminPanel.tsx`): add a
  **Remove** button on non-self hosts; disabled with tooltip when deployment
  count >0. Confirm modal mirrors the deployment-delete modal. Show post-delete
  `manualCleanup` commands for remote hosts in a yellow banner.
- API client wrapper used by the panel: add the `POST /v1/hosts/{id}/delete`
  call.

### Step 7 — Docs

- `docs/REMOTE_HOSTS.md`: "Removing a host" section (preconditions + the manual
  on-VPS uninstall commands).
- `dashboard/app/docs/content/{en,pt-BR}/hosts-and-agents.md`: operator-facing
  remove flow.
- `docs/HOST_REMOVAL_INVESTIGATION.md`: **this report**.

---

## 4. Open decisions for the user

1. **HTTP verb:** `POST /v1/hosts/{id}/delete` (matches `drain`/`remote_setup`,
   CLI-friendly) vs REST `DELETE /v1/hosts/{id}`. Recommendation: **POST
   `/delete`**.
2. **`--force` semantics:** should a `force=true` *destroy* all deployments on
   the host first (call the existing deployment-destroy path per deployment), or
   stay strict (always require manual drain first)? Recommendation for v1:
   **strict only**, no force-destroy — keep blast radius small; add `--force`
   later if operators ask.
3. **Soft-deleted deployments:** reassign to self-host (keep history) vs
   hard-delete the rows. Recommendation: **reassign** (preserves audit trail;
   least destructive).
4. **Remote teardown depth:** best-effort Headscale node delete + manual VPS
   note (v1) vs full agent `self_destruct` automation (v2). Recommendation:
   **v1 best-effort + documented manual**, file v2 as follow-up.
5. **Expire vs Delete the Headscale node:** `ExpireNode` (reversible, keeps the
   row) then `DeleteNode` (removes it). Recommendation: **both — Expire then
   Delete** so a half-deleted host can't re-authenticate.

---

## 5. Risk & test plan

### 5.1 Integration tests (`synapse/internal/test/`, package `synapsetest`)

- `hosts_delete_test.go` (new):
  - delete a manual host with no deployments → 200; row gone; agents/tokens
    cascade-gone.
  - delete self-host → 409 `cannot_remove_self_host`.
  - delete host with 1 active deployment → 409 `host_has_deployments` (count=1).
  - delete host with only soft-deleted deployments → 200; soft-deleted rows
    reassigned to self-host (verify `host_id` changed, rows still present).
  - delete host with a `pending` provisioning job on its deployment → 409
    `host_has_active_jobs`.
  - non-admin caller → 403 (instance-admin gate).
  - audit row `host.delete` written.
- Headscale teardown: extend the fake Headscale (the client has
  `NewWith(doer)` seam, `client.go:54`) to assert `ExpireNode`+`DeleteNode`
  called with the resolved node ID; and the `ListNodes` fallback path when
  `headscale_node_id` is NULL.

### 5.2 Real-VPS validation (required — this crosses the agent/Headscale boundary)

Per CLAUDE.md, changes touching remote/Headscale/agent need real-VPS validation:

- On `synapse-vps`: adopt a remote host via `install-agent.sh`, then remove it;
  confirm the Headscale node disappears (`headscale nodes list`), the DB row is
  gone, and the documented manual cleanup actually removes the on-VPS
  unit/user.
- Confirm removing a host with a live deployment is refused, and that after
  destroying the deployment the removal succeeds.

### 5.3 Residual risks

- **IP reuse / stale node match** if `headscale_node_id` is NULL and two hosts
  shared a tailnet IP over time — mitigated by populating `headscale_node_id` on
  register going forward; old hosts fall back to IP match (logged as
  best-effort).
- **`deployment_replicas`** (HA) has **no `host_id`** (verified): replicas
  inherit the parent deployment's host, so the deployments-zero precondition
  already covers them. No separate check needed.
- **Race**: a `remote_setup`/adoption completing between precondition check and
  delete — mitigated by doing the count + delete in one transaction
  (`SELECT … FOR UPDATE` on the host row).

---

## 6. Recommended first PR slice (minimal correct increment)

**PR 1 — "remove a manual/empty host" (no off-box work):**

1. Migration `000028` (`headscale_node_id` column) — additive, safe.
2. `ActionDeleteHost` audit action.
3. `POST /v1/hosts/{id}/delete` handler: self-host guard + zero-deployments +
   zero-jobs preconditions + transactional delete (no Headscale call yet —
   manual hosts have none).
4. `hosts_delete_test.go` covering the 7 cases above.
5. CLI `hosts delete --yes`.
6. Dashboard **Remove** button (disabled when deployments >0).

This ships a correct, fully-tested removal for manual and drained-empty hosts
with zero off-box risk. **PR 2** adds the best-effort Headscale teardown
(`Expire`+`Delete`, `register()` persisting `headscale_node_id`) + the
manual-cleanup doc/banner + real-VPS validation. **PR 3** (optional) adds agent
`self_destruct` automation.

---

### Appendix — verified facts

| Claim | Verdict | Evidence |
|---|---|---|
| `deployments.host_id` is `ON DELETE RESTRICT` + `NOT NULL` | ✅ true | `000026:28,36` |
| Next migration number is `000028` | ✅ true | highest is `000027_admin_jobs_headscale` |
| Headscale client has `DeleteNode`/`ExpireNode` | ✅ true | `client.go:279,286` |
| `hosts` has no `headscale_node_id` column | ✅ true | grep of migrations |
| `provisioning_jobs` has no `host_id` | ✅ true | grep; cascades off `deployment_id` |
| `deployment_replicas` has no `host_id` | ✅ true (impact bounded) | grep; inherits deployment host |
| `ActionDeleteHost` audit action exists | ❌ false — must be added | `audit.go:158-161` has drain, not delete |
| provisioner honors `status='draining'` | ❌ false — drain is cosmetic | no `draining` ref in `internal/provisioner/` |
| `is_synapse_host` needs a DB-level delete guard | ⚠️ overstated — API guard + RESTRICT suffice | no other delete path exists |
