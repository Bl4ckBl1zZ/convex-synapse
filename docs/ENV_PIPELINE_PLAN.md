> **STATUS — IMPLEMENTED in v1.17.0.** Both items shipped as documented
> below. Item 1 closed via `cli/test/bin.test.js` regression coverage
> (production fix was already in v1.12.0 via `npm install -g
> @iann29/synapse@1.12.0`). Item 2 closed via the new
> `synapse/internal/convexenv/` package + handler rewrite + dashboard
> copy + this doc. See `docs/RELEASE_NOTES_v1.17.0.md` for the release
> story; the design rationale below is preserved as institutional
> memory.

# Env pipeline — diagnosis + plan

Branch: `fix/cli-site-url-and-default-env` off `main`.
Status: **Phase 0 — investigation complete. Awaiting operator review before implementation.**

Two items, one branch. Item 1 is a small but real bug in the CLI test
fixture (the production user impact is mostly already fixed by the
v1.12.0 npm publish). Item 2 is the real surgery — the dashboard's
"Default environment variables" panel currently writes to the wrong
layer of the stack.

---

## Item 1 — `synapse select` writes the wrong `NEXT_PUBLIC_CONVEX_SITE_URL`

### Diagnosis

The code is **correct end-to-end**. The bug is in the **test fixture** + **operator's installed CLI version**.

**Backend** (`synapse/internal/api/deployments.go:2221-2260`) — the `cli_credentials` handler computes `siteUrl` via `siteDeploymentURL()` and emits it in the JSON response. ✅

**CLI threading chain** (every call site verified):

```
api.cliCredentials(name)                    cli/lib/api.js:131-133   ✅ returns raw JSON
        ↓
select.run() (and rotate-key --write)       cli/lib/commands/select.js:195-201 ✅ passes whole creds
        ↓                                   cli/lib/commands/deployment-rotate-key.js:137-142 ✅
writeProjectEnv(dir, credentials, ...)      cli/lib/env-file.js:264-266        ✅ extracts creds.siteUrl
        ↓
updateEnvContent({convexUrl, siteUrl, ...}) cli/lib/env-file.js:164-173        ✅ writes line
        ↓
NEXT_PUBLIC_CONVEX_SITE_URL = siteUrl ?? convexUrl    (line 168 fallback)
```

The fallback only kicks in when `credentials.siteUrl` is `undefined`. Two ways that happens:

1. **CLI version mismatch** (the real production cause): operator is on `@iann29/synapse@1.11.0` (the npm-installed version per HANDOFF). Site-origin support landed in `db0bada` and reached the npm registry only with the v1.12.0 publish we just did. v1.11.0 does not include the chained changes to `select.js` + `env-file.js` — its CLI never reads `siteUrl` from the response, never passes it to the writer, falls back to `convexUrl`.
2. **Stale test mock** (the latent bug): `cli/test/bin.test.js:370-376` mocks the `/v1/deployments/dev-cat/cli_credentials` response without a `siteUrl` field, and the test assertions at `:383-397` never check `NEXT_PUBLIC_CONVEX_SITE_URL` or `NEXT_PUBLIC_CONVEX_URL`. The threading code is exercised but the siteUrl-non-empty branch is not. Test passes regardless.

### Plan (1 fatia)

**Slice 1.1 — `cli/test/bin.test.js`** (~15 LOC):

- Add `siteUrl: "https://dev-cat.site.example.com"` to the mock `cli_credentials` response at line 370-376.
- Add explicit assertions for both `NEXT_PUBLIC_CONVEX_URL` (must be cloud URL) AND `NEXT_PUBLIC_CONVEX_SITE_URL` (must be the site URL, not the cloud fallback). New separate test case for the siteUrl-missing branch (asserts the fallback path is still safe).
- Mirror the assertion in `cli/test/env-file.test.js` if not already present — we have `distinct siteUrl drives NEXT_PUBLIC_CONVEX_SITE_URL` there, verify it covers the end-to-end shape after `writeProjectEnv`.

**Slice 1.2 — version bump** (1 LOC):

- `cli/package.json`: `1.12.0` → `1.12.1` (patch — test-only fix + no code change).

**Slice 1.3 — release + publish** (runbook entry, Ian executes):

- Push `main` (post-review), wait CI green.
- `git tag cli-v1.12.1 && git push origin cli-v1.12.1`.
- `cd cli && npm publish --userconfig=<tmp-npmrc> --access=public` (token via env var, never committed). Same pattern as the v1.12.0 publish we did in the previous session.
- Operator `npm install -g @iann29/synapse@1.12.1` on the host that was running v1.11.0.

### Tests to add

| Where | What |
|---|---|
| `cli/test/bin.test.js` (new case after :397) | `synapse select` with mocked credentials including `siteUrl` writes the exact site URL to `NEXT_PUBLIC_CONVEX_SITE_URL` |
| `cli/test/bin.test.js` (new case) | same flow without `siteUrl` in the mock → fallback writes cloud URL (no regression) |

### Real-VPS validation

After publish: ssh into a host with the live stack, `npm install -g @iann29/synapse@1.12.1`, `synapse select` against `mip.amagejumpy.com`, assert `.env.local` has `NEXT_PUBLIC_CONVEX_SITE_URL` ending in `.site.app.synapsepanel.com` (or whatever the `role='site'` custom domain is, if configured).

### Risks

- None in the code change itself — purely additive test coverage + patch bump.
- The "operator on v1.11.0 still broken until they `npm install -g`" gap closes only when they update; no automatic push. Mention in release notes that v1.12.1 is functionally the same as v1.12.0 except for the test coverage — operators already on v1.12.0 don't need to upgrade.

---

## Item 2 — Default environment variables should reach Convex functions

### Diagnosis

**Today's flow puts user env vars on the wrong layer.**

```
Dashboard panel: "Default environment variables"
        ↓
POST /v1/projects/{id}/update_default_environment_variables   projects.go:880-938
        ↓
INSERT INTO project_env_vars (name, value, deployment_types)
        ↓
   ┌────────────────────────────────────────────────────┐
   │ PATH A — deployment creation                       │
   │   provisioner.worker.go:545-603 loadRuntimeEnvVars│
   │   → spec.EnvVars                                   │
   │   → docker/provisioner.go:415-417 (container ENV) │
   ├────────────────────────────────────────────────────┤
   │ PATH B — "apply to existing"                       │
   │   projects.go:969-1035 syncEnvToDeployments        │
   │   → deployments.go:140-223 rebuildCORSAndRestart  │
   │   → spec.EnvVars → Docker.Recreate (downtime!)    │
   └────────────────────────────────────────────────────┘
        ↓
Convex backend container starts/restarts with envvar in OS process env
        ↓
Convex FUNCTION calls `process.env.BETTER_AUTH_SECRET`
        ↓
❌ Function isolate reads from Convex's INTERNAL env store, NOT process.env
❌ Result: BETTER_AUTH_SECRET → "default secret" → 500 in production
```

The container ENV is read by the Convex backend's startup code (for `CONVEX_CLOUD_ORIGIN`, `INSTANCE_SECRET`, storage creds, etc) but **never propagated into the function isolate's `process.env`**. Functions only see vars that were written via Convex's own env store — populated by `npx convex env set` or the Convex Dashboard's env panel, which both hit the same backend HTTP API (see below).

The dashboard panel is mis-labelled and writes to dead-letter for any operator use case (secrets, API keys, feature flags) — which is **the entire use case for that panel**. The few legitimate container-ENV vars (CONVEX_CLOUD_ORIGIN, CONVEX_SITE_ORIGIN, INSTANCE_SECRET, S3/Postgres HA creds) are managed by Synapse internally in `docker/provisioner.go:386-410` and never flow through `project_env_vars`.

### Convex backend env-var API (research result)

Confirmed against `get-convex/convex-backend@4f6d234` ([source](https://github.com/get-convex/convex-backend/blob/4f6d234d200e5ffcc97da11db4e5f9cd21f8fb70/crates/local_backend/src/environment_variables.rs)):

| Operation | HTTP | Path | Body | Response |
|---|---|---|---|---|
| Batch set/unset | `POST` | `/api/update_environment_variables` | `{ "changes": [{ "name": "...", "value": "..." \| null }] }` | 200 OK |
| List all | `GET` | `/api/list_environment_variables` | — | `{ "environment_variables": { name: value, ... } }` |

**Auth**: `Authorization: Convex <admin_key>` header. Synapse has this for every managed deployment in `deployments.admin_key`; adopted deployments also have it (operator-supplied at adopt time).

**Port**: `3210` (cloud listener; same port as queries/mutations). NOT the site proxy on 3211. URL = the same `cloudURL` (`<name>.<base>` or `127.0.0.1:port` in host-port mode) that Synapse already computes via `cliDeploymentURL`.

**Batch semantics**: atomic — all changes applied or none. The Convex CLI fans `.env` file content into a single POST with the full `changes` array. Synapse should mirror this (one call per project per deployment, not N).

**Managed-name filter** (copied from Convex CLI, `npm-packages/convex/src/cli/lib/env.ts:envSetFromContent`):

The Convex CLI explicitly **excludes** these names from the env set, since they're CLI-managed and not application-level config:
- `CONVEX_DEPLOY_KEY`
- `CONVEX_DEPLOYMENT_TOKEN`
- `CONVEX_DEPLOYMENT`
- `CONVEX_SELF_HOSTED_URL`
- `CONVEX_SELF_HOSTED_ADMIN_KEY`
- `NEXT_PUBLIC_CONVEX_URL` (and other `EXPECTED_CONVEX_URL_NAMES`)
- `NEXT_PUBLIC_CONVEX_SITE_URL` (and other `EXPECTED_SITE_URL_NAMES`)

Synapse must apply the same filter — if an operator pastes these into the panel by accident we silently drop them (logging a warning).

### Design decision — REPLACE the container path, don't dual-write

**Recommendation: substitute, don't add.** Three reasons:

1. **Container ENV for user vars was always dead-letter.** Convex functions never read from `process.env`; they read from the internal env store. No operator was ever actually depending on the container-ENV side effect for their function code. Removing it removes confusion without removing real-world behaviour.
2. **Dual-write creates two sources of truth for the same name.** "I set `BETTER_AUTH_SECRET` in Synapse, it shows up in the Convex Dashboard env panel, then I edit it there, then Synapse rebuilds the container with the old value → mystery rollback." Removing the container side eliminates the divergence.
3. **System env vars are unchanged.** `CONVEX_CLOUD_ORIGIN`, `CONVEX_SITE_ORIGIN`, `INSTANCE_SECRET`, S3/Postgres HA creds, etc are managed by `docker/provisioner.go` directly from `Config` / `Storage` — never via `project_env_vars`. They stay container-ENV because the Convex backend's startup code (Rust process, not the function isolate) actually reads them.

**Edge case acknowledged**: if a user did rely on the container-ENV path (e.g. for an HTTP action calling out to a binary that reads `process.env`), this would silently break for them. Mitigated by:
- Migration: at first apply after the upgrade, push every existing `project_env_vars` row into the function store (one batch per deployment). Old container restart still runs once (last `recreate` to clean stale ENV).
- Release notes call out the change explicitly.
- After migration, the container ENV no longer carries user vars; only system vars.

### Plan (8 fatias, ordered for clean reverts)

**Slice 2.1 — `synapse/internal/convexenv/` client (NEW package)**
- `client.go` — `Client` struct with `Update(ctx, deploymentURL, adminKey string, changes []EnvVarChange) error` and `List(ctx, ...) (map[string]string, error)`. Wraps `POST /api/update_environment_variables` and `GET /api/list_environment_variables`. Auth header `Authorization: Convex <key>`. Uses `net/http` with a configurable timeout (3s default; configurable for slow networks).
- `changes.go` — `EnvVarChange{Name string, Value *string}` with `MarshalJSON` that emits `null` when `Value == nil` (unset semantic).
- `filter.go` — `IsManagedName(name string) bool` — the seven CLI-managed names listed above. Used to drop names that don't belong in the function store.
- `client_test.go` — httptest server, asserts request shape, auth header, batch payload, response parsing, 401/500 error mapping.
- Audit constants: `audit.ActionUpdateFunctionEnvVars` (new — wire-name `updateFunctionEnvVars`).

**Slice 2.2 — push at deployment creation**
- `synapse/internal/provisioner/worker.go::runJob` after `markProvisionRunning` returns `running=true`, fan out the loaded `project_env_vars` to the new Convex env client. Single call per deployment, batched.
- Skip on `Adopted` if `admin_key` is empty (defensive — should never happen).
- Failure mode: log + audit_event `updateFunctionEnvVars` with `success=false` + warn in the deployment row's status surface. Don't mark provisioning failed — the deployment is operational; env vars are observability + retry-able via the sync handler.
- Stop appending user vars to `spec.EnvVars` (keep system vars). Specifically: `loadRuntimeEnvVars` removes the project_env_vars merge; only CORS_ALLOWED_ORIGINS stays in container ENV.

**Slice 2.3 — replace `syncEnvToDeployments` body**
- `synapse/internal/api/projects.go:969-1035` `syncEnvToDeployments` handler currently iterates deployments and calls `rebuildCORSAndRestart`.
- Replace the body: for each non-adopted+running deployment, call `convexenv.Client.Update(ctx, cloudURL, adminKey, changesFromProjectEnvVars(p, dt))`.
- Keep the response shape `{total, recreated→synced, skipped, failed}` so the dashboard doesn't need to change immediately. Rename `recreated` → `synced` in a follow-up commit with dashboard alignment.
- Audit `ActionSyncEnvToDeployments` keeps firing on the success path.
- **CORS sync stays** as a separate path: `rebuildCORSAndRestart` is now mis-named (it does rebuild+restart for CORS specifically — the active-domain-rolled CORS_ALLOWED_ORIGINS case). Keep it; it's called by domain-flip code, not by env-var-update.

**Slice 2.4 — push on `update_default_environment_variables`**
- `synapse/internal/api/projects.go::updateEnvVars` (handler at :880-938) currently only writes the DB row. Operator must then click "Apply to existing" to push.
- Decision: **make the push automatic** on `update_default_environment_variables`. Since the call is cheap (one HTTP per running deployment, no container restart), there's no reason to make the operator do two clicks.
- Implementation: after the DB write commits, enumerate matching deployments and call `convexenv.Client.Update` for each. Best-effort like audit — failures don't block the 200 response. Returns extended response `{updated: [...], syncResult: {total, synced, failed: [...]}}` so the dashboard can show partial-failure inline. Backward-compatible: existing 200 callers still see the `{updated}` field.
- Keep "Apply to existing" button as a retry mechanism for failures; rename/repurpose to "Re-sync to deployments".

**Slice 2.5 — adopted deployments**
- Adopted deployments DO have `admin_key` (operator supplied at adopt time, stored in `deployments.admin_key`). The Convex env API doesn't care about the provisioner — only the admin key.
- **Include them** in the push fan-out (no special case). Skip with a clear log message if `admin_key` somehow ended up empty (defensive).

**Slice 2.6 — migration of existing rows**
- On Synapse startup (or first call after upgrade), background-push every existing `project_env_vars` row to its deployments' function stores. One-shot, idempotent (the API is atomic per call; setting same value is a no-op).
- Implementation: a startup hook in `cmd/server/main.go` that runs once via an advisory lock (multi-node safe) → enumerate every `(project_id, deployment_id)` pair → batch push.
- Alternative: lazy — skip the auto-migrate, rely on the next `update_default_environment_variables` or `syncEnvToDeployments` call to bring things into sync.
- **Recommendation**: lazy. Auto-migrate at startup adds complexity (lock, retry, partial-failure handling, what if deployment is down) and the eager push at every `updateEnvVars` (Slice 2.4) catches it on first operator interaction anyway. Operators who notice nothing was synced click the new "Re-sync to deployments" button (Slice 2.4) once.

**Slice 2.7 — dashboard copy + status surfacing**
- `dashboard/components/EnvVarsPanel.tsx` (or equivalent): update the panel header copy from "Default environment variables" → "Environment variables (applied to function runtime)". Subtitle explains: "Set here once, available via `process.env.NAME` inside every Convex function in this project. Same store the Convex Dashboard env panel writes to."
- Show per-row sync status (synced ✓ / pending ⚠ / failed ✗) from the sync response (Slice 2.4). Wire the "Re-sync to deployments" button to call `syncEnvToDeployments`.
- Add a small "What's this?" tooltip linking to `docs/CONVEX_SITE_ORIGIN.md#env-categories` (new section — Slice 2.8).

**Slice 2.8 — docs**
- New section in `docs/CONVEX_SITE_ORIGIN.md` (or extract to `docs/ENV_PIPELINE.md`) explaining the three env categories below.
- Update `CLAUDE.md` "What HAS landed" table with v1.17.0+ entry.
- Release notes for v1.17.0 explaining the change + the migration story.

### Tests to add

| Where | What |
|---|---|
| `synapse/internal/convexenv/client_test.go` | unit: request shape, auth header, batch payload, error mapping |
| `synapse/internal/test/projects_test.go` | integration: `updateEnvVars` → push happens automatically against fake Convex backend; partial-failure on one deployment doesn't 500 |
| `synapse/internal/test/projects_test.go` | integration: `syncEnvToDeployments` replaces rebuild with API push; no Docker.Recreate called |
| `synapse/internal/test/provisioner_test.go` | integration: deployment creation runs the post-provision push; old container-ENV merge no longer present in spec.EnvVars |
| `synapse/internal/test/env_vars_test.go` (or extend existing) | integration: managed-name filter drops `CONVEX_SELF_HOSTED_URL` etc; warning logged |
| `dashboard/tests/env-vars.spec.ts` | e2e: set var → assert sync status indicator + per-row state |

### Real-VPS validation

After staging-VPS deploy:
1. ssh `synapse-vps`, create a project, set `BETTER_AUTH_SECRET=test-value-xyz` in the panel.
2. ssh into the deployment's Convex backend container, run `curl -H "Authorization: Convex $ADMIN_KEY" http://localhost:3210/api/list_environment_variables` — assert `BETTER_AUTH_SECRET` appears.
3. Open the Convex Dashboard for the deployment, env panel — assert `BETTER_AUTH_SECRET` is listed.
4. Deploy a query function that returns `process.env.BETTER_AUTH_SECRET`, call it via `npx convex run`, assert value matches.
5. Edit value in Synapse panel, repeat — confirm it updates without container restart (compare container `started_at` before/after).
6. Test on an adopted deployment with operator-supplied admin key.

### Risks + edge cases

- **Convex backend unreachable** (transient network, deployment provisioning still) — sync push fails; logged + retry-able via "Re-sync" button. Acceptable.
- **Admin key rotation race** — `synapse deployment rotate-key` rotates the admin key; if a sync push is in flight, the old key 401s. Mitigation: rotate-key already triggers `rebuildCORSAndRestart`; chain in a follow-up env sync with the new key. Bundle in Slice 2.4 or document as known retry-on-401.
- **Operator manually sets via Convex Dashboard's own env panel** — last-write-wins. Synapse doesn't poll the function env store; if operator edits there and then in Synapse, Synapse's value wins on the next sync. Documented behaviour; not a bug.
- **HA multi-replica deployment** — Convex backend has single-writer-per-deployment via Postgres lease; one API call applies cluster-wide. Use the cloud URL (`<name>.<base>:3210`); the Caddy proxy routes to whichever replica holds the lease.
- **Managed-name accidental paste** — operator pastes `CONVEX_SELF_HOSTED_URL=https://...` into the panel. We drop it silently (with a log warning + a UI hint?). Confirm the desired UX in Slice 2.7.
- **Deletion semantic** — removing a var in the panel must send `{name, value: null}` to unset on the backend, not leave a stale value. Slice 2.4 handles via diffing old vs new state from the DB transaction.

---

## §3 — The three env categories (the doc the operator asked for)

After this change, every environment variable in Synapse falls into exactly one of three categories:

### 1. CLI / deploy credentials (operator workstation only)
- Owned by: `npx convex` CLI, written to `.env.local` by `synapse select`.
- Variables: `CONVEX_DEPLOYMENT`, `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`, `CONVEX_DEPLOY_KEY`, `CONVEX_DEPLOYMENT_TOKEN`.
- Lifetime: as long as the operator has the project linked.
- Filter: **excluded** from the function env store (Convex CLI managed names).

### 2. Frontend public vars (browser-visible)
- Owned by: the frontend bundle (Next.js, Vite, etc), inlined at build time.
- Variables: `NEXT_PUBLIC_CONVEX_URL` (cloud, port 3210), `NEXT_PUBLIC_CONVEX_SITE_URL` (HTTP Actions, port 3211 / site proxy).
- Written by: `synapse select` → `.env.local` (then framework picks them up at build).
- Lifetime: per-checkout.
- Filter: **excluded** from the function env store.

### 3. Convex function runtime env (what functions actually read)
- Owned by: the Convex backend's internal env store.
- Variables: every operator-defined value — `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, `DATABASE_URL`, feature flags, API keys, etc.
- Written by: Convex Dashboard env panel **OR** `npx convex env set` **OR** (after this change) Synapse's "Environment variables" panel.
- Read by: `process.env.NAME` inside any Convex query / mutation / action / HTTP action.
- Lifetime: per-deployment, persisted in the deployment's Postgres metadata.
- This is the **only** category that affects Convex function behaviour. Pre-this-change, Synapse's panel was writing to a fourth (dead-letter) container-ENV category.

**System-managed container ENV (Synapse internal, not operator-visible)**: `CONVEX_CLOUD_ORIGIN`, `CONVEX_SITE_ORIGIN`, `INSTANCE_NAME`, `INSTANCE_SECRET`, S3/Postgres HA creds. These are required for the Convex backend process to start up correctly; they live in `docker/provisioner.go` and never flow through `project_env_vars`. Operators never set or see them in the panel.

---

## §4 — Runbook (post-implementation, Ian executes)

### Item 1 (CLI patch publish)
1. After review + implementation, push branch to main.
2. Wait CI green.
3. `git tag cli-v1.12.1`, `git push origin cli-v1.12.1`.
4. `cd cli && NPM_TOKEN=... npm publish` (token from npm account; never commit). Pattern same as v1.12.0 publish.
5. Operators with v1.11.0 or v1.12.0: `npm install -g @iann29/synapse@1.12.1`. v1.12.0 → v1.12.1 is test-only; no functional change for operators who never had the issue.

### Item 2 (full release)
1. After review + implementation, push branch.
2. Wait CI green (Go + dashboard + Playwright + bats + installer).
3. Cut release: `git tag v1.17.0`, GitHub Release with notes referencing this doc + the migration callout.
4. **Validate on synapse-vps** end-to-end (the 6-step checklist above) before promoting to prod.
5. Operator decides when to upgrade prod (`./setup.sh --upgrade`). Pre-upgrade: snapshot backup is automatic. Post-upgrade: open dashboard, verify the env panel shows "applied to function runtime" copy + sync status indicators.
6. The first operator interaction with the env panel after upgrade will trigger the lazy migration push for that project's deployments. No explicit migration command.

---

## §5 — Acceptance gates (before considering done)

- [ ] `cd synapse && gofmt -l . && go vet ./... && go test ./... -count=1` green
- [ ] `cd cli && npm test` green (with new siteUrl assertions)
- [ ] `cd dashboard && npm run build && npm run lint && npx playwright test env-vars` green
- [ ] Real-VPS smoke (Item 2 checklist above) passes
- [ ] `docs/CONVEX_SITE_ORIGIN.md` or `docs/ENV_PIPELINE.md` updated with §3 categories
- [ ] `CLAUDE.md` "What HAS landed" updated
- [ ] Release notes drafted for v1.17.0 + `cli-v1.12.1`
- [ ] Dashboard env panel copy reviewed (Slice 2.7)

---

## §6 — Decisions for operator review (before implementation)

1. **Item 2 design**: substitute container ENV for user vars vs dual-write. Recommendation: **substitute** (rationale in §2 design decision). Confirm or override.
2. **Auto-sync on `updateEnvVars`** (Slice 2.4): every panel save automatically pushes to all running deployments, or keep manual "Re-sync" button as the only push path. Recommendation: **auto-sync** (cheap call, no downtime, removes a click). Confirm or override.
3. **Migration strategy** (Slice 2.6): lazy (next operator interaction) vs eager (startup background job). Recommendation: **lazy**. Confirm or override.
4. **Item 1 publish**: bundle the test-fix publish with v1.17.0, or ship `cli-v1.12.1` standalone first while Item 2 is in review. Recommendation: **standalone first** (closes the production bug fastest; v1.17.0 then ships clean without an entangled CLI bump). Confirm or override.

After your call on these four points I implement, fatiado por commit, gates verdes a cada fatia.
