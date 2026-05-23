# Synapse CLI Reference

CLI version: `@iann29/synapse@1.9.2`. Node >= 18.17 required. Run `synapse --help` for the auto-generated catalogue, or `synapse <cmd> --help` for the per-command body.

Every command writes structured result to **stdout**, status/progress lines to **stderr**, and accepts `--json` anywhere on argv.

## Session

### `synapse login <url>`

Authenticate against a Synapse instance and persist the session in `~/.synapse/config.json` (mode `0600`, parent dir `0700`).

URL must be `http://` or `https://`. On TTYs, password is read in raw mode with echo suppressed. On non-TTY, reads `email\npassword\n` from stdin.

**Persisted shape:**

```json
{
  "baseUrl":      "https://synapse.example.com",
  "accessToken":  "...",
  "refreshToken": "...",
  "tokenType":    "Bearer",
  "user":         { "id": "...", "email": "...", "name": "..." }
}
```

**Silent refresh.** Any subsequent `synapse <cmd>` that hits the API wraps its client in a Proxy: a `401` triggers exactly one `POST /v1/auth/refresh` and replays the original call.

**Windows UTF-8.** Before raw-mode capture, the CLI calls `ensureUtf8Console()`. After read, checks for `U+FFFD` and refuses with a Windows-specific message pointing at `chcp 65001`.

```bash
synapse login https://synapse.acme.com
printf 'admin@example.com\nhunter2\n' | synapse login https://synapse.acme.com   # CI
```

### `synapse logout`

Deletes `~/.synapse/config.json`. No backend call.

### `synapse whoami`

Calls `GET /v1/me/`. Returns email + URL of the linked instance.

## Project linking

### `synapse select`

Walks `team → project → dev deployment → prod deployment` as a state machine.

- Auto-selects when only one option exists
- Type `b`/`back`/`0` to walk back one level
- 3 invalid answers aborts
- **dev mandatory** — no dev → throws
- **prod optional** — null accepted, prints warning with dashboard URL

Writes `.synapse/project.json` (refs only, safe to commit) + `.env.local` (`NEXT_PUBLIC_CONVEX_URL/SITE_URL` + `CONVEX_SELF_HOSTED_URL/ADMIN_KEY` + commented `CONVEX_DEPLOYMENT=dev:<name>`).

`DEBUG_SYNAPSE=1` dumps raw lists on stderr — diagnose missing menu entries.

### `synapse credentials <deployment> [--format env|shell|json]`

Hits `/v1/deployments/{name}/cli_credentials`. Default format `env`.

| Flag | Effect |
|---|---|
| `--format env` (default) | Paste-able into `.env.local` |
| `--format shell` | `export NAME=value` pairs — `eval "$(synapse credentials … --format shell)"` |
| `--format json` | Full response |

## Day-to-day

### `synapse dev [...convex-args]`

Sugar for `synapse convex --target dev dev [...args]`. Forwards all args to `npx convex dev`. `--once` is upstream Convex.

### `synapse deploy [--yes] [...convex-args]`

Sugar for `synapse convex --target prod deploy [...args]` with confirmation gate.

| Flag | Behaviour |
|---|---|
| `--yes` / `-y` | Skip the y/N prompt. **Mandatory in CI** |

Non-TTY refusal: `synapse deploy needs confirmation. Pass --yes...`. No prod deployment: `No prod deployment saved for this project. Run synapse select again.`

### `synapse convex [--target dev|prod] [...args]`

Escape hatch — delegates to `npx convex <args>` with Synapse credentials injected. Target inferred from first positional: `deploy` ⇒ `prod`, else ⇒ `dev`.

Before spawning: resolves deployment name, verifies session URL matches project URL, fetches fresh CLI credentials, deletes `CONVEX_DEPLOYMENT` from the child env, pre-announces benign `NEXT_PUBLIC_CONVEX_SITE_URL` warning.

```bash
synapse convex --help                      # upstream Convex help
synapse convex run messages:list           # query against dev
synapse convex --target prod env list      # list prod env vars
synapse convex import data.snapshot.gz     # restore to dev
```

## Visibility

### `synapse version [--json]`

Reports `cli`, `backend`, `node`, `platform`. Backend probe hits the **public** `GET /v1/install_status`.

### `synapse status [--project=<id>] [--json]`

Mirrors the dashboard's project page. Columns: **NAME** · **TYPE** · **STATUS** · **FORM** · **URL**.

URL form chip:

| Chip | Render | Meaning |
|---|---|---|
| `custom` | green | Custom domain (browser-reachable) |
| `wildcard` | green | Uses `SYNAPSE_BASE_DOMAIN` |
| `path` | dim | `/d/<name>/*` proxy. Browser OK; CLI breaks |
| `no-domain` | **red** | host:port — not browser-reachable |

### `synapse doctor [--fix] [--yes] [--verbose] [--json]`

**19 checks** across 5 categories: `local-env` (2) → `project` (7) → `backend` (3) → `deployments` (2) → `local-https-dev` (5).

Status values: `ok`, `warn`, `issue`, `skipped`. Exit: `0` clean, `1` warnings only, `2` issues.

`autoFix` kinds: `never`, `auto` (triggered by `--fix`), `prompt` (triggered by `--fix --yes`). The `local-https-dev` category is silently skipped when no `dev:https` script or cert exists.

Tip footer: `<N> issue(s) are auto-fixable — run synapse doctor --fix.` or combined when both classes exist.

### `synapse open [target] [--json]`

Targets: (none/`dashboard`) → `<baseUrl>/teams/<team-slug>/<project-id>`; `docs` → `https://docs.convex.dev`; `deployment <name>` → `<baseUrl>/embed/<name>`; `url` → `<baseUrl>`.

Pre-flight probe runs only for `dashboard`. Cross-platform: `open` (macOS), `start` (Windows shell), `xdg-open` (Linux).

### `synapse list <teams|projects|deployments> [--project=<id>] [--team=<slug>] [--json]`

Read-only catalogue. `list teams` always lists every team of the operator. `list projects` needs `--team=<slug|id>` or the linked team. `list deployments` needs `--project=<id>` or the linked project.

## Deployments

### `synapse deployment create [--type=...] [--ha] [--default] [--project=<id>] [--yes] [--json]`

Provisions a real Convex backend container. **The backend generates the deployment name** (`<animal>-<adjective>-NNNN`) — no positional accepted.

| Flag | Effect |
|---|---|
| `--type=dev\|prod\|preview\|custom` | Default `dev` |
| `--ha` | 2 replicas + Postgres + S3 backed; requires `SYNAPSE_HA_ENABLED` |
| `--default` | Mark as default for the project |
| `--project=<id>` | Operate on a non-linked project |
| `--yes` | Skip prod confirmation |
| `--json` | Machine-readable |

**Prod safety.** Creating `prod` prompts `Create a NEW PROD deployment under <project>? [y/N]`. In `--json` mode refuses without `--yes`.

### `synapse deployment delete <name> [--yes] [--confirm=<name>] [--json]`

Calls `POST /v1/deployments/{name}/delete`. Container destroyed, volume wiped, irreversible.

CLI fetches deployment first to learn type:

| Type | Required |
|---|---|
| `prod` | Typed-confirm: operator must type the deployment name. `--confirm=<name>` is the non-TTY equivalent. **`--yes` does NOT bypass.** |
| `dev`/`preview`/`custom` | y/N prompt or `--yes` |

### `synapse deployment rotate-key <name> [--yes] [--confirm=<name>] [--write] [--json]`

Calls `POST /v1/deployments/{name}/reissue_admin_key`. Re-mints admin key from current `INSTANCE_SECRET`. **Does NOT rotate `INSTANCE_SECRET`** — existing deploy keys keep working.

| Flag | Effect |
|---|---|
| `--write` | Also rewrite `.env.local` iff this is the linked dev deployment |

Adopted refusal: `Cannot rotate key for "<name>" — it's an adopted (external) deployment.`

### `synapse deployment status <name> [--watch[=<seconds>]] [--json]`

Snapshot. `--watch` polls every 2s until terminal (`running`/`failed`/`errored`/`deleted`/`stopped`). `--watch=<n>` overrides interval. `--watch` incompatible with `--json`.

## Env vars

All `env` subcommands operate on **project-default** env vars. Changing affects deployments created **after**, unless sync runs.

### `synapse env list [--for=<dev|prod|preview>] [--project=<id>] [--mask] [--json]`

**Default shows values** — `--mask` redacts. Columns: `NAME`, `VALUE`, `DEPLOYMENT_TYPES`.

### `synapse env set NAME=value [NAME2=value2 ...] [--for=dev,prod] [--project=<id>] [--json]`

**Multiple positionals = single transactional update.** Split on **first `=`** (so `FOO=a=b` sets FOO to `a=b`). Names match `/^[A-Z_][A-Z0-9_]*$/`.

**Flag is `--for=`, NOT `--types=`.**

### `synapse env unset NAME [NAME2 ...] [--project=<id>] [--json]`

Idempotent batch delete. Unknown name = silent.

### `synapse env pull [--out=<path>] [--for=<type>] [--project=<id>] [--json]`

**`--out=<path>` is a flag, NOT a positional.** Default = stdout. File write uses mode `0600`.

### `synapse env push [--from=<path>] [--for=<types>] [--project=<id>] [--dry-run] [--yes] [--json]`

**`--from=<path>` is a flag, NOT a positional.** Default `.env`.

**NO `--prune` flag.** `env push` only sets — never deletes. Use `env unset NAME` to remove.

**Deny list** (refused before any backend call):

- `CONVEX_SELF_HOSTED_URL`
- `CONVEX_SELF_HOSTED_ADMIN_KEY`
- `CONVEX_DEPLOYMENT`
- `NEXT_PUBLIC_CONVEX_URL`
- `NEXT_PUBLIC_CONVEX_SITE_URL`

## Local HTTPS dev

Turns `dev.myproject.com` into a real HTTPS dev URL for Next.js, via mkcert + hosts file + `package.json` `dev:https` script.

### `synapse https setup <domain> [--force] [--yes] [--dry-run] [--skip-hosts] [--skip-script] [--verbose] [--json]`

Five-phase: **SCAN → PLAN → PREVIEW → EXECUTE → VERIFY**. Touches mkcert (`-install` if needed), `~/.config/dev-certs/<domain>/<domain>.pem` + key (mode `0600`), hosts file (sudo prompt), `package.json` (`dev:https` script).

### `synapse https doctor <domain> [--json]`

Read-only mirror of SCAN+PLAN.

### `synapse https status [domain] [--json]`

Without domain: lists certs in `~/.config/dev-certs/`. With domain: deep diagnostic.

### `synapse https remove <domain> [--keep-certs] [--keep-script] [--keep-hosts] [--yes] [--json]`

Symmetric undo. Idempotent.

### `synapse https migrate [--cwd | --root=<path>] [--keep-old] [--dry-run] [--yes] [--json]`

Moves legacy `dev.*.pem` pairs into `~/.config/dev-certs/<domain>/`, rewrites `package.json`.

## AI agent skills

### `synapse skills install [--force] [--force-links] [--all-harnesses] [--json]`

First-time + idempotent. Writes stamp at `.synapse/skills/.bundled` with sha256 per skill for the 3-way diff.

### `synapse skills update [--force] [--force-links] [--json]`

Same code as install; verb distinct for intent + render header. Preserves customisations.

### `synapse skills list [--json]`

4-state classification: `ok` / `pristine` (safe to update) / `customised` (preserved on update) / `missing`.

### `synapse skills remove [--purge] [--json]`

`--purge` also deletes `.synapse/skills/`. Refuses to touch non-symlinks.

### `synapse skills link [--force] [--all-harnesses] [--json]`

Re-create harness symlinks only. No SKILL.md writes. Common after fresh clone.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | General failure, warnings only |
| `2` | `synapse doctor` issues |

## Common flags

| Flag | Where | Behaviour |
|---|---|---|
| `--json` | every command | Stripped from argv; result emitted as one line on stdout |
| `--help` / `-h` | every command | Per-command help renderer |
| `--yes` / `-y` | confirmation-bearing commands | Skip prompt. **Mandatory in CI** |
| `--project=<id>` | resource commands | Operate against non-linked project |
| `--team=<slug\|id>` | `list projects` | Override linked team |

## State file locations

| Path | Mode | Purpose |
|---|---|---|
| `~/.synapse/config.json` | `0600` (dir `0700`) | Session bundle. Override with `SYNAPSE_CLI_CONFIG=<path>` |
| `.synapse/project.json` | `0600` | Refs only — safe to commit |
| `.env.local` | `0600` | NEVER commit — has admin key |
| `.synapse/skills/<name>/SKILL.md` | regular | Bundled skill source of truth |
| `.synapse/skills/.bundled` | regular | `{ version, written_at, skills, hashes }` |
| `.claude/skills/synapse-*` | symlink | Relative symlink → `.synapse/skills/synapse-*` (Windows: junction) |
| `.agents/skills/synapse-*` | symlink | Same shape |
| `~/.config/dev-certs/<domain>/<domain>.pem` | regular / `0600` | mkcert pair per domain |

**Environment variables:**

| Var | Effect |
|---|---|
| `SYNAPSE_CLI_CONFIG` | Override session config path |
| `DEBUG_SYNAPSE=1` | `synapse select` dumps raw lists on stderr |
| `CONVEX_DEPLOYMENT` | If set in shell, `select` warns and `doctor` raises a warn |

## Commands that DO NOT exist

| Reach-for | Use instead |
|---|---|
| `synapse logs` | `docker logs synapse-<deployment-name>` or `synapse open deployment <name>` |
| `synapse team` / `synapse teams` (verbs) | Dashboard at `<baseUrl>/teams`; `synapse list teams` reads only |
| `synapse project` (verbs) | Dashboard at `<baseUrl>/teams/<team>/<project>/settings`; `synapse list projects` reads only |
| `synapse domain` | Dashboard at `<baseUrl>/admin/host-domain` (wildcard) or per-deployment (custom) |
| `synapse env get NAME` | `synapse env list --json | jq '.configs[] | select(.name=="X")'` |
| `synapse deployment list` | `synapse list deployments` or `synapse status` |
| `synapse env push --prune` | Doesn't exist. Use `synapse env unset NAME` |
| `synapse deployment create --name=...` / `--reference=...` | Backend generates the name; no flag overrides |
| `synapse cli upgrade` | `npm i -g @iann29/synapse` — upgrade via your package manager |

For anything else, fall back to `synapse convex <subcommand>` (escape hatch) or hit the API directly.
