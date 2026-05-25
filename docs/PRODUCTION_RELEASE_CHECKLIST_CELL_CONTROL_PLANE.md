# Production release checklist — Cell Control Plane

Operational deploy/rollback procedure for the `feat/cell-control-plane` branch
(commit `a105211`, proposed `v1.12.0-rc1`). Read alongside
[RELEASE_NOTES_CELL_CONTROL_PLANE.md](RELEASE_NOTES_CELL_CONTROL_PLANE.md) and
[SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md).

> **Golden rule:** the release must be reversible, auditable, conservative.
> Migrations are additive; the layer is observe-only (no apply). **Do not deploy
> to production until the staging-VPS verification (§2) passes.**

Deploy model: single VPS, `docker compose` (postgres + synapse + dashboard),
managed by `setup.sh`. Migrations run automatically on the synapse container's
boot. Upgrades use `setup.sh --upgrade` (snapshot + rollback-on-failure). CLI is
npm `@iann29/synapse`; the agent is a standalone Go binary.

---

## 1. Migration release plan (`000017`–`000021`)

### 1a. Backup (mandatory, before anything)
```bash
cd /opt/synapse            # the install dir
./setup.sh --backup        # manifest.txt + .env + compose + pg_dump + volumes → tarball
# (or raw DB only:)
docker compose exec -T postgres pg_dump -U synapse synapse | gzip > /opt/synapse/backup-pre-ccp-$(date +%F).sql.gz
```
Record: backup file path, the current commit (`git -C /opt/synapse rev-parse HEAD`),
the current migration version (below), and the running image digests
(`docker compose images`).

### 1b. Preflight
```bash
docker compose exec -T postgres psql -U synapse -d synapse -c "SELECT version, dirty FROM schema_migrations;"
df -h /                                   # disk headroom
curl -fsS http://localhost:8080/health     # app healthy BEFORE upgrade
```
Confirm: current version is `16` (pre-CCP) and `dirty = f`; no unknown pending
migration; app healthy.

### 1c. Execution
Migrations apply on container boot — no separate step. Deploying the new synapse
image (§3-B) runs `000017`→`000021` automatically. After the synapse container
is up, validate:
```bash
docker compose exec -T postgres psql -U synapse -d synapse -c "SELECT version, dirty FROM schema_migrations;"  # expect 21, f
```

### 1d. Validate constraints (post-migration)
```bash
docker compose exec -T postgres psql -U synapse -d synapse -tAc "
  SELECT indexname FROM pg_indexes WHERE indexname IN
   ('cell_resources_convex_deployment_idx','cell_links_active_uniq',
    'desired_states_active_uniq','service_tokens_token_hash_key',
    'observed_states_host_id_resource_type_resource_key_key',
    'host_adoption_tokens_token_hash_key');
  SELECT conname FROM pg_constraint WHERE conname='cell_links_check';"   # source<>target
```
Expect all six indexes + `cell_links_check`. (Verified in pre-merge rehearsal:
up→v21, down→clean, re-up→v21.)

### 1e. Post-migration sanity
- Old deployments still listed in the dashboard/CLI.
- Backfill ran (`SYNAPSE_ENABLE_CELLS=true`, default): existing deployments now
  have core Cells (`core-dev-*` / `core-prod-*`).
- Legacy topology still renders for projects without cells.

### 1f. Migration rollback policy
- **Preferred prod rollback = restore the backup** (§5), NOT a down-migration —
  once the app writes Cell Control Plane rows, a `down` would drop that data.
- Down migrations exist and were rehearsed (safe for scratch/staging), but
  production must prefer restore if any new data was written.

---

## 2. Staging-VPS verification runbook (REQUIRED before prod)

> **Status: NOT executed in this session** (only the local stack was verified).
> Run this on a **dedicated staging VPS** (e.g. `synapse-vps` — confirm it's free;
> it's normally the installer test box). **Never use production as staging.**

1. Deploy the branch: `git clone -b feat/cell-control-plane … && ./setup.sh --domain=<staging-host>` (or `--upgrade` on an existing staging install).
2. Migrations auto-run on boot → confirm `schema_migrations` = 21 / not dirty.
3. Dashboard loads; old deployments visible; backfill core Cells present.
4. Create a Host (UI or `synapse hosts create`); mint adoption token.
5. On a VPS, install the agent + `synapse-agent join --control-url <staging-url> --token <tok>` then `synapse-agent run --once` (optionally the systemd unit) → host flips **online**.
6. Create a runtime Cell → attach host → create CellLink core→runtime → mint ServiceToken.
7. Discovery: active token → **200**; revoke → **401**.
8. `synapse desired sync` → `drift recompute` → `reconcile dry-run` → confirm `applyAllowed=false`, `willApply=false`, **no Apply button**, `reconcile dry-run --apply` errors, operation runs recorded.
9. Observed/agent: `containerScan` present; docker-unavailable doesn't break heartbeat; no env/command/logs/mounts in ObservedState.
10. Liveness: stop agent → wait → `stale`/`offline` per thresholds → restart → `online`.
11. CLI against staging: `hosts list` · `topology show` · `desired sync` · `drift latest` · `reconcile dry-run` · `operations list`.

**If any step fails: stop, do not promote to prod, fix + re-verify.**

---

## 3. Production deployment plan (prepare only; execute on go-ahead)

- **Window:** _<TBD>_ · **Owner:** _<TBD>_ · **Commit/tag:** `a105211` / `v1.12.0` (cut after staging).

**Order:**
- **A. Pre-prod backup** — §1a (DB + commit + image digests + `.env` + migration version).
- **B. Deploy backend (runs migrations on boot)** — `./setup.sh --upgrade` (pulls the release, rebuilds the synapse image, restarts; migrations apply automatically). Because migrations are additive, the previous app stays schema-compatible during the swap.
- **C. Deploy dashboard** — same `setup.sh --upgrade` rebuilds the dashboard image (after backend).
- **D. CLI** — bump `cli/package.json` + `npm publish @iann29/synapse`; document `npm i -g @iann29/synapse@latest` for operators. (No server dependency.)
- **E. Agent** — publish the linux amd64/arm64 binaries (+ SHA256SUMS) on the GitHub Release. Roll out to **one controlled host first** (observe-only — safe). No need to update every host at once.
- **F. Post-deploy smoke** — §4 "Smoke".
- **G. Rollback** — §5 if any gate fails.

---

## 4. Checklists

### Pre-deploy
- [ ] DB backup taken (`setup.sh --backup`) + path recorded
- [ ] Current commit + image digests + migration version recorded
- [ ] `.env` saved
- [ ] Migrations rehearsed (up→down→up) — done pre-merge
- [ ] **Staging-VPS verification (§2) passed**
- [ ] Rollback procedure (§5) understood

### Deploy
- [ ] `setup.sh --upgrade` ran; synapse container healthy (`/health`)
- [ ] `schema_migrations` = 21, not dirty
- [ ] Six CCP constraints present (§1d)
- [ ] Dashboard healthy
- [ ] CLI published / install documented
- [ ] Agent binaries available on the Release

### Smoke (post-deploy)
- [ ] Login to dashboard
- [ ] Old deployments visible
- [ ] Cells appear (backfill)
- [ ] Hosts list works
- [ ] `cell_control_plane` topology renders
- [ ] State & Drift panel renders — **no Apply button**
- [ ] `desired sync` works · `drift recompute` works · `reconcile dry-run` works (`applyAllowed=false`)
- [ ] Operation run appears
- [ ] Agent `join` + `run --once` on a controlled host → online
- [ ] Discovery active → 200 / revoked → 401
- [ ] `synapse hosts list` works against prod

### Rollback readiness
- [ ] App rollback understood (re-deploy previous image / `setup.sh` snapshot)
- [ ] DB restore documented (§5)
- [ ] Agent revoke documented

---

## 5. Rollback plan

| Failure | Action |
|---|---|
| Dashboard broken | Roll back the dashboard image (previous tag / `setup.sh` upgrade snapshot). Backend unaffected. |
| Backend fails **before** migrations | Roll back the synapse container to the previous image. No schema change happened. |
| Backend fails **after** migrations (no new data) | Roll back the app image — migrations are additive, so the old app still runs against the new schema. The new tables are inert without the new handlers. |
| Backend fails after migrations **with** new CCP data written | **Restore the DB backup** (`setup.sh --restore=<archive>` or `gunzip -c backup.sql.gz | docker compose exec -T postgres psql -U synapse -d synapse`) + roll back the app. Prefer restore over `down`-migration. |
| Data corruption | Restore the backup (§1a). |
| Agent misbehaving | `systemctl stop synapse-agent` on the host + `synapse agents revoke <id>` (token stops authenticating). The agent never mutates anything regardless. |
| CLI issue | `npm i -g @iann29/synapse@<previous>`; the CLI is read/plan-only so no server state is affected. |

`setup.sh --upgrade` already snapshots and **auto-rolls-back on a failed
upgrade**; this table covers the manual cases beyond that.
