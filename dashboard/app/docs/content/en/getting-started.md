# Getting started

Synapse is an open-source control plane for self-hosted Convex. It re-implements the public subset of Convex Cloud's "Big Brain" management API — teams, projects, deployments, env vars, audit log, CLI auth — on top of infrastructure you own. One VPS, one `setup.sh`, and you have a dashboard that provisions real Convex backend containers in seconds.

This page is the only one you need to land on a working install.

## Prerequisites

Synapse runs on a single Linux VPS. The installer's pre-flight (`installer/install/preflight.sh`) checks the following and aborts if any hard requirement is missing:

| Requirement | Minimum | Notes |
|---|---|---|
| OS | Debian / Ubuntu / Fedora / RHEL family | Arch, Alpine, openSUSE work with a yellow warning |
| Architecture | `amd64` or `arm64` | The upstream Convex backend image is built for these only |
| Docker | 20.10+ | The installer offers to run `curl -fsSL https://get.docker.com \| sh` for you |
| Docker Compose | v2 plugin | Legacy `docker-compose` v1 is not supported |
| RAM | 2 GB | 1–2 GB warns; below 1 GB fails |
| Disk | 10 GB free on `/` | Override with `SYNAPSE_DISK_GB_MIN` |
| Sudo / root | Required | The installer needs to start containers and (optionally) edit a host Caddyfile |
| Outbound network | `ghcr.io` reachable | The Convex backend image is ~150 MB and lives there |
| Ports | 80, 443 (with `--domain`); 8080 (API), 6790 (dashboard), 6791 (Convex UI) otherwise | All overridable via env vars |

A registered domain is **optional** — you can install without TLS using `--no-tls` and reach the dashboard at `http://<public-ip>:6790`. For anything close to production, point a real hostname at the box first.

## The hosted one-liner (wizard)

Run this on a fresh VPS. With no flags, the installer drops you into an interactive 4-step Q&A walkthrough (`installer/install/wizard.sh`) covering domain + TLS, deployment mode, install location and missing dependencies.

```bash
curl -sSf https://raw.githubusercontent.com/Iann29/convex-synapse/main/setup.sh | bash
```

The wizard reads from `/dev/tty` so it works under `curl | bash` (where stdin is the script, not your keyboard). Numbered menus — no arrow keys, portable across every shell.

If Docker is missing, the wizard offers to install it for you via `get.docker.com` before pre-flight runs.

## The hosted one-liner (non-interactive, with flags)

Skip the wizard by passing any mode-defining flag. The forwarded args go after `bash -s --`:

```bash
# Single-VPS install with TLS via Caddy + Let's Encrypt
curl -sSf https://raw.githubusercontent.com/Iann29/convex-synapse/main/setup.sh \
  | bash -s -- --domain=synapse.example.com

# Local-only / lab install, no TLS
curl -sSf https://raw.githubusercontent.com/Iann29/convex-synapse/main/setup.sh \
  | bash -s -- --no-tls --skip-dns-check --non-interactive
```

Under `curl | bash`, the script detects that the `installer/` library tree isn't next to it and self-clones into `/tmp/convex-synapse-bootstrap-<pid>` (or `~/.synapse-bootstrap-<pid>` if `/tmp` isn't writable), then re-execs itself from the clone. Every flag you passed is preserved.

## Install flags worth knowing

The full surface is in `setup.sh --help`; here is the install-time subset:

| Flag | What it does |
|---|---|
| `--domain=<host>` | Public hostname for Synapse. Caddy auto-issues a Let's Encrypt cert. Required for non-interactive TLS installs. |
| `--base-domain=<host>` | Wildcard subdomain for per-deployment URLs (`<name>.<base>`). Requires `*.<host>` DNS pointed at the VPS; Caddy uses on-demand TLS to issue per-deployment certs lazily. |
| `--acme-email=<addr>` | Let's Encrypt account email. Defaults to `admin@<domain>`. |
| `--no-tls` | Skip Caddy / TLS setup. Use when another ingress fronts Synapse or for lab installs. |
| `--skip-dns-check` | Skip the A-record / public-IP comparison in pre-flight. Useful while DNS is propagating. |
| `--enable-ha` | Bring up the bundled Postgres + MinIO behind Synapse so HA deployments work out of the box. |
| `--install-dir=<path>` | Override `/opt/synapse`. Honoured by every subsequent lifecycle command on the same install. |
| `--non-interactive` | Disable all prompts. Combine with `--domain=` or `--no-tls`. |
| `--no-bootstrap` | Skip the curl-pipe self-clone re-exec. Useful when running from a manual `git clone`. |

The `--upgrade`, `--backup`, `--restore`, `--reconfigure`, `--uninstall`, `--logs`, `--status` and `--doctor` flags are for the post-install lifecycle and are documented separately.

## What the installer actually does

Each phase has its own `CURRENT_STEP` label; if anything crashes, the on-error trap tells you which phase died and where the full log lives. The phases run in this order (`setup.sh::main`):

1. **`wizard`** — only when no mode flags were passed; gathers domain, TLS, mode and install dir interactively.
2. **`autoinstall_docker`** — runs `get.docker.com` when the wizard agreed (or non-interactive root with Docker missing).
3. **`preflight`** — every check from `installer/install/preflight.sh`. Runs all checks even on failure so you see every issue at once.
4. **`install_deps`** — installs `jq`, `curl` and `dig` via the host package manager when missing (apt/dnf/pacman/apk).
5. **`install_dir`** — creates `INSTALL_DIR` (default `/opt/synapse`) and copies the repo into it.
6. **`secrets`** — generates a JWT secret, Postgres password and updater token; renders `installer/templates/env.tmpl` to `.env` (mode `0600`). Idempotent on re-runs: existing secrets are preserved.
7. **`install_updater`** — drops the `synapse-updater` Python 3 daemon as a systemd unit so the dashboard's one-click upgrade can later rebuild the stack.
8. **`caddy`** — detects whether Caddy or nginx is already running on the host. If Caddy is present, appends a managed block to `/etc/caddy/Caddyfile` and backs the old one up. If nothing is present, writes a standalone `Caddyfile` and turns on the `caddy` compose profile. nginx hosts get a printed snippet to paste manually.
9. **`compose_up`** — `docker compose up -d --build` (plus `--profile caddy` and/or `--profile ha` as needed), waits up to 60 s for `/health`, then pre-pulls the pinned Convex backend image so the first deployment-create doesn't stall on a cold ~150 MB download.
10. **`verify`** — runs a register → team → project → deployment self-test against the live API. After it passes, the installer truncates the `users` table so the dashboard's first-run wizard fires when you open it. Set `SYNAPSE_VERIFY_KEEP=1` to keep the demo admin instead.
11. **`success`** — prints a green banner with the URL to open and a cheat-sheet of follow-up commands.

The full installer output is teed to `/tmp/synapse-install.log` (or the path in `SYNAPSE_INSTALL_LOG`).

## After install — opening the dashboard

The success banner shows you the URL. Resolved in this order:

- `--domain=<host>` set → `https://<host>` (Caddy fronts the dashboard, API and Convex UI).
- No domain but public IP detected → `http://<public-ip>:6790`.
- Neither → `http://localhost:6790` (lab-only; remote browsers will fail because the bundled JS calls the API at the host you opened).

Open the URL and you'll land on `/login`. The page first calls `GET /v1/install_status` (a public, unauthenticated probe at `synapse/internal/api/install_status.go`). When the response is `{"firstRun": true, "version": "..."}` the dashboard replaces to `/setup` and starts the first-run wizard:

1. Loading.
2. Create the admin user (`POST /v1/auth/register`).
3. Bootstrap a `Default` team and a `demo` project with a dev deployment.
4. Drop you on the project page with the deployment row already visible.

`firstRun` is true exactly when the `users` table is empty (a cheap `SELECT EXISTS (SELECT 1 FROM users)`). The verify phase truncates `users` after its self-test passes, which is what guarantees the wizard fires on a fresh install.

## What lands on disk

Default `INSTALL_DIR` is `/opt/synapse` (overridable with `--install-dir=`). After install you have:

```
/opt/synapse/
  setup.sh                 # re-runnable for lifecycle (upgrade/backup/restore/...)
  docker-compose.yml
  .env                     # generated secrets, mode 0600 — DO NOT lose this
  Caddyfile                # only when the bundled Caddy is in use (no host Caddy)
  installer/               # the lib tree the script dot-includes
  synapse/, dashboard/, …  # the rest of the repo
  backups/                 # default output of --backup (timestamped tarballs)
```

The `.env` file holds every secret. The `--uninstall` command will refuse to drop your data without taking a pre-uninstall backup first, but the `.env` itself is your sole copy of the JWT and Postgres credentials — back it up out-of-band if you cannot afford to lose past sessions.

The Synapse install log lives at `/tmp/synapse-install.log` (or `SYNAPSE_INSTALL_LOG`); per-command audit trails live at `$INSTALL_DIR/{upgrade,backup,restore}.log`.

## Smoke check

Once the dashboard wizard finishes you can verify Synapse end-to-end:

```bash
# Containers managed by Synapse carry this label
docker ps --filter label=synapse.managed=true

# API health
curl -sf http://localhost:8080/health

# Read-only diagnostic snapshot (containers, volumes, public URL, TLS expiry, disk)
sudo /opt/synapse/setup.sh --status

# Re-run pre-flight against the existing install, no mutations
sudo /opt/synapse/setup.sh --doctor
```

If everything is green, you are done — create a team, create a project, click **New deployment**, and Synapse will spin up a fresh Convex backend in a few seconds.
