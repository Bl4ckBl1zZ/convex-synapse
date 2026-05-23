# Environment variables

## Project-default env vars

Synapse manages **project-default environment variables** — a set of `KEY=value` pairs scoped to one project. They live in the `project_env_vars` Postgres table (added in migration `000001_init`) with one row per `(project_id, name)` pair, and they're the primary surface for "make these secrets available to the Convex backend at runtime."

Schema, in summary:

| Column             | Type          | Notes                                                                    |
|--------------------|---------------|--------------------------------------------------------------------------|
| `project_id`       | UUID          | FK to `projects(id)`. ON DELETE CASCADE.                                 |
| `name`             | TEXT          | Validated `[A-Z_][A-Z0-9_]*` by the CLI before push.                     |
| `value`            | TEXT          | Free-form; not encrypted at rest in `project_env_vars`.                  |
| `deployment_types` | TEXT[]        | Subset of `{dev, prod, preview}` — see below. Defaults to all three.     |
| `updated_at`       | TIMESTAMPTZ   | Bumped on every set / overwrite.                                         |

`UNIQUE (project_id, name)` prevents duplicates — the same name in the same project means you intend to overwrite.

## How they reach the container

Env vars are **seeded into the deployment container at provisioning time**. The provisioner worker reads them in `loadRuntimeEnvVars`:

```sql
SELECT name, value
  FROM project_env_vars
 WHERE project_id = $1
   AND $2 = ANY(deployment_types)
 ORDER BY name ASC
```

…where `$2` is the new deployment's type (e.g. `dev`). The matching rows are merged with the system env vars (`INSTANCE_NAME`, `INSTANCE_SECRET`, S3/Postgres for HA, `CORS_ALLOWED_ORIGINS` for custom domains, etc) and passed to `docker run` as `-e` flags.

The key consequence: **changing an env var afterwards does NOT touch already-running deployments**. New deployments pick the value up automatically; existing deployments keep the value they were created with until you push the change yourself via "Apply to existing deployments" (see below).

## Deployment-type scoping

Each env var carries a `deployment_types` array. Synapse uses it to decide which subset of a project's deployments receive the var at provisioning time:

| `deployment_types`         | Reaches                                          | Typical use                                                       |
|----------------------------|--------------------------------------------------|-------------------------------------------------------------------|
| `{dev, prod, preview}`     | Every deployment in the project (default)        | Shared infra (Sentry DSN, posthog key).                          |
| `{prod}`                   | Only `prod` deployments                          | Production-only secrets (live Stripe keys, real e-mail API keys). |
| `{dev}`                    | Only `dev` deployments                           | Sandbox API endpoints, fake credentials.                          |
| `{preview}`                | Only `preview` deployments                       | Per-branch CI tokens.                                             |
| `{dev, preview}`           | Dev + preview (everything that isn't `prod`)     | Test fixtures.                                                    |

`custom`-type deployments are not currently selectable by the `deployment_types` array — they receive every env var that has at least one type set. The dashboard's add-var panel lets you tick any combination of `DEV / PROD / PREVIEW` (defaults to all three).

## Dashboard panel

`dashboard/components/EnvVarsPanel.tsx` is the operator-facing UI. From it you can:

- **Add** a new var (name, value, which deployment types it applies to). Submitted as `op:"set"` on `update_default_environment_variables`.
- **Reveal / hide** values per row. The default is masked (dots, same length as the value clamped to 8-24 chars) so a shoulder-surfer or a screen-share doesn't leak secrets just because the project page was open. Hit "Reveal" to see the plaintext.
- **Delete** a var (`op:"delete"`).
- **Apply to existing deployments** — recreates running deployments in the project so they pick up current env values. Adopted, stopped, and non-running deployments are skipped and counted in `skipped`.

The panel shows colored badges for non-default `deployment_types` (cyan `DEV`, amber `PROD`, violet `PREVIEW`). A var that targets all three deployment types renders no badges — that's the default and the visual cleanest case.

## CRUD operations

Wire-shape mirrors the Convex Cloud spec:

### `GET /v1/projects/{id}/list_default_environment_variables`

Returns `{ "configs": [{ "name", "value", "deploymentTypes" }] }` sorted by name. Permission: any project member.

### `POST /v1/projects/{id}/update_default_environment_variables`

Body: `{ "changes": [{ "op", "name", "value?", "deploymentTypes?" }] }`.

`op` is `"set"` or `"delete"`. The whole batch runs in **one Postgres transaction** — either every change applies, or none do. `set` uses `INSERT ... ON CONFLICT DO UPDATE`, so calling it twice in a row is idempotent. `delete` is a `DELETE WHERE project_id AND name` — silent no-op if the row doesn't exist.

The endpoint validates `name` is non-empty but does **not** re-validate the `[A-Z_][A-Z0-9_]*` shape — that's the CLI's job before the request goes out. The dashboard's add form is permissive about case for the same reason.

Permission: `canEditProject` (project admin or member). Viewers get 403.

### `POST /v1/projects/{id}/sync_env_to_deployments`

Recreates every Synapse-managed, currently-running deployment of the project so they pick up the current env-var values. Returns `{ total, recreated, skipped, errors?, notice? }`.

| Deployment state                        | Result      | Why                                                            |
|-----------------------------------------|-------------|----------------------------------------------------------------|
| Non-HA, status=running, has host port  | `recreated` | Container is hard-restarted (~15 s of downtime each).          |
| HA, status=running                      | `recreated` | One replica at a time is rolled; the deployment stays reachable. |
| Adopted                                 | `skipped`   | Synapse doesn't control the container.                        |
| `status != running`                     | `skipped`   | Will pick up the new values on its next provision.            |
| Single-replica missing `host_port`      | `skipped`   | Defensive — a half-formed row.                                |

Iteration is sequential, not parallel, so a stuck recreate doesn't pin every deployment in the project simultaneously.

## Masking values in the CLI

`synapse env list` shows values **in clear by default**. Pass `--mask` to redact each value to `*` repeated to the value's length:

```
synapse env list                     # plaintext (terminal use)
synapse env list --mask              # safe for screencasts / paired sessions
synapse env list --json --mask       # JSON with the same mask
synapse env list --for=prod --mask   # only PROD-targeted vars, masked
```

The mask is length-preserving on purpose: a fixed-width blob would leak the length to anyone watching. If you want zero leakage, redirect to a file with `umask 077` first.

## Restricted names (CLI `env push`)

`synapse env push` refuses to push specific names that belong in the operator's local `.env.local`, NOT in the project-default surface that gets injected into every container. The deny list is in `cli/lib/commands/env-push.js`:

| Name                              | Why it's denied                                                                 |
|-----------------------------------|----------------------------------------------------------------------------------|
| `CONVEX_SELF_HOSTED_URL`          | Per-deployment client config — managed by `synapse select`, not the project.    |
| `CONVEX_SELF_HOSTED_ADMIN_KEY`    | Per-deployment secret — must never reach the server-side project surface.       |
| `CONVEX_DEPLOYMENT`               | Per-developer pointer to which deployment is active locally.                    |
| `NEXT_PUBLIC_CONVEX_URL`          | Frontend config — managed by `synapse select`.                                  |
| `NEXT_PUBLIC_CONVEX_SITE_URL`     | Frontend config — managed by `synapse select`.                                  |

The CLI surfaces **every** violation in a single error so you can fix the file once. The check runs **before** any backend call, so a denied push never modifies anything.

The dashboard does not block these names on the UI side. Pushing them through the dashboard works mechanically but defeats the same intent — keep them out of project defaults.

## `.env` file format (pull / push)

Both `synapse env pull` and `synapse env push` use a standard dotenv format. Same parser; values round-trip cleanly.

What `synapse env pull` emits:

```
# Synapse-managed project-default env vars
# Generated by `synapse env pull` — do not edit by hand;
# re-run the command after changes upstream.
API_KEY="abc123"
SENTRY_DSN="https://...@sentry.io/..."
STRIPE_SECRET_KEY="sk_live_..."
```

Quoting follows the same rules as `.env.local` (double quotes for any value with whitespace, `=`, `#`, or special characters; backslash-escapes for embedded quotes / newlines). With `--out=<path>` the file is written with mode `0600`.

What `synapse env push` accepts:

- One `NAME=value` per line.
- Quoted values (single or double) are unquoted.
- Comments (`#` at column 0 or after whitespace) and blank lines are ignored.
- A leading `export ` is tolerated and stripped.

Round-trip is guaranteed: `synapse env pull --out=.env && synapse env push --from=.env --dry-run` reports no changes.

### Push flags

| Flag             | Effect                                                                                       |
|------------------|----------------------------------------------------------------------------------------------|
| `--from=<path>`  | File to read (default `.env`).                                                               |
| `--for=<types>`  | Comma-separated subset of `dev,prod,preview` — stamps `deploymentTypes` on every var.        |
| `--project=<id>` | Override the linked project.                                                                 |
| `--dry-run`      | Print the diff and exit; no backend call. Recommended on first push.                         |
| `--yes`          | Skip the `y/N` confirmation prompt (required when used with `--json` for CI).                |
| `--json`         | Machine-readable output.                                                                     |

`synapse env push` is a **set-only** operation: it inserts or overwrites every name in the file, but **never** removes vars that the project has but the file does not. If you want to delete a var, use `synapse env unset <name>` or the dashboard panel directly.
