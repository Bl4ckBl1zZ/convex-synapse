# Synapse API Reference

Synapse implements a subset of Convex Cloud's [Management API v1](https://github.com/get-convex/convex-backend/blob/main/npm-packages/dashboard/dashboard-management-openapi.json) plus a handful of self-hosted extensions.

## Overview

| | |
|---|---|
| Base URL | `http://localhost:8080` in dev compose; `https://<your-host>` in production |
| Format | JSON over HTTP — `application/json` |
| Auth header | `Authorization: Bearer <token>` where `<token>` is a JWT from `/v1/auth/login`, or an opaque `syn_*` PAT |
| Versioning | All public endpoints under `/v1/...`. Semver applies to paths, verbs, response top-level keys, error `code` strings, role hierarchy, token scopes, and the 404 contract for cut endpoints |

### Error envelope

Every 4xx/5xx body comes from `writeError`:

```json
{
  "code": "snake_case_token",
  "message": "Human readable hint"
}
```

`code` is stable across releases — programmatic clients should switch on it.

### PAT scopes

Tokens carry a `scope` field — one of `user`, `team`, `project`, `app`, or `deployment`:

| Scope (X) | Can act on team Y? | Can act on project Y? | Can act on deployment Y? |
|---|---|---|---|
| `user` | yes | yes | yes |
| `team` | only when X == Y | only when Y's team == X | only via project in X |
| `project`, `app` | no | only when X == Y | only deployments under X |
| `deployment` | no | no | only when X == Y |

Mismatches return `403 forbidden_token_scope`. Enforcement lives in `load*ForRequest` helpers — see `internal/api/scope.go`.

### Pagination

- **Header-cursor lists** (`GET /v1/teams`, `list_projects`, `list_members`, `list_deployments`) return a bare JSON array, accept `?limit=N` (default 100, max 500) and `?cursor=<id>`, header `X-Next-Cursor: <id>`.
- **Body-cursor lists** (`/list_personal_access_tokens`, every `*/access_tokens` list, `/audit_log`, `/activity`) return `{items, nextCursor}`, same query.

Bad cursors → `400 invalid_cursor`. Bogus limits → `400 invalid_limit`.

## Auth

| Method + Path | Auth | Description |
|---|---|---|
| `POST /v1/auth/register` | none | Create user. Response: `{accessToken, refreshToken, tokenType:"Bearer", expiresIn, user}`. First user → `isInstanceAdmin=true`. Errors: `400 invalid_email`, `400 weak_password`, `409 email_taken` |
| `POST /v1/auth/login` | none | Exchange email+password for token pair. Errors: `401 invalid_credentials` |
| `POST /v1/auth/refresh` | refresh token | Mint a fresh access token. Errors: `401 invalid_refresh`, `401 user_not_found` |

No logout endpoint — JWTs are stateless; PATs revoked via `POST /v1/delete_personal_access_token`.

## Profile

Endpoints at both `/v1/me/*` and at the top-level `/v1/*`. The `/v1/profile/*` alias also routes here.

| Method + Path | Auth | Description |
|---|---|---|
| `GET /v1/me` (alias `/v1/profile`) | JWT or PAT | Return the authenticated user |
| `PUT /v1/update_profile_name` (alias `/v1/me/update_profile_name`) | JWT or PAT | `{name}` |
| `POST /v1/delete_account` (alias `/v1/me/delete_account`) | JWT or PAT | Errors: `409 last_admin`, `409 team_creator` |
| `GET /v1/member_data` (alias `/v1/me/member_data`) | JWT or PAT | Bundled `{teams, projects, deployments, optInsToAccept}` |
| `GET /v1/optins` | JWT or PAT | Always `{optInsToAccept: []}` (self-hosted has no TOS) |

## Teams

`{ref}` accepts the team UUID or slug.

| Method + Path | Auth | Description |
|---|---|---|
| `GET /v1/teams` | JWT or PAT (`user`/`team`) | List teams (header-cursor) |
| `POST /v1/teams/create_team` | JWT or PAT (`user`) | `{name, defaultRegion?}`. Caller becomes admin |
| `GET /v1/teams/{ref}` | member | Return the team |
| `POST /v1/teams/{ref}` | admin | `{name?, slug?, defaultRegion?}` — update |
| `POST /v1/teams/{ref}/delete` | admin | Refused while deployments exist (`409 team_has_deployments`) |
| `GET /v1/teams/{ref}/list_projects` | member | Header-cursor |
| `GET /v1/teams/{ref}/list_members` | member | Header-cursor |
| `GET /v1/teams/{ref}/list_deployments` | member | Header-cursor |
| `POST /v1/teams/{ref}/create_project` | member | `{projectName}` |
| `POST /v1/teams/{ref}/update_member_role` | admin | `{memberId, role: "admin"\|"member"\|"developer"}` (developer→member). Errors: `404 member_not_found`, `409 last_admin` |
| `POST /v1/teams/{ref}/remove_member` | admin (or self) | `{memberId}`. Errors: `409 last_admin` |
| `POST /v1/teams/{ref}/invite_team_member` | admin | `{email, role}` → `{inviteId, email, role, inviteToken}` |
| `GET /v1/teams/{ref}/invites` | admin | List pending |
| `POST /v1/teams/{ref}/invites/{inviteID}/cancel` | admin | Delete pending |
| `GET /v1/teams/{ref}/audit_log` | admin | Body-cursor `{items, nextCursor?}`. Default 50, max 200 |
| `POST /v1/teams/{ref}/access_tokens` | admin | `{name, expiresAt?}` → 201 `{token, accessToken}`. Plaintext returned ONCE |
| `GET /v1/teams/{ref}/access_tokens` | member | List caller's team-scoped tokens |
| `POST /v1/team_invites/accept` | JWT or PAT | `{token}` → `{teamId, teamSlug, teamName, role}` |

## Projects

`{id}` is the project UUID. Roles are *project-effective* (project_members override beats team_members).

| Method + Path | Auth | Description |
|---|---|---|
| `GET /v1/projects/{id}` | viewer+ | Return the project |
| `PUT /v1/projects/{id}` | project admin | `{name?, slug?}`. Per-team slug unique. Errors: `400 invalid_slug`, `409 slug_taken` |
| `POST /v1/projects/{id}/delete` | project admin | Cascade-deletes env vars, project members, deploy keys, deployments |
| `POST /v1/projects/{id}/transfer` | admin on src AND dest team | `{destinationTeamId}`. Errors: `404 team_not_found`, `403 forbidden`, `409 slug_taken` |
| `GET /v1/projects/{id}/list_deployments` | viewer+ | Header-cursor |
| `GET /v1/projects/{id}/deployment` | viewer+ | `?reference=`, `?defaultProd=true`, `?defaultDev=true`, or newest |
| `GET /v1/projects/{id}/list_default_environment_variables` | viewer+ | `{configs: [{name, value, deploymentTypes}]}` |
| `POST /v1/projects/{id}/update_default_environment_variables` | member+ | `{changes: [{op:"set"\|"delete", name, value?, deploymentTypes?}]}`. Audit metadata records names only |
| `POST /v1/projects/{id}/sync_env_to_deployments` | member+ | Re-create running deployments. ~15s downtime each. Response `{total, recreated, skipped, errors?, notice?}` |
| `GET /v1/projects/{id}/list_members` | viewer+ | Merged. `source: "project"\|"team"` field |
| `POST /v1/projects/{id}/add_member` | project admin | `{userId, role: "admin"\|"member"\|"viewer"}`. Target must be on team. Errors: `400 not_team_member`, `400 invalid_role` |
| `POST /v1/projects/{id}/update_member_role` | project admin | `{memberId, role}` |
| `POST /v1/projects/{id}/remove_member` | project admin (or self) | `{memberId}`. Errors: `404 no_override` |
| `POST /v1/projects/{id}/access_tokens` | project admin | Issue project-scoped PAT |
| `GET /v1/projects/{id}/access_tokens` | viewer+ | List |
| `POST /v1/projects/{id}/app_access_tokens` | project admin | Issue app-scoped PAT (CI/preview deploy keys) |
| `GET /v1/projects/{id}/app_access_tokens` | viewer+ | List |
| `GET /v1/projects/{id}/topology` | viewer+ | Regions/host snapshot (v1.9.6+) |
| `GET /v1/projects/{id}/activity` | viewer+ | Body-cursor `{events, nextCursor?}` (v1.10.0+) |
| `GET /v1/projects/{id}/dns_credentials` | viewer+ | Project-scoped DNS credentials (v1.6.4+) |
| `POST /v1/projects/{id}/dns_credentials/cloudflare` | project admin | Add Cloudflare credential |
| `DELETE /v1/projects/{id}/dns_credentials/{id}` | project admin | Remove |
| `POST /v1/projects/{id}/create_deployment` | member+ | See Deployments |
| `POST /v1/projects/{id}/adopt_deployment` | project admin | See Deployments |

## Deployments

`{name}` is the deployment name (e.g. `happy-cat-1234`).

| Method + Path | Auth | Description |
|---|---|---|
| `POST /v1/projects/{id}/create_deployment` | project member+ | `{type, reference?, isDefault?, ha?, haOverrides?}`. Type: dev/prod/preview/custom (default dev). 201 with `status:"provisioning"`. Errors: `400 invalid_type`, `400 ha_disabled`, `400 ha_misconfigured`, `403 forbidden`, `404 project_not_found` |
| `POST /v1/projects/{id}/adopt_deployment` | project admin | `{deploymentUrl, adminKey, deploymentType?, name?, isDefault?, reference?}`. Probes `/version` + `/api/check_admin_key` first. Errors: `400 missing_url`, `400 missing_admin_key`, `400 invalid_url`, `400 invalid_admin_key`, `409 name_taken`, `502 probe_failed` |
| `GET /v1/deployments/{name}` | viewer+ | Return the deployment |
| `POST /v1/deployments/{name}/delete` | project admin | Tear down container + volume, mark deleted |
| `GET /v1/deployments/{name}/auth` | viewer+ | `{deploymentName, deploymentUrl, adminKey, deploymentType}` for embedded dashboard |
| `GET /v1/deployments/{name}/cli_credentials` | viewer+ | `{deploymentName, convexUrl, adminKey, envSnippet, exportSnippet}` for `npx convex` |
| `GET /v1/deployments/{name}/backend_version` | viewer+ | Live `{version, fetchedAt, fromCache, lastDeployAt, error?}` probe |
| `POST /v1/deployments/{name}/upgrade_to_ha` | project admin | `{haOverrides?}`. 202 `{deploymentName, status:"queued", jobId}`. Errors: `400 ha_disabled`, `400 cannot_upgrade_adopted`, `409 already_ha`, `409 deployment_not_running`, `409 upgrade_already_in_progress` |
| `POST /v1/deployments/{name}/reissue_admin_key` | project admin | Re-mint admin_key from current instance_secret (no rotation). Errors: `400 cannot_reissue_adopted`, `409 missing_instance_secret` |
| `POST /v1/deployments/{name}/deploy_keys` | project admin | `{name}` (≤64 chars). 201 with full key (shown ONCE). Errors: `400 missing_name`, `400 name_too_long`, `409 name_in_use`, `409 deploy_keys_unsupported_for_adopted`, `409 deploy_keys_unsupported_for_ha`, `409 deployment_not_running` |
| `GET /v1/deployments/{name}/deploy_keys` | viewer+ | List active (metadata only) |
| `POST /v1/deployments/{name}/deploy_keys/{id}/revoke` | project admin | Rotates INSTANCE_SECRET; revokes ALL active deploy keys. 204 |
| `POST /v1/deployments/{name}/access_tokens` | project admin | Issue deployment-scoped PAT |
| `GET /v1/deployments/{name}/access_tokens` | viewer+ | List |
| `GET /v1/deployments/{name}/domains` | viewer+ | List custom domains |
| `POST /v1/deployments/{name}/domains` | member+ | `{domain, role:"api"\|"dashboard"}`. Inline DNS preflight. 201 with `domainResponse` |
| `DELETE /v1/deployments/{name}/domains/{domainID}` | member+ | 204 |
| `POST /v1/deployments/{name}/domains/{domainID}/verify` | member+ | Re-run preflight |
| `POST /v1/deployments/{name}/domains/{domainID}/auto_configure` | member+ | `{credentialId?}` — UPSERT A record via stored credential |

## Cell Control Plane

The [Cell Control Plane](/docs/en/cell-control-plane) endpoints — diagnose / plan / manage metadata only. None apply changes to a host: every drift plan carries `applyAllowed=false`, and `apply:true` in a reconcile body returns `400 apply_not_supported`.

### Hosts & agents

| Method + Path | Auth | Description |
|---|---|---|
| `GET /v1/hosts` | instance-admin | List hosts (each with a computed `effectiveStatus`) |
| `POST /v1/hosts` | instance-admin | Register a host (metadata only). `{name, region?, labels?}` |
| `GET /v1/hosts/{id}` | instance-admin | Show a host |
| `POST /v1/hosts/{id}/drain` | instance-admin | Mark draining (operator intent) |
| `POST /v1/hosts/{id}/adoption_token` | instance-admin | Mint a single-use adoption token. `{name?, ttlSeconds?}` → `{token, joinCommand, …}` (token shown once) |
| `GET /v1/hosts/{id}/agents` | instance-admin | List agents registered on the host |
| `POST /v1/host_agents/{id}/revoke` · `/rotate_token` | instance-admin | Revoke / rotate an agent token |

**Agent-facing** (public paths, authenticated by the agent/adoption token, not a user):

| Method + Path | Auth | Description |
|---|---|---|
| `POST /v1/agents/register` | adoption token (single-use) | Register an agent for a host; returns the agent token + heartbeat interval |
| `POST /v1/agents/heartbeat` | agent token | Report liveness + observed containers + `containerScan`. Host id comes from the token, not the body |
| `GET /v1/agents/desired_state` | agent token | Host-scoped desired state; always `applyAllowed=false` |

### Cells

| Method + Path | Auth | Description |
|---|---|---|
| `GET /v1/projects/{id}/cells` | member+ | List cells |
| `POST /v1/projects/{id}/cells` | project admin | Create a cell. `{name, kind}` |
| `POST /v1/cells/{id}/drain` | project admin | Mark draining |
| `POST /v1/cells/{id}/attach_deployment` | project admin | `{deploymentName}` → creates a placement |
| `POST /v1/cells/{id}/attach_host` | project admin | `{hostId}` → set the cell's primary host |
| `GET /v1/cells/{id}/resources` | member+ | List the cell's resources |

### Cell links & service tokens

| Method + Path | Auth | Description |
|---|---|---|
| `GET /v1/projects/{id}/cell_links` | member+ | List links |
| `POST /v1/projects/{id}/cell_links` | project admin | Create a link. Intra-project only; one active per `(source, target, protocol)` |
| `GET /v1/cell_links/{id}` · `PATCH …` | member+ / admin | Get / update a link |
| `POST /v1/cell_links/{id}/service_tokens` | project admin | Mint a service token (`syn_svc_…`, shown once) — only when `authMode=service_token` |
| `POST /v1/service_tokens/{id}/revoke` | project admin | Revoke a service token |
| `GET /v1/internal/cell_links/discovery` | **service token** (`syn_svc_`) | Public discovery: returns only the token's own link; rejects revoked/expired |

### Topology

| Method + Path | Auth | Description |
|---|---|---|
| `GET /v1/projects/{id}/cell_topology` | member+ | Host → Cell → Deployment map + link edges + read-only warnings. Synthetic fallback when no cells exist |

### State & drift

Scope each by `projects/{id}`, `cells/{id}`, or `hosts/{id}`. Host scope is instance-admin; project/cell use project RBAC (`recompute` / `dry_run` need admin, reads are member+).

| Method + Path | Auth | Description |
|---|---|---|
| `POST /v1/projects/{id}/desired_state/sync_from_placements` | project admin | Build desired state from placements; records an operation run |
| `GET` · `POST /v1/projects/{id}/desired_state` | member+ / admin | List / set desired state |
| `POST /v1/{scope}/drift/recompute` | admin / instance-admin | Recompute drift; writes a report |
| `GET /v1/{scope}/drift/latest` | member+ / instance-admin | Read the most recent report |
| `POST /v1/{scope}/reconcile/dry_run` | admin / instance-admin | The planned (never executed) steps. `apply:true` → `400 apply_not_supported` |
| `GET /v1/projects/{id}/operation_runs` · `GET /v1/operation_runs/{id}` | member+ | Operation run history + detail |

## Audit log

`GET /v1/teams/{ref}/audit_log` — admin only. Members → `403 forbidden`. Keyset pagination on `(created_at DESC, id DESC)`. No export endpoint, no retention configuration. Operators wanting long-term retention snapshot `audit_events` via Postgres.

## Instance admin

Mounted under `/v1/admin/*`; every route gated by `requireInstanceAdmin` (`users.is_instance_admin=true`).

| Method + Path | Description |
|---|---|
| `GET /v1/admin/version_check` | GitHub /releases/latest probe, 15min cache. Response: `{current, latest?, updateAvailable, releaseUrl?, releaseNotes?, publishedAt?, fetchedAt?, cacheExpiresAt?, fromCache, error?}` |
| `POST /v1/admin/version_check/refresh` | Bust cache (30s floor) |
| `POST /v1/admin/upgrade` | `{ref?}`. 202 `{started:true, ref}`. Errors: `503 updater_unreachable`/`not_configured`/`token_missing`, `502 updater_unreachable`, `409 upgrade_in_progress`, `400 invalid_ref`, `400 invalid_json` |
| `GET /v1/admin/upgrade/status` | Read-through to daemon `/status` |
| `GET /v1/admin/host_domain` | `{mode:"tls"\|"tls_with_wildcard"\|"plain", domain?, baseDomain?, publicUrl?, publicIp?, acmeEmail?, fallbackUrls}` |
| `POST /v1/admin/host_domain` | `{domain?, baseDomain?, plainHttp?, acmeEmail?, autoConfigureDns?}`. 202 `{jobId, statusUrl, state:"queued", dnsAuto?}` (v1.4+) |
| `GET /v1/admin/host_domain/status/{jobID}` | Poll reconfigure job |
| `GET /v1/admin/dns_credentials` | List instance-wide DNS credentials (metadata only) |
| `POST /v1/admin/dns_credentials/cloudflare` | `{token, label}` — verifies token by listing zones, encrypts via `SYNAPSE_STORAGE_KEY`. Errors: `503 dns_credentials_unavailable`, `400 invalid_token` |
| `DELETE /v1/admin/dns_credentials/{id}` | 204 |

## Install status

`GET /v1/install_status` — **public, no auth**. Response: `{firstRun, version}`. `firstRun` true iff `users` table empty. Errors: `503 db_unavailable`.

## Internal

`/v1/internal/*` — public + no auth by design (Caddy, iframed Convex Dashboard, dashboard's new-domain form). NOT covered by `/v1` semver.

| Method + Path | Description |
|---|---|
| `GET /v1/internal/tls_ask?domain=<host>` | Caddy on-demand TLS gate. 200 = OK to issue; 404 = refuse |
| `GET /v1/internal/list_deployments_for_dashboard?token=<syn_*>` | Cross-origin feed for iframed dashboard. Token must be `project` or `app` scope |
| `GET /v1/internal/dns_provider?domain=<host>` | `{provider, nameservers, error?}` — always 200 |
| `GET /v1/cli_latest_version` | Latest published `@iann29/synapse` on npm (15min cache) |
| `POST /v1/cli_latest_version/refresh` | Bust cli-version cache (30s floor) |

## Reverse proxy

Active when `SYNAPSE_PROXY_ENABLED=true`. Two routing modes:

- **Path routing**: `/d/{deploymentName}/*` forwards to `http://convex-<name>:3210/...`
- **Host-header routing**: `<sub>.<BaseDomain>` (wildcard, v1.0+) and arbitrary `<custom-domain>` (per-deployment, v1.1+) match against a `name → address-list` resolver cache

No auth check at the proxy layer — deployments enforce admin-key auth themselves.

## Not supported in self-hosted

A middleware runs BEFORE auth and short-circuits cloud-only OpenAPI paths with `404 not_supported_in_self_hosted`. **55 entries total**: 1 exact (`/v1/validate_referral_code`) + 5 prefix families (`/v1/cloud_backups`, `/v1/discord`, `/v1/profile_emails`, `/v1/vercel`, `/v1/workos`) + 49 parameterised patterns covering billing (18), SSO/WorkOS (8), OAuth apps (5), usage/spending (4), cloud backups (6), WorkOS-flavoured deployment routes (5), + others. See the [Self-hosted vs Cloud](/docs/en/self-hosted-vs-cloud) page for the full catalogue.

## Errors

| Code | Typical status | Meaning |
|---|---|---|
| `bad_request` | 400 | Malformed JSON, unknown fields |
| `missing_*` | 400 | Required field omitted |
| `invalid_*` | 400 | Field present but malformed |
| `weak_password` | 400 | Password < 8 chars |
| `bad_op` | 400 | env var op must be `set` or `delete` |
| `not_team_member` | 400 | `add_member` target not on the project's team |
| `ha_disabled` | 400 | `ha:true` but `SYNAPSE_HA_ENABLED=false` |
| `ha_misconfigured` | 400 | HA on but cluster config incomplete |
| `cannot_upgrade_adopted` / `cannot_reissue_adopted` | 400 | Adopted deployments are externally managed |
| `unauthorized` / `unauthenticated` | 401 | Missing or invalid bearer |
| `invalid_credentials` | 401 | Login mismatch |
| `invalid_refresh` | 401 | Refresh token bad/expired |
| `missing_token` | 401 | Internal endpoint required `?token=` |
| `forbidden` | 403 | Insufficient role |
| `forbidden_token_scope` | 403 | PAT scoped to a different resource |
| `wrong_scope` | 403 | Dashboard token has wrong scope |
| `*_not_found` | 404 | See specific values |
| `no_override` | 404 | `remove_member` found no project_members row |
| `not_supported_in_self_hosted` | 404 | See not_supported.go catalogue |
| `email_taken` | 409 | Registration collision |
| `slug_taken` | 409 | Team or project slug collision |
| `name_taken` | 409 | Adopted-deployment name collision |
| `name_in_use` | 409 | Deploy-key name collision |
| `already_ha` | 409 | Deployment already running HA |
| `deployment_not_running` | 409 | Operation requires `status='running'` |
| `deploy_keys_unsupported_for_adopted` / `deploy_keys_unsupported_for_ha` | 409 | Deploy keys require Synapse-managed, single-replica |
| `upgrade_already_in_progress` / `upgrade_in_progress` | 409 | Already running |
| `team_has_deployments` | 409 | `delete_team` blocked |
| `team_creator` | 409 | `delete_account` for `teams.creator_user_id` |
| `last_admin` | 409 | Would orphan a team |
| `missing_instance_secret` | 409 | Adopted/old row has empty `instance_secret` |
| `domain_already_registered` | 409 | Domain in use elsewhere |
| `probe_failed` | 502 | Adopt-deployment probe couldn't reach URL |
| `db_unavailable` | 503 | Postgres unreachable from `install_status` |
| `updater_unreachable` / `not_configured` / `token_missing` | 503 | Updater daemon unwired |
| `internal` | 500 | Server bug — check logs |

## Semver

Stable: `/v1/...` endpoint set, request body shapes, response top-level keys, success status codes, error `code` table, role hierarchy, token scopes, `not_supported_in_self_hosted` 404 contract.

**NOT** covered: exact `message` strings, `metadata` JSONB shape on audit events, `/v1/internal/*` routes, database migrations, `setup.sh` flag set.
