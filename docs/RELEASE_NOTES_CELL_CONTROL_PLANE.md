# Release notes — Cell Control Plane (RC)

**Proposed version:** `v1.12.0-rc1` (minor bump from the de-facto installer line
`1.11.7`; the feature set is additive + backward-compatible. Alternative label:
`cell-control-plane-rc1`.) · **Branch:** `feat/cell-control-plane` ·
**Staging-verified code commit:** `deaee89` (the Bloco 12.6 hotfix; the commits
after it are docs + a comment-only gofmt) · **Migrations:** `000017`–`000021`
(additive).

> **No git tag is created yet** — per the release process, the RC tag is cut
> only after real-staging-VPS verification passes. Staging verification **has
> passed** (Bloco 12.5/12.6, code commit `deaee89`); the RC/prod tag is still
> the maintainer's call. Production tag (`v1.12.0`) after the prod deploy window.

Turns Synapse from a per-deployment panel into a **Cell Control Plane**:
observe → compare → plan. **Diagnosis + dry-run only — it never applies changes
to a host.** See [CELL_CONTROL_PLANE.md](CELL_CONTROL_PLANE.md) and
[SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md).

## 1. Backend

Hosts · HostAgents · HostAdoptionTokens · Cells · CellResources ·
DeploymentPlacements · idempotent backfill (deployments → core Cells) ·
CellLinks · ServiceTokens · DesiredState · ObservedState · DriftReport ·
DriftItems · OperationRuns · OperationSteps. Real `cell_topology` endpoint
(legacy topology fallback preserved).

## 2. Agent (`synapse-agent`)

Observe-only Go binary: `inspect` / `join` / `run`; register / heartbeat /
desired_state fetch (`applyAllowed=false`); read-only `docker ps -a`;
`containerScan` + scan-aware pruning safety; computed `effectiveStatus`
(online/stale/offline); revoke / rotate token; systemd docs.

## 3. Dashboard

CellsPanel · HostsPanel · CellLinksPanel · CellTopologyPanel · **StateDriftPanel**
· **OperationRunsPanel** (+ `JsonDetails`/`redact`). All dry-run only; no Apply
button.

## 4. CLI (`@iann29/synapse`)

`hosts` · `agents` · `cells` · `cell-links` · `service-tokens` · `topology` ·
`desired` · `observed` · `drift` · `reconcile dry-run` · `operations`.
HTTP-only, `--json`, redacted output. **No `apply` command**;
`reconcile --apply` errors.
(CLI npm version must be bumped from `1.9.3` before publishing the new commands.)

## 5. Security

No real apply · no Docker mutation · no Caddy/proxy mutation · ServiceToken
hash-at-rest + shown once · link-scoped discovery (`discovery:read`) ·
ObservedState carries no env/command/logs/mounts · DesiredState carries no
secrets · dry-run only (`applyAllowed=false`, `willApply=false`,
`apply:true` → 400). `SYNAPSE_AGENT_APPLY` defaults `false`.

## 6. Breaking changes

**None.** Existing endpoints unchanged; old deployments keep working; legacy
topology fallback preserved; migrations `000017`–`000021` are additive (new
tables only). Up-from-zero and up→down→up rehearsed clean.

## 7. Known risks

- eslint baseline already red (~18 pre-existing dashboard files,
  `react-hooks/set-state-in-effect`) — **not** from this branch; branch files clean.
- Real apply does not exist (by design).
- CellLink endpoint can be `null` without a route/domain ("endpoint unresolved").
- Legacy topology coexists with `cell_topology`.
- State & Drift UI is project-level (host/cell deep-dive deferred).
- **Real-staging-VPS verification: done** (Hetzner CPX, Ubuntu 24.04). One
  release blocker was found there and fixed in-band — see *Staging verification*
  below.

## Verification matrix (re-run at staging-verified code commit `deaee89`)

| Gate | Result |
|---|---|
| `gofmt -l` (branch Go files) | clean |
| `go vet ./...` | exit 0 |
| `go test ./... -count=1` | all `ok` (integration ~70s) |
| `go build ./cmd/server` · `./cmd/synapse-agent` | OK |
| agent cross-build linux amd64 + arm64 | OK |
| CLI `node --test` | 266 / 0 · no `apply` command |
| CLI `npm pack --dry-run` | OK (73 files) |
| dashboard `tsc --noEmit` · `npm run build` | exit 0 |
| `docker compose build` (synapse + dashboard) | OK |
| Playwright (cells/cell-links/topology/state-drift/regression) | 19/19 |
| migration rehearsal up → down → up | v21 → dropped → v21 |
| `git diff --check` (branch) | clean |
| secret scan (manual; gitleaks not installed) | clean |

## Staging verification (real VPS — Bloco 12.5 / 12.6)

Deployed `feat/cell-control-plane` to a clean Hetzner VPS via `setup.sh`
(`--non-interactive --no-tls`, Docker bootstrapped via `get.docker.com`),
joined an agent, and drove the full observe → compare → plan loop against
**real** provisioned Convex backends.

**Blocker found (Bloco 12.5):** drift reported every real deployment as
`missing → would create`. Root cause — the provisioner labelled containers
`synapse.deployment=<name>` but the drift engine correlates on
`synapse.deployment_id=<UUID>` (the key the desired side carries). The
provisioner predated the Cell Control Plane and never stamped the UUID. Local
tests missed it because they hand-seeded observed rows *with* the UUID label;
only a real provisioner-built container surfaced the gap. Observe/dry-run only,
so never a safety bug — but drift accuracy was wrong.

**Fix (Bloco 12.6, commit `deaee89`):** provisioner now stamps
`synapse.deployment_id` + `synapse.project_id` (legacy `synapse.deployment`
kept) on every container-creating path; the IDs are threaded through create,
the async worker, HA provision/upgrade, CORS-rebuild, and deploy-key rotation.
A drift backward-compat fallback correlates pre-fix containers by name when
unambiguous and the project label is absent/matching (annotated
`legacyLabelFallback` + `recommendedLabelRefresh`); a present-but-wrong
`deployment_id` is never masked, and an ambiguous name stays `unmanaged`. No
new migration; no apply path added.

**Re-verified GREEN on the same VPS** after rebuild:

| Check | Result |
|---|---|
| New deployment (provisioner-built) drift | `in_sync` via **primary** UUID correlation |
| Legacy deployment (pre-fix container) drift | `in_sync` via `legacyLabelFallback` + `recommendedLabelRefresh` |
| Project-scoped recompute summary | `clean` — `inSync 2 · missing 0 · unmanaged 0` |
| Operator CLI `drift recompute --project` | `clean`, both `→ no-op` |
| `drift recompute --apply` (CLI) | rejected (`Unexpected argument`) — apply does not exist |
| Operation run type recorded | `compute_drift` (diagnose/plan only; no apply op type) |
| Dashboard `:6790` · API `/health` | 200 · 200 |
| Hosts (control-plane + agent) | both `effectiveStatus=online` |
| Stale-host case (heartbeat aged out) | `host_unreachable`, never false `missing` |

## Release artifacts

- **Synapse + dashboard:** Docker images via `docker compose build` (the prod
  unit; migrations run on container boot).
- **Agent:** `cd synapse && GOOS=linux GOARCH=amd64 go build -ldflags "-X main.Version=v1.12.0-rc1" -o dist/synapse-agent-linux-amd64 ./cmd/synapse-agent`
  (+ `arm64`). Rehearsal-build SHA-256 (canonical artifacts should be rebuilt by
  CI from the tagged commit — Go builds aren't bit-identical across hosts):
  ```
  767c197c0f130523d6e88ad644e051907f2a02ecd0db25060388d9514838069f  synapse-agent-linux-amd64
  1f9a9fcb78114ab010a9c4ceb626483dfadbfedd066fa692907f55f3bc380700  synapse-agent-linux-arm64
  ```
- **CLI:** `npm pack` after bumping `cli/package.json` version.

## Install / upgrade

Production is `setup.sh`-driven (single VPS). Existing installs upgrade with
`setup.sh --upgrade` (snapshot-rollback on failure) once this lands on `main`
+ a GitHub Release is cut. Migrations apply automatically on container boot.
Full deploy/rollback procedure:
[PRODUCTION_RELEASE_CHECKLIST_CELL_CONTROL_PLANE.md](PRODUCTION_RELEASE_CHECKLIST_CELL_CONTROL_PLANE.md).
