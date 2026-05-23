# Operator playbook — every `setup.sh` mode

This is the reference for the single binary an operator interacts with on the VPS: `setup.sh`. Every lifecycle action — install, upgrade, backup, restore, uninstall, logs, status, reconfigure — is a flag on it.

Each invocation tees stdout+stderr into `/tmp/synapse-install.log` (override with `SYNAPSE_INSTALL_LOG`). Lifecycle actions also append a per-action audit trail to the install dir.

`--version` and `--help` exit without writing logs or acquiring the flock at `/var/lock/synapse-installer.lock`. Everything else is single-instance per host.

## Install (first run)

Two entry points, identical end state:

```bash
# A. Hosted curl|sh (no git clone needed; clones into /tmp itself)
curl -sSf https://raw.githubusercontent.com/Iann29/convex-synapse/main/setup.sh \
  | bash -s -- --domain=synapse.example.com

# B. After `git clone`
./setup.sh --domain=synapse.example.com
```

Phases in order: `wizard` → `autoinstall_docker` → `preflight` → `install_deps` → `install_dir` → `secrets` → `install_updater` → `caddy` → `compose_up` → `verify` → `success_screen`.

Key flags:

| Flag | What it does |
|---|---|
| `--domain=<host>` | TLS via Caddy + Let's Encrypt; required for non-interactive |
| `--base-domain=<host>` | Per-deployment subdomains; needs wildcard DNS |
| `--acme-email=<addr>` | Let's Encrypt email; defaults to `admin@<domain>` |
| `--enable-ha` | Activates the `ha` compose profile (backend-postgres + minio) |
| `--no-tls` | Skip Caddy entirely |
| `--skip-dns-check` | Skip preflight DNS A-record probe |
| `--non-interactive` | No prompts |
| `--install-dir=<path>` | Override `/opt/synapse` |
| `--no-bootstrap` | Skip the curl-pipe self-clone re-exec |

`phase_verify` runs a register → team → project → deployment self-test, then `TRUNCATE users CASCADE` so the dashboard's first-run wizard at `/setup` fires. `SYNAPSE_VERIFY_KEEP=1` keeps the demo admin.

## `--upgrade` — auto-detect latest, snapshot-rollback on failure

```bash
./setup.sh --upgrade                       # latest GitHub release
./setup.sh --upgrade --ref=v1.10.0         # pin a tag
./setup.sh --upgrade --ref=feat/foo        # branch tip
./setup.sh --upgrade --force               # re-run even when already on latest
```

Target ref priority: explicit `--ref=` > `tag_name` from `GET https://api.github.com/repos/Iann29/convex-synapse/releases/latest` (5s timeout) > `main`.

Flow: snapshot images → clone target → rsync (preserving `.env`/`Caddyfile`/`upgrade.log`) → re-exec under new code → `secrets::ensure_env` tops up new keys → `phase_install_updater` refreshes the daemon → pre-pull pinned images → stamp `SYNAPSE_VERSION` in `.env` BEFORE the build (otherwise BuildKit cache-hits) → `compose up -d --build` → wait up to `LIFECYCLE_HEALTH_TIMEOUT` (180s) for `/health`. On build/health failure: re-tag snapshot images, restore previous version stamp, exit 2.

Audit trail at `$INSTALL_DIR/upgrade.log`.

## `--backup` — local + optional S3 off-host

```bash
./setup.sh --backup
./setup.sh --backup --out=/var/backups/synapse-2026-05.tar.gz
./setup.sh --backup --exclude-env
./setup.sh --backup --to-s3=s3://my-bucket/synapse/
```

Default output: `$INSTALL_DIR/backups/synapse-backup-<UTC>.tar.gz`. Archive (`synapse-backup-v1` format):

```
manifest.txt              format=synapse-backup-v1, timestamp, version, env_included, volume=...
.env                      (omitted with --exclude-env)
docker-compose.yml
synapse.sql.gz            pg_dump --clean --if-exists of the metadata DB
volumes/synapse-data-*.tar.gz   one tarball per per-deployment volume
```

pg_dump runs inside `synapse-postgres` via `docker exec` with `set -o pipefail`. Per-deployment volumes mounted read-only into `busybox:stable` sidecar.

### S3 + S3-compatible

`--to-s3=` is `s3://bucket/key`. Trailing slash treats as directory + appends basename. Requires:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
```

For Backblaze B2 / Cloudflare R2 / Wasabi / MinIO:

```bash
export SYNAPSE_BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
```

Upload via `curl --aws-sigv4` (curl 7.75+) — no aws CLI dependency. Local tarball kept after upload (safety net). Audit trail at `$INSTALL_DIR/backup.log`.

## `--restore=<archive>` — local or `s3://`

```bash
./setup.sh --restore=/var/backups/synapse-2026-05.tar.gz
./setup.sh --restore=s3://my-bucket/synapse/snap-1.tar.gz
./setup.sh --restore=/path/to/backup.tar.gz --keep-env
```

S3 auto-downloaded to temp file. Without `--non-interactive`, operator gets `[y/N]` confirm.

Flow: extract → validate `manifest.txt` → force-stop synapse-managed deployment containers → `compose down` → restore `.env` (unless `--keep-env`) → for each `volumes/*.tar.gz`: `docker volume rm` + recreate + extract via busybox → wipe pgdata by suffix-match → `compose up -d postgres`; wait up to 90s for `SELECT 1` → `gunzip` dump + `psql -v ON_ERROR_STOP=1 < file` (the `<` is load-bearing) → `compose up -d`; wait up to 120s for `/health`.

Audit trail at `$INSTALL_DIR/restore.log`.

## `--uninstall` — pre-backup mandatory by default

```bash
./setup.sh --uninstall
./setup.sh --uninstall --skip-backup
./setup.sh --uninstall --keep-volumes
./setup.sh --uninstall --non-interactive
```

Default flow: run `lifecycle::backup` to `/tmp/synapse-uninstall-backup-<UTC>.tar.gz` (override with `--backup-out=`) → force-stop managed containers → `compose down` → wipe `synapse-data-*` + `*synapse-pgdata` (unless `--keep-volumes`) → strip `# BEGIN synapse` block from `/etc/caddy/Caddyfile` → `rm -rf` install dir.

Default-wipe is deliberate: pgdata encrypted with `.env`'s `POSTGRES_PASSWORD`; synapse-data carries admin keys whose secrets live in postgres rows. Without `.env` (which lives in the install dir you're nuking), the volumes are unusable. Recovery: backup → re-install → `--restore=<backup>`.

## `--logs=<component> [--follow] [--tail=<n>]`

```bash
./setup.sh --logs=synapse                # last 200 lines
./setup.sh --logs=synapse --follow
./setup.sh --logs=dashboard --tail=500
```

Validated components: `synapse`, `dashboard`, `postgres`, `caddy`, `convex-dashboard`, `convex-dashboard-proxy`. Stream straight to stdout — pipe to `less`/`grep` works.

## `--status` — read-only diagnostic

```bash
./setup.sh --status
```

No mutations. Exits `0` healthy, `1` degraded, `2` broken.

Renders: version, public URL, custom-domain base, every compose container with state + image, managed deployment count + names, volumes matching `synapse-data-*` and `*synapse-pgdata`, DNS comparison, TLS cert expiry (warn <14d, fail expired), disk usage on `/var/lib/docker`.

## `--doctor` — preflight against existing install

```bash
./setup.sh --doctor
```

Re-runs preflight checks without mutating. Useful first thing for "is the host happy".

## `--reconfigure` — change public host without re-install

```bash
./setup.sh --reconfigure --domain=new.example.com
./setup.sh --reconfigure --no-tls
./setup.sh --reconfigure --base-domain=apps.example.com
./setup.sh --reconfigure --domain=new.example.com --acme-email=ops@new.example.com
```

`--domain` and `--no-tls` mutually exclusive; at least one of `--domain`/`--no-tls`/`--base-domain` required. Touches only `.env` and `Caddyfile` — never Postgres, deployments, or schema.

Flow validates rendered Caddyfile inside a throwaway `caddy:2-alpine` (`caddy validate`) before promoting. Dashboard rebuilt because Next.js inlines `NEXT_PUBLIC_*` at build time.

Audit trail at `$INSTALL_DIR/reconfigure.log`.

## Log file map

| Action | Log file |
|---|---|
| All phases | `$SYNAPSE_INSTALL_LOG` (default `/tmp/synapse-install.log`) |
| `--upgrade` | `$INSTALL_DIR/upgrade.log` |
| `--backup` | `$INSTALL_DIR/backup.log` |
| `--restore` | `$INSTALL_DIR/restore.log` |
| `--reconfigure` | `$INSTALL_DIR/reconfigure.log` |
| `--uninstall` | Inherits install log; pre-uninstall backup line lands in the in-progress backup log |
| `--logs`, `--status`, `--doctor` | No log — stream/stdout only |
| Self-update daemon (per upgrade run) | `/var/log/synapse-updater/<UTC>.log` |
| Self-update daemon (per host-domain reconfigure) | `/var/log/synapse-updater/reconfigure-<UTC>.log` |
| Self-update daemon (process journal) | `journalctl -u synapse-updater` |
