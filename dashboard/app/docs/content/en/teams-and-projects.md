# Teams and Projects

The Synapse permission model has two layers: **teams** at the top, **projects** inside teams. Audit events, invites, deployments and env vars all live somewhere in that hierarchy.

## Teams

A team is the top-level grouping. Every project belongs to exactly one team; every deployment belongs to one project, and inherits its team transitively. Team membership is the security boundary.

The teams a user belongs to drive:

- the team list at `/teams` / `GET /v1/teams`
- the audit log scope — every audit event is recorded against the team where it happened (`audit_events.team_id`)
- the team-scoped PAT surface (`/v1/teams/{ref}/access_tokens`)
- invite + membership endpoints below

### Creating a team

Dashboard-only — `/teams` shows a "Create team" button that calls `POST /v1/teams/create_team` with `{ name }`. Slug generation is automatic: `slugify(name)` → base candidate → numeric suffixes up to 8, then random (`acme-corp-a3f7`). The SELECT-EXISTS + INSERT race is closed by `db.WithRetryOnUniqueViolation(ctx, 10, ...)`.

### Slug rules

`teams.slug` is `citext` and globally unique. Slugs via `update_team` must match `^[a-z0-9-]+$`. Conflicts surface as `409 slug_taken`.

### Member roles

`team_members.role` accepts two values:

- `admin` — invite/remove members, change roles, create + manage tokens at team scope, transfer projects, delete the team
- `member` — create projects, create deployments, edit env vars; cannot touch the membership list

The Cloud OpenAPI spec also uses `developer` — `normaliseRole` accepts it as an alias for `member`. There is no team-level `viewer` (project-only role).

Demoting/removing the **last admin** is refused with `409 last_admin`, guarded by `SELECT COUNT(*) FROM team_members WHERE team_id = $1 AND role = 'admin'` in the same transaction.

### Inviting members

Admin only. `POST /v1/teams/{ref}/invite_team_member` with `{ email, role }`:

1. Generates a fresh `syn_*`-style opaque token via `auth.GenerateToken`.
2. Inserts a row into `team_invites` (UPSERT on `(team_id, email)` — re-inviting rotates the token).
3. Returns `{ inviteId, email, role, inviteToken }`.

Pending invites: `GET /v1/teams/{ref}/invites` (admin only — tokens are privileged). Cancellation: `POST /v1/teams/{ref}/invites/{inviteID}/cancel`.

### Accepting an invite

The recipient hits `/accept-invite?token=<token>`. If not logged in, sent to `/login?returnTo=/accept-invite?token=...` first.

The dashboard then calls `POST /v1/team_invites/accept { token }`. The handler runs the whole flow inside one transaction:

1. `SELECT ... FOR UPDATE` on the invite row where `accepted_at IS NULL` — invalid/consumed → `404 invite_not_found`.
2. `INSERT INTO team_members ... ON CONFLICT (team_id, user_id) DO NOTHING` — re-accept from a second session is a no-op.
3. `UPDATE team_invites SET accepted_at = now()` — consumes the invite.

**Single-use** — `accepted_at IS NULL` clause on the SELECT ensures the next call fails with `404`.

## Projects

A project sits under one team. It owns deployments (dev, prod, preview) and default env vars seeded into new deployments at create-time.

### Creating a project

`POST /v1/teams/{ref}/create_project { projectName }`. Slug allocation mirrors teams but uniqueness is **per team** — `UNIQUE(team_id, slug)`. So the same slug `blog` can exist in two different teams.

### The `Default` team and `demo` project

First-run installs end at zero-user state — `phase_verify` truncates `users` after the self-test. The first operator registers via the wizard at `/setup`:

1. Loading
2. Admin (creates first user via `/v1/auth/register` — becomes instance admin)
3. Demo (creates `Default` team + `demo` project — both via normal `/create_team` and `/create_project`)
4. Provisioning (kicks off a dev deployment so operator lands on a populated page)

`Default` and `demo` are nothing special — same schema as any other. The wizard exists to spare the first operator from staring at an empty dashboard.

### Project-level RBAC (v1.0+)

By default, a project inherits the role its members have at the team level. The v1.0 RBAC overlay lets a project admin **override** that per-user: a team member can be downgraded to project viewer, or a team-level member can be elevated to project admin without touching the team role at all.

The override layer is `project_members` (migration `000008_project_members`). When a row exists for `(project_id, user_id)`, its role wins; absence falls through to `team_members.role`. Resolution lives in `effectiveProjectRole`:

```go
func effectiveProjectRole(ctx, db, projectID, teamID, userID) (string, error) {
    // 1. project_members override (if any)
    // 2. team_members fallback
}
```

`loadProjectForRequest` and `loadDeploymentForRequest` both go through this helper.

The three project roles:

- `admin` — full control: rename, slug, transfer, delete, manage members + tokens
- `member` — create deployments, edit env vars, run `sync_env_to_deployments`
- `viewer` — read-only access to everything in the project

The role gates live as `canAdminProject(role)` and `canEditProject(role)`.

### Project membership endpoints

All under `/v1/projects/{id}/`:

- `GET /list_members` — merged list, with a `source: "project"|"team"` field
- `POST /add_member { userId, role }` — upserts a `project_members` override. Project admin only. **The target user must already be a member of the project's team.**
- `POST /update_member_role { memberId, role }` — upserts the override
- `POST /remove_member { memberId }` — deletes the override only. After removal the user falls back to their team-level role. Self-removal allowed for any role. Returns `404 no_override` if the user never had a project-level override

### Project transfer

`POST /v1/projects/{id}/transfer { destinationTeamId }`. The caller must be **admin of both the source team and the destination team**.

- Destination not reachable → `403 forbidden`
- Same team as source → `204 No Content` no-op
- Slug already taken in destination → `409 slug_taken`

The transfer is a single `UPDATE projects SET team_id = $1`. Deployments, env vars and audit events all hang off `project_id`, not `team_id`, so no follow-up writes are needed. Project-scoped access tokens keep working — their scope is `project_id`. Audit lands on **both** teams with `direction: "out"` / `direction: "in"`.

### Project deletion

`POST /v1/projects/{id}/delete` — admin only, **irreversible**. In one transaction:

1. `UPDATE deployments SET status = 'deleted' WHERE project_id = $1` — marks rows so the health worker stops trying to reconcile
2. `DELETE FROM projects WHERE id = $1` — CASCADE removes env vars, project members, deploy keys and the deployment rows

The provisioner tears down containers asynchronously. Once the row is gone, data, env vars, dev/prod/preview backends and any project-scoped tokens are all gone with it.
