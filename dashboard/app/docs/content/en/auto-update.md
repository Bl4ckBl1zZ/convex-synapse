# Auto-update from the dashboard

Synapse can upgrade itself in-place from the dashboard without the operator having to SSH. This page explains how that works end-to-end.

## What the operator sees

The `UpdateBanner` component (`dashboard/components/UpdateBanner.tsx`) polls `GET /v1/admin/version_check` once an hour. When the API reports `updateAvailable: true`, an amber banner appears at the top of `/teams/<ref>` with "Synapse vX.Y.Z is available — you're on vA.B.C".

Two actions: **Review & upgrade** opens the dialog; **Dismiss** persists the new version to `localStorage["synapse-update-dismissed"]` so the banner doesn't re-appear for that release on this browser.

Permissions: when `/version_check` returns 401 or 403, the banner renders nothing.

## Tier-1 honesty: who's an "admin"?

The check is `users.is_instance_admin = true` (the `requireInstanceAdmin` middleware in `synapse/internal/api/admin.go`). The first user registered after install is promoted automatically; later team admins do not inherit instance-admin just by owning a team. Promotion for additional admins is a manual SQL update on `users.is_instance_admin`.

## Version check: cached GitHub fetch

`GET /v1/admin/version_check` returns:

```json
{
  "current": "1.10.0",
  "latest": "1.10.1",
  "updateAvailable": true,
  "releaseUrl": "https://github.com/Iann29/convex-synapse/releases/tag/v1.10.1",
  "releaseNotes": "...",
  "publishedAt": "2026-05-21T...",
  "fetchedAt": "2026-05-22T...",
  "cacheExpiresAt": "2026-05-22T...",
  "fromCache": false
}
```

The backend fetches `https://api.github.com/repos/Iann29/convex-synapse/releases/latest` once every 15 minutes. With the dashboard polling hourly and GitHub's unauthenticated rate limit at 60 req/hour, a single instance stays well under the ceiling.

`POST /v1/admin/version_check/refresh` busts the cache (rate-limited to one bust per 30s). Pre-release and draft releases are ignored. Semver comparison uses `golang.org/x/mod/semver`.

## The upgrade itself

When the operator clicks **Continue → Upgrade now**, the dashboard POSTs `/v1/admin/upgrade`. The Synapse API:

1. Probes `/healthz` on the updater daemon (2s timeout). If unreachable → `503 updater_unreachable`.
2. Forwards the request body (`{"ref": "..."}`) to the daemon at `POST <UpdaterURL>/upgrade` with `Authorization: Bearer <UpdaterToken>`.
3. Re-wraps the daemon's `{"error": "..."}` errors into Synapse's `{"code", "message"}` envelope. Common codes: `upgrade_in_progress` (409), `invalid_ref` (400), `invalid_json` (400).
4. Records an `upgradeStarted` audit event with `metadata.ref` and `metadata.currentVersion`.

The dialog enters polling mode and hits `/v1/admin/upgrade/status` every 2.5 seconds. While the upgrade is `running`, the daemon refreshes the log tail at request time so the dashboard sees streaming output without server push.

### Reload on synapse-api restart

The synapse-api container itself is recreated during the upgrade — at that point the dashboard's `/status` polls start failing. After **3 consecutive failures**, the dialog flips into `rebooting` state and shows "Synapse API is restarting; the page will reload automatically (~90s)". A `setTimeout` calls `window.location.reload()` after 90 seconds.

`sessionStorage["synapse-upgrade-in-progress"]` is set when the operator confirms; on a page reload the dialog detects the marker and resumes polling. Stale markers (>30 minutes) are auto-cleared.

Final states: `success` → green "✓ Synapse upgraded" with reload button; `failed` → red banner pointing the operator to `./setup.sh --doctor` and showing the full log tail.

## Architecture: the synapse-updater daemon

The piece that actually orchestrates the upgrade lives **outside** docker compose, in a tiny Python 3 HTTP daemon:

- **Binary:** `/usr/local/bin/synapse-updater` (installed by `phase_install_updater` in `installer/install/updater.sh`)
- **Systemd unit:** `/etc/systemd/system/synapse-updater.service`
- **Source:** `installer/updater/synapse-updater`

### Why outside docker compose

`setup.sh --upgrade` runs `docker compose up -d --build`, which would recreate the updater itself if it lived in compose — killing the process orchestrating the upgrade. Living on the host as a systemd unit means the updater survives the rebuild it triggers.

### Why TCP localhost + bearer token (not unix socket)

Pre-v1.5.1 the daemon listened on `/run/synapse/updater.sock` and was bind-mounted into the synapse-api container. Two problems: `/run` is tmpfs (wiped on reboot, broke the bind-mount on every reboot); bind-mounts pin to inode (don't survive a daemon restart).

The TCP-localhost+bearer-token design dodges the bind-mount lifecycle entirely. Synapse API reaches the daemon via `host.docker.internal:8089`. The systemd unit binds `0.0.0.0` (NOT `127.0.0.1`) — `host.docker.internal` inside the container resolves to the docker-bridge IP (typically `172.17.0.1`), not loopback.

The operator's cloud-provider firewall MUST block port 8089 from the public internet. The bearer token is defense-in-depth.

### Endpoints

All require `Authorization: Bearer <SYNAPSE_UPDATER_TOKEN>`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | `{"ok": true}` |
| GET | `/version` | Reads `$INSTALL_DIR/VERSION`, falls back to `git describe`, then `unknown` |
| GET | `/status` | Last known upgrade state. While running, refreshes log tail at request time |
| POST | `/upgrade` | `{"ref": "v1.2.0"}` (optional). 202 starts; 409 if already running |
| POST | `/reconfigure_host_domain` | `{"jobId", "domain"?, "baseDomain"?, "plainHttp"?, "acmeEmail"?}` |

### State files

```
/var/lib/synapse-updater/status.json              last known upgrade state
/var/lib/synapse-updater/upgrade.lock             present while an upgrade child is running
/var/lib/synapse-updater/reconfigure.lock         present while a reconfigure child is running
/var/log/synapse-updater/<UTC>.log                full log of the last/current upgrade
/var/log/synapse-updater/reconfigure-<UTC>.log    full log of the last/current reconfigure
```

The lock files are the source of truth for single-flight gating.

### The `SYNAPSE_UPDATER_NO_RESTART=1` flag

When the daemon forks `setup.sh --upgrade`, it sets `SYNAPSE_UPDATER_NO_RESTART=1` in the child's environment. `phase_install_updater` checks this and **skips** the `systemctl restart synapse-updater` step — otherwise the daemon would kill itself mid-upgrade.

The on-disk daemon binary is still refreshed; the operator manually runs `systemctl restart synapse-updater` after a successful upgrade to pick up daemon-binary changes.

### Running as root

`User=root` in the systemd unit. Notably **not** `ProtectHome=true` — the daemon forks `setup.sh` which forks `docker compose up --build`, which calls `docker buildx` which insists on creating `/root/.docker/`. With `ProtectHome=true` the unit's `/root` is read-only and buildx fails.

What IS enabled: `PrivateTmp=true`, `ProtectKernelTunables=true`, `ProtectKernelModules=true`, `ProtectControlGroups=true`, `RestrictSUIDSGID=true`, `SystemCallArchitectures=native`.

## Audit trail

Every dashboard-initiated upgrade records `upgradeStarted` in `audit_events`:

```json
{
  "action": "upgradeStarted",
  "target_type": "synapse",
  "actor_id": "<user-uuid>",
  "metadata": {
    "ref": "v1.10.1",
    "currentVersion": "1.10.0"
  }
}
```

`upgradeStarted` captures "the operator pressed the button". The actual setup.sh exit code lives in the daemon's `status.json` and the per-run log file — there's no separate `upgradeSucceeded` audit row.
