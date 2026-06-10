# Audit log + activity feed

Synapse persists every mutating operation into a single `audit_events` table. Two views surface this data: the team **audit log** (admin-only, full forensic table) and the project **activity feed** (member+, timeline-style narrative).

## The data model

`audit_events` (migration `000001_init.up.sql`):

```sql
CREATE TABLE audit_events (
    id          bigserial PRIMARY KEY,
    team_id     uuid REFERENCES teams(id) ON DELETE CASCADE,
    actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    action      text NOT NULL,
    target_type text,
    target_id   uuid,
    metadata    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_team_idx ON audit_events (team_id, created_at DESC);
```

Notable properties:

- **Team-scoped read.** Every list query filters on `team_id`. Cross-team events (profile, instance upgrades, DNS credentials) carry `team_id IS NULL`.
- **Actor preserved on user delete.** `ON DELETE SET NULL` on `actor_id` means a deleted user's audit trail keeps the action but loses the name.
- **Best-effort writes.** `audit.Record` (in `synapse/internal/audit/audit.go`) logs a warn on insert failure and returns — never fails the user's request.
- **No retention / pruning.** No auto-purge job, no TTL. Rows live forever (or until the team is `CASCADE`'d). Operators wanting lifecycle policy run their own `DELETE FROM audit_events WHERE created_at < ...`.

## Recorded actions

From `synapse/internal/audit/audit.go`:

**Auth:** `login`

**Teams:** `createTeam`, `updateTeam`, `deleteTeam`, `inviteTeamMember`, `cancelInvite`, `acceptInvite`, `updateMemberRole`, `removeMember`

**Project-level RBAC** (v1.0+): `addProjectMember`, `updateProjectMemberRole`, `removeProjectMember`

**Profile:** `updateProfileName`, `deleteAccount`

**Projects:** `createProject`, `deleteProject`, `renameProject`, `updateProject`, `transferProject`, `updateProjectEnvVars`, `syncEnvToDeployments`

**Deployments:** `createDeployment`, `deleteDeployment`, `adoptDeployment`, `upgradeToHA`, `reissueAdminKey`

**PATs:** `createPersonalAccessToken`, `deletePersonalAccessToken`

**Deploy keys:** `createDeployKey`, `revokeDeployKey`

**Custom domains** (v1.1+): `domain.added`, `domain.removed`, `domain.verified`, `domain.auto_configured`

**DNS credentials** (v1.5+): `dns_credential.added`, `dns_credential.removed`, `project_dns_credential.added`, `project_dns_credential.removed`

**Instance upgrades** (v1.1.0+): `upgradeStarted`

**Host-domain reconfigure** (v1.4+): `host_domain.change_initiated`

Target types: `team`, `project`, `deployment`, `invite`, `accessToken`, `user`, `deployKey`, `domain`, `synapse` (instance-level), `dnsCredential`.

## The team audit log (admin-only)

Endpoint: `GET /v1/teams/{teamRef}/audit_log?limit=50&cursor=<id>`.

Handler: `listAuditLog` in `synapse/internal/api/audit_log.go`. Admin-only — `role != models.RoleAdmin` returns `403 forbidden`. Members are NOT given partial visibility.

Pagination: keyset on `(created_at DESC, id DESC)`. Default limit 50, max 200.

Dashboard renders at `/teams/<ref>/audit` via the shared `AuditLogView` component (`dashboard/components/AuditLogView.tsx`), polling every 30 seconds.

### Filtering and search

Client-side filters (the API serves a flat list, all filtering happens in the browser):

- Date range chips: 24h / 7 days / 30 days / All time
- Actor dropdown: derived from data
- Verb buckets: Create/Add, Delete/Remove, Update/Rename, Members & Tokens, Domains & DNS, Settings
- Target type dropdown
- Free-text search

Events group by day with a sticky header ("Today" / "Yesterday" / weekday). Each row expands to show full metadata JSON.

### Export

Two formats, both filtered by the current view:

- **CSV** — `id, createTime, action, actorEmail, actorName, targetType, targetId, targetName, metadata`. Cells with commas/quotes/newlines CSV-escaped.
- **JSON** — array of normalised event objects.

Filename: `synapse-team-audit-<YYYY-MM-DD>.csv` (or `.json`). Download fully client-side via `Blob` + `URL.createObjectURL`.

## The project activity feed (member+)

Endpoint: `GET /v1/projects/{id}/activity?limit=30&cursor=<id>`.

Handler: `ActivityHandler.ServeHTTP` in `synapse/internal/api/activity.go`. Permissions match the project read gate: any viewer / member / admin can read.

### Project scope query

```sql
WHERE e.team_id = $1
  AND (
    (e.target_type = 'project' AND e.target_id = $2)
    OR (e.target_type = 'deployment' AND d.project_id = $2)
    OR (e.target_type = 'domain' AND dd_dep.project_id = $2)
  )
```

So a project's activity covers direct project actions, deployment actions for that project, and domain actions for those deployments. Account-level events, DNS credentials, and instance-level events (`synapse`) are deliberately excluded.

### Server-side `targetName` resolution

The query joins `projects` / `deployments` / `deployment_domains` to populate a `target_name` column, so the client renders "brave-dolphin-1060 created" without an extra fetch per event:

```sql
COALESCE(p.name, d.name, dd.domain, '') AS target_name
```

### The timeline view

Component: `ActivityFeed` (`dashboard/components/ActivityFeed.tsx`), mounted on the project home below the Topology panel. Polls every 20 seconds.

What sets it apart from the audit log table:

- **Time-relative timestamps** — "2h ago" instead of full ISO
- **Burst grouping** — same actor + same action + same target type + within 5 minutes collapses into one expandable entry
- **Narrative verb mapping** — `visualFor()` maps action strings to `{verb, tone, icon}`
- **Hides when empty** — newly-created project doesn't render empty timeline. Permission failures (401/403) hide silently

The same `AuditLogView` component also renders project activity at `/teams/<ref>/<project>/settings/audit` with `source.kind = "project"` — same renderer, different data source, member-visible permission.

## Tier-1 honesty

- **No tamper-evident chain.** `audit_events` is an append-only insert pattern, but Postgres `UPDATE`/`DELETE` privileges still let `postgres` rewrite history.
- **No per-audit-event alerting.** There's no "email me when a deploy key is revoked" hook — the data is there if you want to wire your own log shipper. (Deployment **down** alerting is a separate, real feature since v1.26 — see the **Deployment-down alerts** page.)
- **Audit log is admin-only on the team route.** A project member who wants project-scoped events uses `/teams/<ref>/<project>/settings/audit` (member-visible).
