# API reference

Synapse implements (a subset of) Convex Cloud's stable
[Management API v1](https://github.com/get-convex/convex-backend/blob/main/npm-packages/dashboard/dashboard-management-openapi.json).
Endpoints below are grouped by resource. Compatibility with the OpenAPI spec
is noted as ✅ (matches), 🔧 (custom — Synapse extension), or 📍 (Cloud-style
endpoint with a smaller payload).

All authenticated endpoints expect `Authorization: Bearer <token>` where the
token is either:
- A JWT issued by `/v1/auth/login` (24-hour lifetime by default — operators leave dashboards open all day; refresh TTL stays the real session boundary), or
- A `syn_*` opaque personal-access token (created via the dashboard's
  `/me` page or via `POST /v1/create_personal_access_token` — see below).

## Health

### `GET /health`

Returns `{status, version, database}`. Status is `ok` or `degraded`.

## Auth (custom — Cloud has WorkOS OAuth flows we don't replicate)

### `POST /v1/auth/register` 🔧

Body: `{email, password, name?}`. 8-char min password.
Returns: `{accessToken, refreshToken, tokenType:"Bearer", expiresIn, user}`.
On an empty instance, the first registered user is promoted to
`user.isInstanceAdmin=true`; later users do not inherit instance-admin
rights from team or project roles.

### `POST /v1/auth/login` 🔧

Body: `{email, password}`. Same response shape as register.

### `POST /v1/auth/refresh` 🔧

Body: `{refreshToken}`. Returns a new token pair. Refresh tokens issued
**before** the account's last password change are refused with 401
`invalid_refresh` (the stateless-JWT equivalent of "reset signs out old
sessions"); access tokens already in flight keep their ≤15-minute tail.

### `POST /v1/auth/forgot_password` 🔧 (v1.25+, anonymous)

Body: `{email}`. **Always** answers `200 {ok:true}` with an identical body
— whether the account exists, email is configured, or the per-account cap
was hit. Anything else would be a user-enumeration oracle; the email send
itself is detached so Resend latency can't leak it either.

When the account exists AND a sender is configured (Admin → Email or the
`.env` fallback) AND `SYNAPSE_PUBLIC_URL` is set, a single-use
`syn_reset_…` token is minted (sha256 stored, 1-hour expiry, max 3 active
per account) and emailed as `<PublicURL>/reset-password?token=…`. Default
installs without email answer 200 and mint nothing — the instance admin
remains the manual fallback.

### `POST /v1/auth/reset_password` 🔧 (v1.25+, anonymous)

Body: `{token, newPassword}`. Validates the token (unused + unexpired →
else 400 `invalid_token`), enforces the 8-char minimum (400
`weak_password` — without consuming the token, so the link survives a
typo), then in one transaction: updates the hash, stamps
`users.password_changed_at` (revoking pre-reset refresh tokens), marks the
token used and deletes the account's other outstanding reset links.
Audited as `passwordReset`.

## Profile

### `GET /v1/me` ✅ (alias `/v1/profile`)

Returns the authenticated user.

### `PUT /v1/update_profile_name` ✅ (alias `/v1/me/update_profile_name`)

Body `{name}`. Updates the caller's display name and returns the refreshed
user shape. Empty/whitespace name is rejected with 400 `missing_name`.

### `POST /v1/delete_account` ✅ (alias `/v1/me/delete_account`)

Deletes the caller's account. Refused with 409 `last_admin` when the user
is the last admin of any team they belong to (the cascade would orphan
it), or 409 `team_creator` when they are the `creator_user_id` of any
existing team (`teams.creator_user_id` is `ON DELETE RESTRICT`).
Workaround for both: delete (or transfer creation of) the team(s) first
via `POST /v1/teams/{ref}/delete`. Cascades the user's team membership
rows; audit_events.actor_id and projects.creator_user_id `SET NULL`.

### `GET /v1/member_data` ✅ (alias `/v1/me/member_data`)

Returns `{teams, projects, deployments, optInsToAccept}`. Saves three
round-trips for the cloud dashboard's "load my world" path. Self-hosted
operators have no opt-ins, so `optInsToAccept` is always `[]`.

### `GET /v1/optins` ✅

Returns `{optInsToAccept: []}`. Self-hosted operators don't agree to
Convex Cloud's TOS or marketing opt-ins; the operator owns the box.

## Instance admin

These endpoints are host-wide and require `user.isInstanceAdmin=true`.
Being `admin` on a team or project does not grant access. Existing installs
are migrated with the oldest user promoted as the initial instance admin;
new installs promote the first registered user.

### `GET /v1/admin/version_check` 🔧

Returns `{current, latest?, updateAvailable, releaseUrl?, releaseNotes?,
publishedAt?, fetchedAt?, error?}`. Checks GitHub Releases `/latest` with a
15-minute cache. On upstream failure and no cached release, returns 200 with
`current` plus `error` so the dashboard can fail soft.

### `POST /v1/admin/upgrade` 🔧

Body `{ref?}`. Starts the host-side updater daemon via unix socket and
returns the daemon response, usually `{started:true, ref}` with HTTP 202.
Returns 503 `updater_unavailable` / `updater_unreachable` when the daemon is
not configured or not running.

### `GET /v1/admin/upgrade/status` 🔧

Returns the updater daemon's current state/log tail, or `{state:"unavailable",
error}` when the daemon cannot be reached.

### `GET /v1/admin/headscale` 🔧 (v1.19+)

Returns the current Headscale / Remote Hosts state:
`{enabled, configured, remoteProvisioningReady, needsApiRestart,
updaterAvailable, updaterReason?, domain?, serverUrl?, internalUrl?,
baseDomain?, hostDomain?, publicUrl?, publicIp?, defaultDomain?,
dnsCredentialAvailable}`. `enabled` is the live signal (runtime
Headscale client wired); `configured` is the on-disk intent
(`SYNAPSE_HEADSCALE_*` stamped in `.env`); `needsApiRestart` is true
when configured but not yet enabled (operator just ran configure,
synapse-api hasn't picked up the env yet). `defaultDomain` is what
the dashboard pre-fills in the configure form — prefers
`headscale.<SYNAPSE_DOMAIN>` over `headscale.<SYNAPSE_BASE_DOMAIN>`
so a deployments wildcard doesn't trap the Headscale cert.

### `POST /v1/admin/headscale/configure` 🔧 (v1.19+)

Body `{headscaleDomain?, autoConfigureDns?}`. Validates the requested
hostname (or falls back to `defaultDomain`), optionally upserts the
matching A record via a stored Cloudflare credential, inserts a
`configure_headscale` row in `admin_jobs`, and dispatches the
synapse-updater daemon's `POST /configure_headscale`. Returns 202
`{jobId, statusUrl, state:"queued", domain, serverUrl, dnsAuto?}`.
Refuses with `400 host_domain_required` when no SYNAPSE_DOMAIN /
SYNAPSE_BASE_DOMAIN / explicit override is configurable, `503
updater_unreachable` when the daemon is down, `409
configure_in_progress` when another configure job is already
running on the host.

### `GET /v1/admin/headscale/status/{jobID}` 🔧 (v1.19+)

Returns the same shape as `/v1/admin/host_domain/status/{jobID}`:
`{id, state, log, error?, createdAt, startedAt?, finishedAt?}`. The
row is filtered to `kind='configure_headscale'`, so a host-domain
job id 404s here.

### `GET /v1/admin/email_settings` 🔧 (v1.22+, instance admin)

Returns the instance transactional-email (Resend) config:
`{configured, source, provider, fromAddress, updatedAt}`. `source` is `db`
(set via this endpoint, encrypted at rest), `env` (host `.env` fallback —
`SYNAPSE_RESEND_API_KEY` + `SYNAPSE_EMAIL_FROM`), or `none`. The plaintext
API key is **never** returned.

### `POST /v1/admin/email_settings` 🔧 (v1.22+, instance admin)

Body `{apiKey, fromAddress}`. Encrypts + stores the Resend key (singleton —
one instance-wide config) and returns the same shape as GET. Requires
`SYNAPSE_STORAGE_KEY` (503 `crypto_not_configured` otherwise — we won't
persist the key in plaintext). The DB config wins over the `.env` fallback
and takes effect on the next invite (no restart).

### `DELETE /v1/admin/email_settings` 🔧 (v1.22+, instance admin)

Clears the stored key; email reverts to the `.env` fallback (or `none`).

### `GET /v1/admin/alert_settings` 🔧 (v1.25+, instance admin)

Returns the deployment-down alert config:
`{source, emailEnabled, webhookConfigured, webhookHint, updatedAt}`.
`source` is `db` (saved via this endpoint — wins entirely, even with an
empty webhook), `env` (host `.env` fallback — `SYNAPSE_ALERT_WEBHOOK_URL`),
or `default` (nothing set: email alerts on whenever email is configured,
no webhook). The full webhook URL is **never** returned — Slack/Discord
hook paths embed a secret — only a masked `webhookHint` (scheme + host).

When the health worker flips a deployment to `stopped`/`failed` it fires
both channels best-effort: email to the owning team's **admins** (riding
the `email_settings` Resend config) and a webhook POST whose JSON carries
both `text` (Slack) and `content` (Discord) plus structured
`{event, status, previousStatus, deployment, project, team, dashboardUrl,
occurredAt}` fields, so one URL works for Slack, Discord, and custom
receivers. Alerts fire only on the state **transition** (one per down
event, no per-sweep spam), and a blip that auto-restart already recovered
never alerts.

### `POST /v1/admin/alert_settings` 🔧 (v1.25+, instance admin)

Body `{emailEnabled, webhookUrl?}`. Upserts the singleton row and returns
the same shape as GET. `webhookUrl` semantics: **absent** = keep the saved
webhook (GET never returns it, so a client can't resend it), **empty** =
clear it (silences the `.env` fallback too — the row wins), **non-empty**
= replace (must be absolute http(s); 400 `invalid_webhook_url` otherwise).
Takes effect on the next health sweep — no restart. No
`SYNAPSE_STORAGE_KEY` requirement.

### `DELETE /v1/admin/alert_settings` 🔧 (v1.25+, instance admin)

Deletes the row; alerting reverts to the `.env` fallback / defaults.

## Teams

### `POST /v1/teams/create_team` ✅

Body: `{name, defaultRegion?}`. Returns the new `Team`. Slug auto-generated.

### `GET /v1/teams` 🔧

Lists teams the caller belongs to.

### `GET /v1/teams/{ref}` ✅

`ref` is either the UUID or the slug. Returns `Team`.

### `POST /v1/teams/{ref}` ✅ (admins only)

Update team. Body `{name?, slug?, defaultRegion?}` — every field optional.
Slug uniqueness is global; collision returns 409 `slug_taken`. `defaultRegion`
is stored verbatim but has no behavioural effect today (Synapse is single-
region; the field exists for parity with the cloud dashboard's region picker).

### `POST /v1/teams/{ref}/delete` ✅ (admins only)

Delete team. Refused with 409 `team_has_deployments` when any non-deleted
deployment hangs off a project in this team — orphaning Docker containers
when their owning team disappears is worse than asking the operator to
delete them first. Once cleared, CASCADE removes projects, members, and
invites. The audit row is written before the DELETE so team_id stays
useful for "what happened in this team" queries through the moment of
deletion.

### `POST /v1/teams/{ref}/update_member_role` ✅ (admins only)

Body `{memberId, role}`. Role accepts `admin`, `member`, or the cloud
alias `developer` (mapped → member). Refuses with 409 `last_admin` when
demoting the only admin. The check + UPDATE run inside `SELECT FOR UPDATE`
so two concurrent demotions can't race past the guard.

### `POST /v1/teams/{ref}/remove_member` ✅

Body `{memberId}`. Either an admin removes any member, or any member
removes themselves. Refused with 409 `last_admin` if the target is the
only remaining admin. Audit metadata flags `selfRemoval=true` so logs
distinguish "kicked" from "left".

### `POST /v1/teams/{ref}/access_tokens` ✅ (admins only)

Body `{name, expiresAt?}`. Creates an opaque PAT scoped to this team.
Same response shape as `/v1/create_personal_access_token`. The bearer of
the resulting token can act inside this team (and any project /
deployment beneath it) but NOT in other teams. See "Token scopes" below.

### `GET /v1/teams/{ref}/access_tokens` ✅

Lists the caller's team-scoped tokens for this team (paginated:
`?limit&?cursor`).

### `GET /v1/teams/{ref}/list_projects` ✅
### `GET /v1/teams/{ref}/list_members` ✅
### `GET /v1/teams/{ref}/list_deployments` ✅

These (plus `GET /v1/teams` and `GET /v1/projects/{id}/list_deployments`) are
**bounded** lists. The response shape is still a bare JSON array (matches
Cloud's `list_*` endpoints — no breaking change for existing tools), but the
server caps each page and signals continuation via a header:

- Query `?limit=N` (default 100, max 500). Negative / non-numeric is 400
  `invalid_limit`.
- Query `?cursor=<id>` to fetch the page after the row with that id. The
  cursor must refer to a row the caller can see (a team they're a member of,
  a project in that team, etc); a bogus cursor returns 400 `invalid_cursor`.
- Response header `X-Next-Cursor: <id>` is set when more rows exist after
  this page. Absent header = end of results.

Walk pattern (shell):

```bash
NEXT=""
while :; do
  RESP=$(curl -sfD - "http://localhost:8080/v1/teams${NEXT:+?cursor=$NEXT}" \
    -H "Authorization: Bearer $TOKEN")
  echo "$RESP" | sed -n '/^\r$/,$p' | tail -n +2 | jq .
  NEXT=$(echo "$RESP" | tr -d '\r' | awk -F': ' '/^X-Next-Cursor/ {print $2}')
  [ -z "$NEXT" ] && break
done
```

### `POST /v1/teams/{ref}/create_project` ✅

Body: `{projectName, deploymentType?, deploymentClass?, deploymentRegion?}`.
Returns `{projectId, projectSlug, project}`.

### `POST /v1/teams/{ref}/invite_team_member` ✅ (admins only)

Body: `{email, role}`. Returns `{inviteId, inviteToken, email, role, emailed}`.
The token is opaque; share it with the invitee out-of-band — or, when email
is configured, let Synapse send it for you.

**Email (v1.22+):** when Resend is configured — via **Admin → Email**
(`/v1/admin/email_settings`, encrypted in the DB) or the `.env` fallback
(`SYNAPSE_RESEND_API_KEY` + `SYNAPSE_EMAIL_FROM`) — and `SYNAPSE_PUBLIC_URL`
is set (to build the link), the invitee is
emailed a clickable accept link (`<PublicURL>/accept-invite?token=...`) via
[Resend](https://resend.com). Sending is **best-effort**: the invite always
succeeds and `inviteToken` is always returned, so a missing/failed email
never blocks onboarding. `emailed` reports whether the email actually went
out (`false` when email is disabled or the provider errored).

### `GET /v1/teams/{ref}/invites` 🔧 (admins only)

Lists pending (not-yet-accepted) invites — `[{id, email, role, token, invitedBy, createTime}]`.
Tokens are sensitive: anyone who has one can join the team.

### `POST /v1/teams/{ref}/invites/{inviteID}/cancel` 🔧 (admins only)

Deletes a pending invite. 404 if it was already accepted or never existed.

### `GET /v1/teams/{ref}/audit_log` ✅ (admins only)

Lists audit events for the team, newest first. Admin-only — audit data is
privileged. Members get 403 (matches Cloud's behavior; auditing is a
trust-anchor function).

Query params:
- `limit` (default 50, max 200) — page size.
- `cursor` — opaque continuation token returned as `nextCursor` from the
  previous page.

Response (200):

```json
{
  "items": [
    {
      "id": "12",
      "createTime": "2026-04-29T12:00:00Z",
      "action": "createProject",
      "actorId": "…",
      "actorEmail": "ian@example.com",
      "targetType": "project",
      "targetId": "…",
      "metadata": { "name": "my-app", "slug": "my-app" }
    }
  ],
  "nextCursor": "…"
}
```

Action names mirror Cloud's `auditLogActions` vocabulary where it exists:
`createTeam`, `inviteTeamMember`, `cancelInvite`, `createProject`,
`deleteProject`, `renameProject`, `updateProjectEnvVars`, `createDeployment`,
`deleteDeployment`, `acceptInvite`, `login`. Synapse-specific extensions
(no Cloud counterpart): `createPersonalAccessToken`,
`deletePersonalAccessToken`. Audit writes are best-effort: a transient DB
error during the audit insert never fails the user-visible request.

### `POST /v1/team_invites/accept` 🔧

Body: `{token}`. The caller must be authenticated. Adds the user as a
member with the role recorded in the invite, marks the invite consumed,
and returns `{teamId, teamSlug, teamName, role}`. Idempotent on the
membership insert (re-accepting from a second tab is a no-op).

## Projects

### `GET /v1/projects/{id}` ✅
### `PUT /v1/projects/{id}` ✅ (admins only)

Body `{name?, slug?}` — both optional. Slug uniqueness is per-team
(`UNIQUE(team_id, slug)`); collision returns 409 `slug_taken`. The shape
must be lowercase letters / digits / dashes; otherwise 400 `invalid_slug`.
Cloud's spec returns 204; Synapse returns 200 + the updated project so
the dashboard can skip a follow-up GET.

### `POST /v1/projects/{id}/transfer` ✅ (admins of source AND destination)

Body `{destinationTeamId}`. Moves the project (and all its deployments,
env vars, audit events) to another team. Caller must be admin of BOTH
teams. 404 `team_not_found` for unknown destination, 403 `forbidden`
when caller is not admin in either team, 409 `slug_taken` when a project
with the same slug already exists in the destination. Self-transfer
(destinationTeamId == current team) returns 204 no-op. Audit fires on
both teams with `direction: in/out` metadata.

### `POST /v1/projects/{id}/delete` ✅ (project admins only)
### `GET /v1/projects/{id}/list_deployments` ✅
### `GET /v1/projects/{id}/list_default_environment_variables` ✅
### `POST /v1/projects/{id}/update_default_environment_variables` ✅ (project admins or members)

Body: `{changes: [{op:"set"|"delete", name, value?, deploymentTypes?}]}`.

Viewers (project_members.role = "viewer") can list env vars but
cannot mutate. See "Project-level RBAC" below.

### `GET /v1/projects/{id}/list_members` ✅

Returns the merged member list for the project — every team member of
the owning team, with the role they actually have on this project
(project-level override beats team fallback). Each row carries:

```json
{
  "id":         "<userId>",
  "email":      "ian@example.com",
  "name":       "Ian",
  "role":       "admin" | "member" | "viewer",
  "source":     "project" | "team",
  "createTime": "..."
}
```

`source` is `"project"` when a `project_members` override is in
effect for this user, `"team"` when their `team_members` role is
shining through. Visible to anyone with project access (viewers
included).

### `POST /v1/projects/{id}/add_member` ✅ (project admins only)

Body `{userId, role}`. Adds (or upserts) a `project_members` override
row for a user that's already a `team_members` of the project's team.
Roles: `admin`, `member`, `viewer`.

- 400 `not_team_member` — target user isn't on the project's team yet
- 400 `invalid_role` — unrecognised role string
- 403 `forbidden` — caller isn't a project admin

### `POST /v1/projects/{id}/update_member_role` ✅ (project admins only)

Body `{memberId, role}`. Same shape as team-level update_member_role.
Upserts the `project_members` row — equivalent to add_member when
there's no override yet.

### `POST /v1/projects/{id}/remove_member` ✅ (project admins OR self)

Body `{memberId}`. Drops the `project_members` override; the user
falls back to whatever role they have at the team level.

- 404 `no_override` — user has no project-level override (their team
  role is in effect; nothing to remove)
- 403 `forbidden` — caller is not a project admin and the target
  isn't themselves

To fully kick a user out of a project, remove them from the team
instead (`POST /v1/teams/{ref}/remove_member`); the project_members
row CASCADEs away with the user.

### `POST /v1/projects/{id}/access_tokens` ✅ (admins only)

Body `{name, expiresAt?}`. Creates a project-scoped PAT. The bearer can
act on this project and its deployments but NOT siblings. See "Token
scopes" below.

### `GET /v1/projects/{id}/access_tokens` ✅

Lists the caller's project-scoped tokens.

### `POST /v1/projects/{id}/app_access_tokens` ✅ (admins only)

Same shape as `/access_tokens` but creates a token with `scope=app`. App
tokens have the same access surface as project-scoped tokens; the label
is what the dashboard uses to categorise "preview deploy keys" (CI/CD)
separately from regular project tokens.

### `GET /v1/projects/{id}/app_access_tokens` ✅

Lists the caller's app-scoped tokens for this project.

## Deployments

### `POST /v1/projects/{id}/create_deployment` ✅ (admins only)

Body: `{type:"dev"|"prod"|"preview"|"custom", reference?, isDefault?,
cpus?, memoryMb?}`. Allocates a name, picks a free host port from the
configured range, provisions a Convex backend container via Docker, and
returns the `Deployment` row once `/version` responds (or after a 60s
healthcheck warning, whichever comes first).

**Resource limits (v1.25+):** `cpus` (0.1–64, fractions allowed) and
`memoryMb` (128–1048576) cap the container via Docker's
`HostConfig.Resources` — the self-hosted answer to Cloud's deployment
classes. Absent = unlimited (pre-v1.25 behavior). Out-of-range values are
`400 invalid_resources`. The limits persist on the row, ride every
recreate (domain rebakes, resizes), and surface as `cpus`/`memoryMb` in
GET/list responses.

### `POST /v1/projects/{id}/adopt_deployment` 🔧 (admins only)

Registers an existing Convex backend (running outside Synapse) under this
project. Synapse stores the URL + admin key as a regular deployment row
flagged `adopted=true`. The dashboard, CLI credentials endpoint, and
reverse proxy all work as if Synapse had provisioned it — but Synapse
never touches the underlying container: `delete` only unregisters the
row, the health worker skips adopted rows, and there is no auto-restart.

Body:

```json
{
  "deploymentUrl": "https://convex.my-server.example:3210",
  "adminKey": "self-hosted-admin-key-…",
  "deploymentType": "prod",
  "name": "my-existing-app",
  "isDefault": false,
  "reference": ""
}
```

- `deploymentUrl` (required) — http or https; trailing slash is stripped.
- `adminKey` (required) — must succeed against `<url>/api/check_admin_key`.
- `deploymentType` (default `dev`) — one of `dev|prod|preview|custom`.
- `name` (optional) — externally-facing identifier. If omitted, Synapse
  allocates a `friendly-cat-1234`-style name. If provided and a collision
  exists, returns `409 name_taken`.
- `isDefault`, `reference` — optional, same semantics as `create_deployment`.

Before inserting the row, Synapse hits `GET <url>/version` (proves the URL
is a live Convex backend) and `GET <url>/api/check_admin_key` with
`Authorization: Convex <adminKey>` (proves the key works). Failures map to
client errors:

| code | status | meaning |
|---|---|---|
| `missing_url` / `missing_admin_key` | 400 | required field empty |
| `invalid_url` | 400 | not http/https, or unparseable |
| `invalid_admin_key` | 400 | the deployment rejected the key |
| `probe_failed` | 502 | URL didn't respond, or returned non-2xx |
| `name_taken` | 409 | `name` collides with another deployment |

Response (201): the `Deployment` row, with `status: "running"`,
`adopted: true`, and the supplied URL.

### `GET /v1/projects/{id}/deployment` ✅

Find one deployment in this project. Query params:
- `reference=<string>` — match by `reference` field
- `defaultProd=true` — most recent production deployment marked default
- `defaultDev=true` — same for dev

Without query params, returns the newest non-deleted deployment.

### `GET /v1/deployments/{name}` ✅
### `POST /v1/deployments/{name}/delete` ✅ (admins only)

Stops + removes the container, drops its data volume, marks the row deleted.

The teardown is dispatched to the deployment's **host** — for a remote-host
deployment that's an SSH round-trip to the VPS the container lives on — and is
bounded by a deadline so an unreachable host can't hang the request. When the
host can't be reached the teardown fails:

- **Remote host:** `502 remote_teardown_failed` (message names the host). The
  row is left intact so the operator can retry once the host is back.
- **Self-host:** `500 destroy_failed` (Docker daemon error). Row left intact.

**`?force=true`** removes the record even when teardown fails — the escape
hatch for a deployment stranded on a permanently-dead remote host (there is no
host-delete cascade, so otherwise the row is undeletable). It does NOT skip a
healthy teardown; it only suppresses a teardown *failure*, and may leave the
remote container + data volume orphaned until the host returns. Audit metadata
records `forced: true` and, when teardown actually failed, `orphaned: true`.

### `POST /v1/deployments/{name}/restart` 🔧 (members+)

Bounces the deployment's container(s) in place, keeping the data volume — the
operator escape hatch for a wedged backend. HA restarts every replica. Returns
`{name, status:"restarted"}`. Errors: `409 cannot_restart_adopted` (no managed
container), `409 deployment_provisioning`, `409 deployment_deleted`,
`500 restart_failed` (self-host) / `502 restart_failed` (remote host
unreachable — bounded, never hangs). The DB status is untouched; the health
worker reconciles.

### `POST /v1/deployments/{name}/update_resources` 🔧 (members+, v1.25+)

Resize: persists new CPU/RAM limits and **recreates the container** so
Docker actually enforces them (HostConfig is fixed at create time — a
plain restart keeps the old caps; the data volume survives). Body
`{cpus?, memoryMb?}` is the FULL desired state, not a patch — omit a
field for unlimited. Same bounds as create (`400 invalid_resources`).
Returns the updated `Deployment`. Audited as
`updateDeploymentResources`. Refusals, each with a stable code:
`409 cannot_resize_adopted` (no managed container),
`409 ha_resize_not_supported` (rolling per-replica recreate not shipped
yet — HA limits are set at create), `409 remote_resize_not_supported`
(recreate only dispatches to the local daemon today), and
`409 deployment_not_running`.

### Backups (v1.25+) — `/v1/deployments/{name}/backups…`

The self-hosted answer to Cloud's Backups page. A backup is a **real
Convex snapshot export** (`npx convex export`, run in a transient CLI
container against the deployment with its admin key) stored as a zip on
the `synapse-backups` Docker volume. Restore feeds it back with
`convex import --replace` — destructive, the deployment's current data is
replaced wholesale. Export/restore run async on the provisioning job
queue. v1 limitations (stable codes): `409 cannot_backup_adopted`,
`409 remote_backup_not_supported`, `409 deployment_not_running`;
`503 backups_not_configured` when the volume isn't mounted.

- `GET /backups` 🔧 (any role) — list, newest first:
  `[{id, deploymentId, status, sizeBytes?, error?, requestedBy?,
  createTime, completedAt?, restoredAt?}]`. `requestedBy` empty = the
  daily scheduler. Status: `pending → running → complete | failed`.
- `POST /backups` 🔧 (members+) — request one; `202` with the pending row.
  One in flight per deployment (`409 backup_in_progress`).
- `GET /backups/{id}/download` 🔧 (members+) — streams the zip
  (`Content-Disposition: attachment`). Same trust level as the admin key
  members already get via `/cli_credentials`.
- `POST /backups/{id}/restore` 🔧 (**admins only**) — `202`; the worker
  stamps `restoredAt` when the import lands. Audited as `restoreBackup`.
- `POST /backups/{id}/delete` 🔧 (admins only) — removes archive + row;
  in-flight rows refused (`409 backup_in_progress`).
- `POST /backup_settings` 🔧 (admins only) — body
  `{schedule: "none"|"daily", retention: 1..90}`. The server-side sweeper
  mints one backup per UTC day per opted-in deployment and prunes complete
  backups beyond `retention` (oldest first, files included). Surfaced on
  the deployment as `backupSchedule`/`backupRetention`.

### `GET /v1/deployments/{name}/auth` 🔧 (members only)

Returns `{deploymentName, deploymentUrl, adminKey, deploymentType}`. The
dashboard calls this when the user clicks **Open** to launch the standalone
Convex dashboard against this deployment.

### `GET /v1/deployments/{name}/cli_credentials` 🔧 (members only)

Returns the env-var pair the [Convex CLI](https://www.npmjs.com/package/convex)
looks for when running against a self-hosted backend, plus a copy-pastable
shell snippet that sets both at once:

```json
{
  "deploymentName": "happy-cat-1234",
  "convexUrl": "http://127.0.0.1:3211",
  "adminKey": "…",
  "exportSnippet": "export CONVEX_SELF_HOSTED_URL='http://127.0.0.1:3211'\nexport CONVEX_SELF_HOSTED_ADMIN_KEY='…'"
}
```

The CLI's deployment-selection logic (in
[`lib/deploymentSelection.ts`](https://github.com/get-convex/convex-backend/blob/main/npm-packages/convex/src/cli/lib/deploymentSelection.ts))
treats the presence of both `CONVEX_SELF_HOSTED_URL` and
`CONVEX_SELF_HOSTED_ADMIN_KEY` as the "selfHosted" path and skips Big Brain
entirely. `CONVEX_DEPLOYMENT` must NOT also be set in that mode.

Quickstart:

```bash
# Get credentials for a deployment (JWT or PAT both work)
eval "$(curl -sf http://localhost:8080/v1/deployments/<NAME>/cli_credentials \
        -H "Authorization: Bearer $TOKEN" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["exportSnippet"])')"

# Now the CLI talks straight to the Synapse-managed backend container
npx convex dev --once
npx convex deploy
```

### `POST /v1/deployments/{name}/upgrade_to_ha` ✅ (admins only)

Queues a one-shot migration from the legacy SQLite single-replica backend to
two HA replicas backed by the configured Postgres + S3 storage. Requires
`SYNAPSE_HA_ENABLED=true` and `SYNAPSE_STORAGE_KEY`.

Body: `{haOverrides?}` with the same optional storage override fields accepted
by `create_deployment`.

Response (202):

```json
{
  "deploymentName": "happy-cat-1234",
  "status": "queued",
  "jobId": 42
}
```

The worker exports a Convex backup from the old replica with the official CLI,
provisions two HA containers, imports the backup with `--replace`, swaps the
replica rows, then stops the old SQLite container without removing its volume.

Errors:

| code | status | meaning |
|---|---|---|
| `ha_disabled` | 400 | HA is disabled on this Synapse instance |
| `ha_misconfigured` | 400 | HA storage or encryption config is incomplete |
| `cannot_upgrade_adopted` | 400 | adopted deployments are managed externally |
| `already_ha` | 409 | deployment is already HA |
| `deployment_not_running` | 409 | deployment must be running before migration |
| `upgrade_already_in_progress` | 409 | pending/claimed upgrade job already exists |

### `POST /v1/deployments/{name}/deploy_keys` ✅ (admins only)


Body: `{name}`. Returns `{id, name, adminKey, prefix, envSnippet,
exportSnippet}`. `adminKey` is shown once. Deploy keys are supported only
for running, Synapse-managed, single-replica deployments.

### `GET /v1/deployments/{name}/deploy_keys` ✅ (admins only)

Lists active deploy keys as `{deployKeys:[{id, name, prefix, createdBy?,
createdByName?, createTime}]}`. The full key is never returned after create.

### `POST /v1/deployments/{name}/deploy_keys/{id}/revoke` ✅ (admins only)

Revokes a deploy key by rotating the deployment's `INSTANCE_SECRET`, updating
the primary admin key, recreating the managed container, and marking every
active deploy key for that deployment revoked. This is deployment-wide because
the Convex backend validates admin keys statelessly against `INSTANCE_SECRET`.

### `POST /v1/deployments/{name}/access_tokens` ✅ (admins only)

Body `{name, expiresAt?}`. Creates a deployment-scoped PAT. The bearer
can ONLY act on this exact deployment.

### `GET /v1/deployments/{name}/access_tokens` ✅

Lists the caller's deployment-scoped tokens for this deployment.

## Reverse proxy

When `SYNAPSE_PROXY_ENABLED=true`, the API server also serves
`/d/{deploymentName}/*`, forwarding the rest of the path to the
provisioned Convex backend. Lets you expose a single host port (8080)
instead of one per deployment.

Example:

```
http://localhost:8080/d/quiet-cat-1234/api/check_admin_key
       │              │                │
       │              │                └─ forwarded as /api/check_admin_key
       │              └─ deployment name
       └─ Synapse host
```

No auth check at the proxy layer — deployments enforce admin-key auth
themselves.

## Project-level RBAC (v1.0+)

Teams have two roles (`admin`, `member`). Projects have three
(`admin`, `member`, `viewer`). The roles compose via override:

```
effective_role(project, user) =
   project_members.role  (if a row exists for this project + user)
ELSE
   team_members.role     (the team-wide default)
```

This lets a team admin be locked down to viewer on a single project,
or a contractor at team-member level be promoted to admin on the one
project they own. The team membership is the trust boundary —
`add_member` / `update_member_role` refuse 400 `not_team_member`
when the target isn't on the project's team yet.

### Permission matrix

| Action | viewer | member | admin (project) |
|---|---|---|---|
| GET project / deployments / env vars / members | ✅ | ✅ | ✅ |
| POST update env vars | ❌ | ✅ | ✅ |
| POST create deployment | ❌ | ✅ | ✅ |
| POST delete deployment | ❌ | ❌ | ✅ |
| PUT update project (name/slug) | ❌ | ❌ | ✅ |
| POST delete / transfer project | ❌ | ❌ | ✅ |
| POST adopt deployment | ❌ | ❌ | ✅ |
| POST upgrade deployment to HA (reserved; returns 501 until worker lands) | ❌ | ❌ | ✅ |
| POST create deploy key | ❌ | ❌ | ✅ |
| POST add / update / remove project member | ❌ | ❌ | ✅ |
| POST issue project / app access tokens | ❌ | ❌ | ✅ |
| Self-remove project override | ✅ | ✅ | ✅ |

Viewers see everything (read-only). Members can edit env vars and
spin up deployments but can't tear them down or rename the project.
Admins do everything else.

## Token scopes (v1.0+)

Synapse access tokens carry a `scope`: `user`, `team`, `project`,
`deployment`, or `app`. The scope determines what the token can reach:

| Scope (X) | team Y | project Y | deployment Y |
|---|---|---|---|
| `user`       | yes  | yes  | yes  |
| `team`       | only X==Y | only Y's team==X | only via project in X |
| `project` / `app` | no   | only X==Y | only deployments under X |
| `deployment` | no   | no   | only X==Y |

Mismatch returns `403 forbidden_token_scope`. `user` is the unrestricted
default (and what all JWT-authenticated dashboard sessions use).

Create scoped tokens via the resource-specific endpoints listed above
(e.g. `POST /v1/teams/{ref}/access_tokens`); the personal endpoint below
creates `user`-scoped tokens unless you explicitly pass `scope` + `scopeId`.

## Personal access tokens

User-scoped opaque tokens for CLI / CI / programmatic access. The plaintext
token is shown ONCE at creation; the server stores only its SHA-256 hash
and cannot recover the original. All three endpoints require an
authenticated caller (JWT or a previously-issued PAT) and only operate on
tokens belonging to the caller.

### `POST /v1/create_personal_access_token` ✅

Body:

```json
{
  "name": "ci-runner",
  "scope": "user",
  "scopeId": null,
  "expiresAt": null
}
```

- `name` (required) — short label, ≤100 chars.
- `scope` (default `"user"`) — one of `user`, `team`, `project`, `deployment`, `app`.
  Most callers use the resource-scoped endpoints (e.g.
  `/v1/teams/{ref}/access_tokens`) which set scope automatically.
- `scopeId` — required when `scope` is not `"user"`; the UUID of the
  team/project/deployment the token is bound to.
- `expiresAt` — optional ISO-8601 timestamp; must be in the future. Omit
  for a non-expiring token.

Response (201):

```json
{
  "token": "syn_abc123…",
  "accessToken": {
    "id": "…",
    "name": "ci-runner",
    "scope": "user",
    "createTime": "2026-04-29T12:00:00Z"
  }
}
```

The plaintext `token` is the value to send as `Authorization: Bearer …`
on subsequent requests. Save it immediately — it is never returned again.

### `GET /v1/list_personal_access_tokens` ✅

Lists tokens belonging to the caller, newest first.

Query params:
- `limit` (default 50, max 200) — page size.
- `cursor` — opaque continuation token returned as `nextCursor` from the
  previous page. Must refer to a token the caller owns.

Response (200):

```json
{
  "items": [
    {
      "id": "…",
      "name": "ci-runner",
      "scope": "user",
      "createTime": "2026-04-29T12:00:00Z",
      "lastUsedAt": "2026-04-29T12:05:00Z"
    }
  ],
  "nextCursor": "…"
}
```

`nextCursor` is omitted on the last page. Token hashes and plaintext
tokens are NEVER included.

### `POST /v1/delete_personal_access_token` ✅

Body: `{"id": "<token-uuid>"}`. Hard-deletes the token if it belongs to
the caller. Returns `{"id": "…"}` on success, `404 token_not_found`
otherwise. Subsequent auth attempts with that token will be rejected by
the auth middleware.

## Out of scope (cloud-only)

Roughly 60 paths from the Convex Cloud OpenAPI spec are intentionally NOT
implemented in Synapse — billing (Orb / Stripe), SSO via WorkOS, Discord /
Vercel integrations, OAuth apps, cloud-managed backups, referrals. A
single middleware (`internal/api/not_supported.go`) intercepts these
paths and returns:

```
HTTP/1.1 404 Not Found
{"code":"not_supported_in_self_hosted","message":"…"}
```

The structured `code` lets clients distinguish "this URL is wrong" from
"this feature is intentionally cut" and avoid retry loops. See
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) "Out of scope" for the
rationale on each family. The middleware runs BEFORE auth so probes
reveal the cut without needing a JWT/PAT first.

## Errors

All errors return `{code, message}` with an HTTP status. Codes are stable;
messages may evolve.

| code | typical status | meaning |
|---|---|---|
| `bad_request` | 400 | malformed JSON / unknown field |
| `missing_*` | 400 | required field omitted |
| `invalid_*` | 400 | field present but not valid |
| `unauthorized` | 401 | missing or expired bearer |
| `invalid_token` | 401 | token signature/expiry/kind wrong |
| `invalid_credentials` | 401 | login email/password mismatch |
| `forbidden` | 403 | authenticated but not allowed (role gate) |
| `forbidden_token_scope` | 403 | PAT scoped to a different resource |
| `*_not_found` | 404 | target doesn't exist (or you can't see it) |
| `not_supported_in_self_hosted` | 404 | path is cloud-only — see "Out of scope" |
| `email_taken` | 409 | unique constraint on registration |
| `slug_taken` | 409 | team or project slug already in use |
| `name_taken` | 409 | adopted-deployment name collision |
| `team_has_deployments` | 409 | delete_team refuses while live deployments exist |
| `team_creator` | 409 | delete_account refuses for creator of any team |
| `last_admin` | 409 | role/membership change would orphan a team |
| `not_team_member` | 400 | project add_member target is not on the team yet |
| `no_override` | 404 | remove_member found no project_members override |
| `internal` | 500 | server bug — check logs |

## Stability + versioning (v1.0+)

Synapse follows semver on the API surface documented above. Tags are
cut on `main` (`vMAJOR.MINOR.PATCH`) and published as
[GitHub Releases](https://github.com/Iann29/convex-synapse/releases);
`./setup.sh --upgrade` queries `/repos/.../releases/latest` to
discover them.

### What semver applies to

The contract below is **stable**. Breaking changes bump the **major**
version (`v1.0.0` → `v2.0.0`):

- The set of `/v1/...` endpoints documented above (paths, verbs,
  request body shapes, response top-level keys, success status codes).
- The list of `code` strings in the error table — values are stable;
  the `message` string is human-readable and may evolve.
- The role hierarchy (admin > member > viewer) and the override
  semantics (project_members beats team_members).
- Token scopes (`user`, `team`, `project`, `app`, `deployment`) and
  the access matrix in §"Token scopes".
- The `not_supported_in_self_hosted` 404 contract for cloud-only
  paths.

### What's NOT covered by semver

- The exact text of error `message` fields.
- The `metadata` JSONB shape inside audit events — keys may grow.
- Internal endpoints under `/v1/internal/...` (today
  `tls_ask`, `list_deployments_for_dashboard`); these are for the
  installer / Caddy / iframed dashboard and may change without bumping.
- The dashboard fork's component API (`@/components/...`).
- Database migrations (additive — schema is the implementation
  detail of the API, not the API itself).
- The `setup.sh` flag set — see `setup.sh --help` for current
  flags. Lifecycle commands stay backwards compatible across
  minor releases; flags that change behaviour incompatibly land in
  a new flag with the old one printing a deprecation warning for
  one minor cycle.

### Deprecation policy

When an endpoint or field needs to go:

1. Document the replacement in the same minor release.
2. Mark the old surface as deprecated in this doc with a `🦴
   deprecated since v1.X` tag and a sentence pointing at the new
   path.
3. The old surface keeps working — and stays in the test suite —
   for at least one minor release after deprecation.
4. Removal happens in the next major (`v2.0.0`+).

### Endpoint added / removed since v1.0.0

This section starts empty. Every minor release that touches the
public surface gets a row here so callers know what to expect when
they bump the `--upgrade` target.

| Version | Change |
|---|---|
| v1.0.0 | initial stable surface (this doc) |
| v1.0.1 | added public `GET /v1/install_status` for the first-run dashboard wizard |
| v1.0.3 | added deployment deploy-key endpoints under `/v1/deployments/{name}/deploy_keys` |
| v1.1.0 | added instance-admin self-update endpoints under `/v1/admin/version_check`, `/v1/admin/upgrade`, and `/v1/admin/upgrade/status` |
| v1.2.0 | installer/runtime release; no intentional public `/v1` breaking change |
| v1.3.0 | HA polish — `POST /v1/deployments/{name}/upgrade_to_ha` async worker; active replica health probe; HA-aware CORS rolling across replicas |
| v1.4.0 | added `POST /v1/admin/host_domain` for runtime domain reconfiguration |
| v1.5.0 | added DNS auto-configuration — `POST /v1/admin/dns_credentials/cloudflare` (CRUD) + `POST /v1/deployments/{name}/domains/{id}/auto_configure` |
| v1.6.0 | no `/v1` surface change — CLI `synapse convex` wrapper shipped client-side |
| v1.11.0 | no `/v1` surface change — bilingual `/docs` shipped in the dashboard; CLI `synapse skills` group added |
| v1.12.0 | added Cell Control Plane (observe / plan only, apply hard-disabled): `/v1/hosts`, `/v1/host_agents`, `/v1/cells`, `/v1/cell_links`, `/v1/service_tokens`, `/v1/operation_runs`, project/cell/host scoped `desired_state` / `observed_state` / `drift` / `reconcile_dry_run` (any `apply:true` returns 400 `apply_not_supported`) |
| v1.13.0 | added `POST /v1/cells/{id}/delete` |
| v1.14.0 | added `POST /v1/deployments/{name}/restart` |
| v1.15.0 | Site Origin — `role='site'` accepted on `POST /v1/deployments/{name}/domains`; `deployment.siteUrl` field added to deployment JSON; proxy routes `<name>.site.<base>` to Convex port 3211; `/v1/internal/tls_ask` approves the site subdomain branch |
| v1.16.0 | no `/v1` surface change — adds CLI `domains`/`members`/`upgrade` command families against existing endpoints; backend gains CCP audit-event assertion coverage; HA port alloc race wrapped in retry |
| v1.17.0 | no `/v1` surface change — installer-only refactors (env hydrator; updater daemon hardening) |
| v1.18.0 | added Remote Hosts: extended `/v1/hosts` (`is_remote`, `tailnet_addr`), added `POST /v1/hosts/{id}/remote_setup` to mint a one-liner bundle, public `GET /v1/install_agent/config` for `install-agent.sh`, `GET /v1/install-agent.sh` script handler |
| v1.19.0 | dashboard-driven Remote Hosts setup — `GET /v1/admin/headscale`, `POST /v1/admin/headscale/configure`, `GET /v1/admin/headscale/status/{jobID}` (instance-admin gated; same admin_jobs pattern as host-domain); proxy resolves remote deployments to `<tailnet_addr>:<host_port>` automatically; remote site-routing returns `ErrSiteUnsupported` (3211 not published over tailnet) |
| v1.20.0 | Remote Hosts end-to-end. Host removal — `POST /v1/hosts/{id}/delete` (instance-admin, registry-only): refuses `409 cannot_remove_self_host` / `host_has_deployments` / `host_has_pending_jobs`; on success cascades agent/token/state rows and audits `deleteHost` (does NOT deregister the Headscale node or clean the on-VPS agent — see `docs/REMOTE_HOSTS.md#removing-a-host`). `POST /v1/deployments/{name}/delete?force=true` drops a record stranded on an unreachable host; the bounded teardown now returns `502 remote_teardown_failed` / `restart_failed` instead of hanging. No new surface for the provision/proxy/register fixes that finally make a remote deployment provision, stay running, and route through the central proxy (installer + health reconciler + Headscale ACL only). |
| v1.21.0 | Dashboard full Portuguese (pt-BR) localization. The entire dashboard UI is translatable via a lightweight in-house "English-as-key" i18n layer (`dashboard/lib/i18n/`): every user-facing string is wrapped in `t("English source")`, with a 1157-key `pt-BR` dictionary and automatic fallback to the English source for any missing key. Locale is resolved server-side (cookie → `Accept-Language` → default `en`) so the first paint is already in the right language; an `EN \| PT` switcher in the TopBar + auth pages persists the choice to the `synapse_locale` cookie. English stays the default, so the rendered DOM is byte-identical to before (no change to API consumers or e2e text assertions). No `/v1` API surface change. |
| v1.25.0 | Convex-Cloud gap closers, wave 1: deployment-down alerts — `GET/POST/DELETE /v1/admin/alert_settings` (instance-admin; masked webhook hint, never the URL); self-service password reset — anonymous `POST /v1/auth/forgot_password` + `POST /v1/auth/reset_password`, and `/v1/auth/refresh` now refuses refresh JWTs issued before the last password change; per-deployment resource limits — `cpus`/`memoryMb` accepted on `create_deployment`, surfaced on deployment JSON, plus `POST /v1/deployments/{name}/update_resources` (resize via container recreate); per-deployment snapshot backups — `GET/POST /v1/deployments/{name}/backups`, `GET …/backups/{id}/download`, `POST …/backups/{id}/restore`, `POST …/backups/{id}/delete`, `POST …/backup_settings` (daily schedule + retention, server-side sweeper) |