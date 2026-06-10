# Deployment backups

Per-deployment snapshot backups with download, restore, daily scheduling and retention — the self-hosted answer to Convex Cloud's **Backups** page (which Cloud paywalls at Pro). Each backup is a **real Convex snapshot export**: the exact same zip `npx convex export` produces, taken from the live backend with its admin key, so it contains tables, file storage and everything else a snapshot export carries.

Available since **v1.26** (migration `000035_deployment_backups`).

> **Two backup layers exist — don't confuse them:**
>
> - **Per-deployment backups (this page)** — snapshot of ONE deployment's data, managed from the dashboard, restorable into the same deployment with one click.
> - **Instance backup** (`setup.sh --backup [--to-s3=…]`) — the whole Synapse control plane: metadata Postgres, `.env`, compose file and every deployment volume in one tarball. Disaster recovery for the box itself. See the operator playbook.

---

## How a backup is made

When you click **Back up now** (or the daily scheduler fires), Synapse:

1. Inserts a `deployment_backups` row (`pending`) and enqueues a job on the same durable queue that provisioning uses — a control-plane restart doesn't lose it.
2. A worker spins up a **throwaway CLI container** (`node:22-alpine`) on the deployments network and runs `npx convex export` against the deployment's backend, authenticated with its admin key.
3. The resulting zip lands on the shared **`synapse-backups`** Docker volume as `<deployment-id>/<backup-id>.zip`, the row flips to `complete` with the archive size, and the transient container is removed.

The export is taken from the **live backend**, so it's a consistent snapshot — no need to stop the deployment. Failures mark the row `failed` with the error text and **never** touch the deployment's own status.

## Restore — read this before clicking

Restore feeds the archive back with `convex import --replace`: the deployment's **current data is replaced wholesale** with the snapshot. Anything written after the backup was taken is gone. There is no undo — the dashboard makes you confirm, and the API gates it at **project admin**.

The deployment keeps running through the restore (it's an import, not a container rebuild). For HA deployments the import lands on one live replica; state is shared through Postgres + S3, so all replicas see it.

After a restore the row shows **restored <time>** so you can tell which archive was last applied.

## Daily schedule + retention

Per deployment, in the **Backups** panel:

- **Automatic backups**: `Off` or `Daily`. A server-side sweeper (multi-node safe, advisory-locked) mints one backup per UTC day. A failed attempt retries after 1 hour instead of hammering every tick.
- **Keep last `N`** (1–90): complete backups beyond the count are pruned automatically — archive deleted from disk first, then the row.

Scheduler-minted backups show **(scheduled)** in the list (no requesting user).

## The dashboard panel

Each deployment card (expanded) has a **Backups** panel:

| Action | Who | Notes |
|---|---|---|
| Back up now | members+ | one in-flight backup per deployment (`409 backup_in_progress`) |
| Download | members+ | streams the zip; same trust level as the admin key members already get via CLI credentials |
| Restore | **admins only** | destructive, confirmed; stamps `restored` when done |
| Delete | admins only | removes archive + row; in-flight rows are protected |
| Schedule / retention | admins only | takes effect on the next sweeper tick (≤10 min) |

## API surface

All under `/v1/deployments/{name}`:

```bash
# request a backup (202 — poll the list until status=complete)
curl -X POST -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backups

# list (newest first)
curl -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backups

# download the zip
curl -OJ -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backups/<id>/download

# restore (destructive — convex import --replace)
curl -X POST -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backups/<id>/restore

# delete
curl -X POST -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backups/<id>/delete

# daily schedule + retention
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"schedule":"daily","retention":7}' \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backup_settings
```

Audit actions: `requestBackup`, `restoreBackup`, `deleteBackup`, `updateBackupSettings`.

## Limitations (v1)

Each refusal has a stable error code:

- **Adopted deployments** (`409 cannot_backup_adopted`) — Synapse doesn't manage the external backend; run `npx convex export` against it directly.
- **Remote-host deployments** (`409 remote_backup_not_supported`) — the CLI container runs on the control-plane host and can't reach a remote deployment's container network yet.
- **Deployment must be running** (`409 deployment_not_running`) — the snapshot is exported from the live backend.
- Archives live on the control-plane host's `synapse-backups` volume — they are **not** copied off-box. For off-site copies, download the zips or include the volume in your instance-level backup routine.

## Troubleshooting

- **Backup stuck on `pending`/`running` for over an hour** → the sweeper times it out to `failed`. Check `docker logs synapse-api` for the export error (admin keys are redacted).
- **`failed` with "archive missing after export"** → the CLI container exported but the file never landed on the volume; check disk space and that `synapse-backups` is mounted at `/backups` in `synapse-api`.
- **Download says `archive_missing`** → the zip was pruned by retention or the volume was replaced; the row is stale — delete it.
- **First backup is slow** → the throwaway container fetches the `convex` CLI from npm on each run; expect ~30–60 s on a cold cache.
