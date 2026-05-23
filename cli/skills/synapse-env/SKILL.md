---
name: synapse-env
description: >
  Manage project-default environment variables in Synapse — the values
  that get seeded into new Convex deployments at creation time. Use
  when the user wants to set/list/delete env vars, sync from a .env
  file, add a secret (STRIPE_KEY, OPENAI_API_KEY, WEBHOOK_SECRET, …),
  or rotate credentials.
autoTrigger:
  - "set env var", "set environment variable", "add a secret"
  - "STRIPE_KEY", "OPENAI_API_KEY", "RESEND_API_KEY", "SECRET"
  - "convex env", "synapse env"
  - "rotate credentials", "update production env"
  - "sync .env file to convex"
---

# Project env vars in Synapse

Synapse stores **project-default** env vars in Postgres (table
`project_env_vars`). When a NEW deployment is provisioned, those vars
are seeded into the Convex backend container at start. **Existing
deployments are NOT automatically updated** — the dashboard has an
"Apply to existing deployments" button for that (or trigger the same
via the API; see at the bottom).

> All four env verbs use `--for=<dev|prod|preview>` (comma-separated
> for set/push) to scope the variable to specific deployment types.
> There is no `--types=` flag.

## CLI commands (all under `synapse env`)

### `synapse env list` — show current vars

```bash
synapse env list                       # values shown in plain text
synapse env list --mask                # redact values (length-preserving)
synapse env list --for=prod            # only vars that apply to PROD
synapse env list --json
```

Default behaviour shows values; pass `--mask` to redact them (useful
when sharing a terminal recording). Columns: `NAME`, `VALUE`,
`DEPLOYMENT_TYPES` (where `(all)` means dev + prod + preview).

### `synapse env set KEY=value [KEY=value …]` — set one or many

```bash
synapse env set STRIPE_KEY=sk_live_xxxx
synapse env set OPENAI_API_KEY=sk-yyyy RESEND_API_KEY=re_zzzz
```

Names must match `[A-Z_][A-Z0-9_]*`. Values are split on the first `=`,
so `FOO=a=b` sets FOO to `a=b`. By default applies to ALL deployment
types. To restrict:

```bash
synapse env set --for=dev STRIPE_TEST_KEY=sk_test_xxxx
synapse env set --for=prod STRIPE_LIVE_KEY=sk_live_xxxx
synapse env set --for=dev,preview FEATURE_FLAG_NEW_UI=1
```

### `synapse env unset KEY [KEY …]` — delete one or many

```bash
synapse env unset DEPRECATED_KEY
synapse env unset KEY_ONE KEY_TWO
```

### `synapse env pull` — dump as `.env` to stdout or file

```bash
synapse env pull                              # writes to stdout
synapse env pull --out=.env.production        # writes to file (mode 0600)
synapse env pull --for=prod                   # only PROD-scoped vars
synapse env pull --for=prod > .env.prod       # equivalent via shell redirection
```

The file is `.env`-shaped (`KEY=value` per line, quoted when needed).
**The file contains plain secrets — gitignore it.**

### `synapse env push` — apply from a `.env`-shaped file

```bash
synapse env push --from=.env.production
synapse env push --from=.env.prod --for=prod --yes
synapse env push --from=.env.production --dry-run    # preview only, no writes
```

Additive — sets / updates each `KEY=value` in the file, leaving other
project vars alone. **There is no `--prune` flag; the CLI never deletes
vars to match a file.** To remove a var, use `synapse env unset KEY`
explicitly.

Push refuses to write these reserved names (they would conflict with
Convex's self-hosted bootstrap):
`CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`,
`CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`,
`NEXT_PUBLIC_CONVEX_SITE_URL`. A `.env` containing any of these is
rejected before any backend call.

> `synapse env set` does NOT enforce that block. It will happily store
> e.g. `CONVEX_DEPLOYMENT=foo` if you ask it to — don't.

## What goes in project env vars vs `.env.local`

| Variable | Where | Why |
|---|---|---|
| `STRIPE_KEY`, `OPENAI_API_KEY`, … (your app's secrets) | **`synapse env set`** | Used by Convex functions at runtime, available via `process.env` inside actions / queries / mutations |
| `NEXT_PUBLIC_*` (browser vars) | `.env.local` only | Bundled into the Next.js client at build time. Not visible to Convex backend. |
| `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY` | `.env.local` only — **managed by `synapse select`** | Used by `npx convex` CLI to authenticate against the right deployment. NEVER hand-edit. |
| `CONVEX_DEPLOYMENT` | NEITHER (synapse comments it out) | Convex Cloud convention; in self-hosted mode it conflicts with `CONVEX_SELF_HOSTED_*` and the official Convex CLI errors. |

## Applying changes to EXISTING deployments

When you `synapse env set` a new var, it's seeded into deployments
**created from this point forward**. To push the change to an existing
running deployment:

**Via the dashboard (easiest)**: project → Settings → Environment
Variables → "Apply to existing deployments" button. ~15s downtime per
non-HA deployment.

**Via the API directly (CI / scripts)**:
```bash
curl -X POST \
  -H "Authorization: Bearer $SYNAPSE_PAT" \
  https://<host>/v1/projects/<project-id>/sync_env_to_deployments
```

## Deployment-type filtering — example

You have `STRIPE_TEST_KEY` for dev/preview and `STRIPE_LIVE_KEY` for
prod. Don't want them to bleed into each other:

```bash
synapse env set --for=dev,preview STRIPE_TEST_KEY=sk_test_xxx
synapse env set --for=prod STRIPE_LIVE_KEY=sk_live_xxx
```

In your Convex function code, write defensively:

```ts
const key = process.env.STRIPE_LIVE_KEY ?? process.env.STRIPE_TEST_KEY;
if (!key) throw new Error("Stripe key not configured for this deployment");
```

## Common operator mistake the agent should catch

If the user says *"I set the env var but the function still gets
undefined"*:

1. Did they set it project-level (`synapse env set`) or just in their
   local `.env.local`? `.env.local` is for the CLIENT, not the Convex
   backend. The backend reads from the env vars baked into the
   container at provision time.
2. If they set it after the deployment was created, did they "Apply to
   existing deployments"? If not, the running container doesn't have
   it yet.
3. Did they restart the function? Convex functions cold-start when
   redeployed; they don't pick up env changes mid-flight even after
   the container restarts.

## Quick reference

| Goal | Command |
|---|---|
| Show what's configured | `synapse env list` |
| Mask values (for screen-share) | `synapse env list --mask` |
| Add / update one var | `synapse env set KEY=value` |
| Add multiple at once | `synapse env set K1=v1 K2=v2 K3=v3` |
| Restrict to specific deployment types | `synapse env set --for=prod KEY=value` |
| Delete a var | `synapse env unset KEY` |
| Backup to a file | `synapse env pull --out=.env.backup` |
| Restore from a file | `synapse env push --from=.env.backup` |
| Preview a push (no writes) | `synapse env push --from=.env.backup --dry-run` |
| Apply changes to existing deploys | Dashboard "Apply to existing", or `POST /v1/projects/{id}/sync_env_to_deployments` |
