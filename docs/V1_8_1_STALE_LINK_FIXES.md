# v1.8.1 — Stale-link UX hardening (3 bugs)

Smoke session 2026-05-22 with the freshly-shipped `@iann29/synapse@1.8.0`
surfaced three layered defects around the same root cause: an operator's
`.synapse/project.json` references a team/project that was deleted on the
backend. The CLI doesn't notice; the dashboard renders a cascade of red
"Failed to load X" banners; `doctor --fix` correctly detects the rot but
refuses to clean it up. Three subagent investigations produced the
following TODO list (synthesised). Each item cites the file + line it
modifies and the test that locks it in.

---

## BUG 1 — `synapse open` blindly launches stale dashboard URL

**Repro.** Operator has `.synapse/project.json` pointing at a deleted
project; `synapse open` (no args, default target = dashboard) opens
`<baseUrl>/teams/<slug>/<id>` with zero network call. Browser then loads
the project page which cascades 5+ "Failed to load X: Project not found"
errors (see Bug 2 for the dashboard side).

**Premise correction.** `cli/lib/api.js:108-126` exposes `me()`,
`teams()`, `projects(teamRef)` (list), `deployments(projectId)`,
`cliCredentials(name)`. There is **no** `api.projects.get(id)` today.
Backend exposes `GET /v1/projects/{id}/` at
`synapse/internal/api/projects.go:78` (`getProject`). We add the client
method.

### TODO

1. **`cli/lib/api.js` (~line 119)** — add `getProject(projectId)` calling
   `GET /v1/projects/{id}/`. Returns project JSON on 200, throws
   `SynapseAPIError` with `status === 404` / `code === "project_not_found"`
   on missing. Reason: one O(1) PK probe is cheaper than `teams()` +
   `projects(teamRef)` (both paginate via `listAll`); FK cascade
   `team→projects` means a single project probe catches stale-team too.

2. **`cli/lib/commands/open.js:69-95`** — when `target` resolves to
   `dashboard` AND a `projectConfig` is linked AND a session exists,
   `await ctx.api.getProject(projectConfig.project.id)` before spawning
   the launcher. Map to `projectStatus`:
   - `"ok"`  → proceed silently
   - `"not_found"` (caught `SynapseAPIError` with `status === 404`) →
     `ctx.out.warn(...)` with operator-actionable copy, **still launch**
     (don't block — operator may want to inspect the broken page)
   - `"unverified"` (any other error — network, 5xx, `status === 0`) →
     `ctx.out.info("Could not verify project state (offline?), opening anyway.")`,
     launch
   - `"skipped"` — no session, no projectConfig, target ≠ dashboard, OR
     target === `"url"` → not emitted in human mode

   Warning copy: `Linked project <name> (<id>) was not found on
   <cfg.baseUrl>. It may have been deleted. Run \`synapse select\` to
   relink.` Tone matches `select.js:221-228`.

3. **`cli/lib/commands/open.js:76-79`** — `--json` schema gains
   `projectStatus` unconditionally (one of `"ok" | "not_found" |
   "unverified" | "skipped"`). No installed base to break — `open` is
   freshly v1.8.0.

4. **`cli/lib/commands/open.js`** — extract pre-check into top-level
   `async function checkProjectStatus(ctx, projectConfig)` returning one
   of the four strings; export on `module.exports` alongside `buildUrl` /
   `launcher` so tests can drive it directly.

5. **Pre-check scope.** Only `dashboard` (default) gets the probe.
   `docs` is external; `deployment <name>` implies operator knowledge;
   `url` is the bare base. Document this in a 2-line comment above
   `checkProjectStatus`.

### Tests (append to `cli/test/commands-new.test.js`)

- (a) `checkProjectStatus` returns `"ok"` when stub resolves
- (b) returns `"not_found"` when stub throws `SynapseAPIError(404,
  "project_not_found", …)`; warning copy verified via `out.warn` capture
- (c) returns `"unverified"` when stub throws `SynapseAPIError(0,
  "network_error", …)`
- (d) `--json` output: parse stdout, assert `parsed.projectStatus ===
  "not_found"`
- (e) `ctx.cfgOrNull = null` → returns `"skipped"` without touching
  `ctx.api`

### Rollback

Single-commit revert is safe. `getProject` is additive; `open.js`
changes are localized. If the warning starts firing on transient
backend hiccups, demote 404 → `"unverified"` when `me()` also fails —
defer until reported.

### Out of scope

No auto-relink. No backend changes. No pre-check for `synapse status` /
`synapse dev` (separate bugs if they surface). No retry/backoff. No
caching.

---

## BUG 2 — Dashboard project page cascades 5+ "Failed to load X" errors

**Root cause (one sentence).** `ProjectPage` at
`dashboard/app/teams/[team]/[project]/page.tsx:116-143` fires
`useSWR<Project>` AND, in parallel and unconditionally,
`useSWR<Deployment[]>`. The full JSX tree (header, action bar,
deployments error block at `:470-474`, then `EnvVarsPanel`,
`ProjectDnsCredentialsPanel`, `ProjectMembersPanel`, `TokensPanel × 2` at
`:606-637`) renders regardless of whether `project` resolved. Each child
panel fires its own SWR against the same `projectId`; backend returns
404 (`synapse/internal/api/projects.go:138`) or 403 (`:150`) five
separate times, rendered as five red strings.

**Fix.** A single top-of-component gate. If project SWR errors with 404
or 403, render an `EmptyState` and return — none of the panels mount, no
cascade.

### TODO

1. **NEW `dashboard/components/ui/empty-state.tsx`** —
   `<EmptyState title icon? description action? />`. Wraps `Card` +
   `CardBody`. Moves the inlined `EmptyState` + `Constellation` SVG out of
   `app/teams/page.tsx:147-203` and exports both. Refactor
   `app/teams/[team]/page.tsx:ProjectsEmpty` and `app/teams/page.tsx`
   inline component to import the shared version.
   Reason: every fix below needs the same primitive; inlining invites drift.

2. **`dashboard/app/teams/[team]/[project]/page.tsx`** — destructure
   `error: projectError, isLoading: projectLoading` from the project
   `useSWR` (`:120-123`). Between `:377` and `return (` at `:379`:
   - `projectLoading && !project` → return `<Skeleton>` (header outline,
     no panels). `Skeleton` already imported at `:13`.
   - `projectError instanceof ApiError && (projectError.status === 404 ||
     projectError.status === 403)` → return
     `<EmptyState title="Project unavailable" description="This project
     doesn't exist or you don't have access." action={<Link
     href={\`/teams/${encodeURIComponent(teamRef)}\`}>Back to
     projects</Link>} />`. Single copy for both codes — backend returns
     403 to non-members or 404 for info-hiding; UX + next step are
     identical.
   - Any other `projectError` → existing "Failed to load…" red banner
     (don't swallow real errors).

   **Drop header/breadcrumb/action buttons on the empty state.** Showing
   "New deployment" / "Delete project" for a project the operator can't
   see is a worse lie than a blank page. Back link goes inside the empty
   card.

   **SWR retry**: don't swallow at fetch layer; let exponential backoff
   continue so transient 503 recovers. The guard is render-time only.

3. **`dashboard/lib/api.ts:899-902`** — confirm `request<Project>` throws
   `ApiError` with `.status` populated from HTTP response (`:654`).
   Already correct; document the assumption in the guard comment.

### Affected pages inventory

| Page | File | Cascade today? | Fix in PR? |
|---|---|---|---|
| Project page | `app/teams/[team]/[project]/page.tsx` | YES — 5 errors confirmed | YES (the bug) |
| Team page | `app/teams/[team]/page.tsx:344-355` | YES — listProjects + listDeployments both 404 on dead team | YES — same pattern, ~15 LOC. Add gate on `useSWR<Team>` (already present at `:28-29` but not used to gate) |
| Embed page | `app/embed/[name]/page.tsx:155-191` | PARTIAL — has error short-circuit at `:268` but renders "Failed to open dashboard" not EmptyState, chains 4 SWRs each can independently 404 | DEFER — works today, ugly; track follow-up |
| Audit page | `app/teams/[team]/audit/page.tsx:103` | Single panel | NO |
| Team-members settings | `app/teams/[team]/settings/members/page.tsx:122` | Single fetch | NO |
| `/me` | `app/me/page.tsx:53` | Self resource | NO |

**Scope call.** Do project + team pages in one PR; defer embed polish.
Two pages share the same `EmptyState` and the same 404-or-403 rule —
the point of extracting the component. Embed page has its own auth-key
dance and deserves its own PR.

### Tests

NEW `dashboard/tests/project_not_found.spec.ts`:

- Logged-in operator visits
  `/teams/<their-slug>/00000000-0000-0000-0000-000000000000`. Assert:
  `getByText("Project unavailable")` visible; `getByText(/Failed to
  load/)` count is 0; `getByRole("link", { name: /back to projects/i
  })` navigates back to `/teams/<slug>`.
- Operator A creates project, operator B in different team visits its
  URL. Assert same UI. (403 path — `helpers/auth.ts` patterns from
  `team_admin.spec.ts`.)

### Rollback

Revert single commit. No DB migration, no backend change, no API
contract change — pure dashboard render-tree change. Worst case
(misclassifying transient network error as 404): operator hits refresh
and SWR recovers. Safe.

### Out of scope

- Backend 403-vs-404 disambiguation
- Embed page polish (separate PR)
- Per-panel internal 404 resilience (wrong layer)
- Telemetry / Sentry breadcrumb

---

## BUG 3 — `synapse doctor --fix` refuses to clean stale `project.json`

**Today.** `project-still-exists` check at
`cli/lib/doctor/checks.js:322-361` correctly detects rot but has
`autoFix: "never"`. `synapse doctor --fix` leaves it alone. Operator
must manually `synapse select`.

### Design decision: B-then-C hybrid, classified `prompt`

| Option | Verdict |
|---|---|
| **A.** Auto-delete `.synapse/project.json` | **Reject.** Equivalent to `rm -rf .synapse/` — too aggressive even under `--fix --yes`. Operator loses prod deployment refs. |
| **B.** Auto-relink by `project.slug` across operator's teams when EXACTLY ONE match exists with a different `project.id` (project was transferred to another team) | **Adopt for unambiguous transfer case.** |
| **C.** Annotate + clear: drop `project.id` + `deployments.{dev,prod}`, keep `synapseUrl` + `team` shell, write `staleReason: "project-not-found"` + `staleAt` ISO + `previous: {team, project}` | **Adopt as fallback when B can't disambiguate.** |

**`.env.local` handling.** Don't delete. Prepend a comment block:
`# stale — admin key invalid since YYYY-MM-DD, run \`synapse select\``.
Idempotent on the marker string. Cheaper than deletion-with-undo, easier
to reason about.

**Classification.** `autoFix: "prompt"`, NOT `"auto"`. Existing
`home-config-readable` (chmod) and `gitignore-protects-env` (append) are
non-destructive and idempotent — appropriate for `auto`. Rewriting
`project.json` is destructive-ish and earns `prompt`. Under `--fix
--yes`, runner treats prompts as auto-confirmed (already correct at
`runner.js:113` via `allowPrompt`).

**No 4th `autoFix` category needed.** An "interactive" tier would need
real stdin handling that fights `--json` and CI — punt until a real
second case appears.

### TODO

1. **`cli/lib/doctor/checks.js:322-361`** — flip `autoFix: "never"` →
   `"prompt"`. Extend `data` payload with `teamSlug` + `projectSlug` so
   the `fix` can run heuristic B without re-deriving (also visible in
   `--json`). Add `fix` async function (item 2). Edge case: if status
   came from the catch-arm ("lookup failed"), the fix MUST re-check
   before acting — call `ctx.api.projects(teamRef)` fresh, not trust
   stale data.

2. **`cli/lib/doctor/checks.js`** — implement `fix(ctx, result)`:
   1. Re-list `ctx.api.teams()`; for each team, `ctx.api.projects(team.slug
      || team.id)`. Build `candidates = flat list filtered by p.slug ===
      projectConfig.project.slug && p.id !== projectConfig.project.id`.
   2. (Heuristic B) `candidates.length === 1` → `writeProjectConfig` with
      rebuilt team + project refs and `deployments: {}`. Return `{ kind:
      "applied", message: "re-linked to <team>/<project> (project was
      transferred)" }`.
   3. (Fallback C) otherwise → overwrite `project.json` with `{ version,
      synapseUrl, staleReason: "project-not-found", staleAt: <iso>,
      previous: { team, project } }`. Append idempotent comment to
      `.env.local`. Return `{ kind: "applied", message: "marked stale —
      run \`synapse select\` to re-link" }`.
   4. Any API error → `{ kind: "failed", message }`. Runner records
      `detail`, status stays at `issue`.

3. **`cli/lib/project.js:45-60`** — allow `staleReason`, `staleAt`,
   `previous` through `sanitizeProjectConfig`. Without this,
   `writeProjectConfig` strips the marker the moment it's written.
   `readProjectConfig` already returns raw JSON.

4. **`cli/lib/doctor/checks.js:checkInProjectDir` (~:105-126)** —
   recognise the marker. When `projectConfig.staleReason ===
   "project-not-found"`, return `status: "warn"` summary `directory was
   unlinked by doctor — staleReason: project-not-found (YYYY-MM-DD)`,
   remediation `Run \`synapse select\` to re-link.` Post-fix, the next
   `doctor` run shows "linked-but-stale" instead of confidently saying
   "linked to ?". `checkProjectStillExists` naturally `skipped`s because
   marker has no `project.id`.

5. **`cli/lib/doctor/runner.js:103-123`** — verify `applyAutoFixes`
   tolerates "fix succeeded but check now skipped" (fallback C: recheck
   skips because `project.id` is absent). Existing `Object.assign(r,
   fresh, { fixedBy })` handles this — totals.fixed increments, exit
   code drops 2→0/1. Add one-line comment explaining why `fixedBy` on a
   `skipped` result is intentional.

6. **`cli/lib/doctor/renderer.js:36-48`** — `renderCheck` writes
   `fixedBy` regardless of status (already correct). No change. Add a
   test that `skipped + fixedBy` renders the `↻` symbol correctly.

7. **`cli/lib/commands/doctor.js:33-46`** — `--help` gains: `Stale
   project link → \`--fix --yes\` re-links if unambiguous, else marks
   stale.` Discoverability.

### Tests (extend `cli/test/doctor.test.js`)

- **Heuristic B happy path.** Seed `tmp/.synapse/project.json` with team
  A / slug `demo` / id `OLD`. Stub `teams() → [A, B]`, `projects("a") →
  []`, `projects("b") → [{ id: "NEW", slug: "demo", name: "Demo" }]`.
  `generateReport({ fix: true, allowPrompt: true })`. Assert: file
  points at team B + project NEW; `project-still-exists.fixedBy` matches
  `/re-linked/`; `totals.fixed === 1`.
- **Fallback C — ambiguous match.** Two teams each have a `demo`
  project with different id. Assert: file contains `staleReason:
  "project-not-found"`, `previous.project.id === OLD`, `fixedBy` matches
  `/marked stale/`.
- **`--fix` without `--yes` is a no-op.** Same setup, call
  `generateReport({ fix: true, allowPrompt: false })`. Assert: file
  untouched, `fixedBy` undefined, status still `issue`.

### Rollback

Revert the `autoFix` value to `"never"`; the other changes (sanitize
passthrough, marker recognition) are inert without the fix function
live. No DB migrations, no compose changes. Marker shape lives on
operator disks; readers defensive-default when fields absent —
rollback can't corrupt anything.

### Out of scope

- Programmatic call to `synapse select` (interactive shape doesn't fit
  doctor's loop)
- Auto-discovering dev/prod deployments for the re-linked project (B
  path leaves `deployments: {}`; operator runs `select` once)
- `synapse doctor --undo` command (the `previous` block is
  forward-compatible if needed later)
- Orphan-team case (operator's team deleted while project lives
  elsewhere) — different shape, separate check + fix
- Pre-marker `project.json` migration — shape is additive

---

## Release plan

Single PR, then `@iann29/synapse@1.8.1` + dashboard rebuild + GitHub
release. CLI tests target: 83 → 89 (+3 doctor, +5 open, +2
empty-state). Playwright: +1 spec (`project_not_found.spec.ts`).
Real-VPS validation: re-run the original repro (`synapse open` against
a `project.json` whose project was deleted on
synapsepanel.com) and confirm the warning fires, the launched page
shows the `EmptyState`, and `doctor --fix --yes` cleans the file.
