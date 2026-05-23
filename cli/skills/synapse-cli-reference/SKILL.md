---
name: synapse-cli-reference
description: >
  Compact, agent-friendly catalogue of every `synapse <cmd>` command:
  one-line summary, key flags, return shape. Read this whenever the
  agent needs to pick the right command, or needs to script the CLI
  without running --help repeatedly.
autoTrigger:
  - any time the agent is about to invoke `synapse <something>` and
    needs to confirm syntax / flags
  - "list synapse commands", "what synapse commands exist"
  - when scripting CI / shell wrappers around the CLI
---

# Synapse CLI command catalogue

All commands respect `--json` for machine-parseable output (printed to
stdout, with human messages routed to stderr so JSON pipes stay clean).
All commands accept `--help` for the verbose version.

## Session

| Command | Purpose | Key flags / args |
|---|---|---|
| `synapse login <url>` | Authenticate against a Synapse instance, save session in `~/.synapse/config.json` (mode 0600). Refresh token TTL 30d. | Prompts for email + password. Non-TTY: piped `email\npassword` works. |
| `synapse logout` | Clear the saved session. | none |
| `synapse whoami` | Print the saved email + URL. | none |

## Project linking

| Command | Purpose | Key flags / args |
|---|---|---|
| `synapse select` | Interactive picker: team → project → dev → prod. Writes `.synapse/project.json` + `.env.local`. Auto-selects when only one option exists at a level. | none |
| `synapse credentials <name>` | Print `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY` for a deployment. | `--format=env\|shell\|json` (default: env) |

## Day-to-day

| Command | Purpose | Key flags / args |
|---|---|---|
| `synapse dev` | `convex dev` against the linked DEV deployment. Watch + push. | `--once` for one-shot. Other flags forwarded to `convex dev`. |
| `synapse deploy` | `convex deploy` against the linked PROD with confirmation. | `--yes` to bypass confirm (CI). |
| `synapse convex <subcommand>` | Escape hatch: run ANY `convex` subcommand with Synapse creds injected. | passthrough |

## Visibility

| Command | Purpose | Key flags / args |
|---|---|---|
| `synapse version` | Show CLI / backend / Node / OS versions. | `--json` |
| `synapse status` | List deployments in the linked project — name, type, status, URL form. | `--json` |
| `synapse doctor` | Health-check panorama: ~12 checks across local env / project / backend / deployments. Exits 0 / 1 / 2 by severity. | `--fix` (auto-safe), `--fix --yes` (also prompt-class), `--verbose`, `--json` |
| `synapse open [target]` | Open URL in browser. Default: dashboard for linked project. | targets: `dashboard` (default) / `docs` / `deployment <name>` / `url` |
| `synapse list <kind>` | List teams / projects / deployments. Works without `synapse select`. | kind ∈ `teams`, `projects`, `deployments`. `--project=<id>` to scope deployments. `--json`. |

## Deployments

| Command | Purpose | Key flags / args |
|---|---|---|
| `synapse deployment create` | Create a new Convex deployment under the linked project. | `--type=dev\|prod\|preview` (default: dev), `--reference=<text>`, `--ha` (HA mode) |
| `synapse deployment delete <name>` | Delete a deployment (container + volume — irreversible). | `--yes` to skip confirm |
| `synapse deployment rotate-key <name>` | Re-mint the deployment's admin key from the existing instance secret (cures stale credentials without rotating the secret). | none |
| `synapse deployment status <name>` | Show one deployment's state, URL, HA shape. | `--watch` to poll until ready, `--json` |

## Env vars

| Command | Purpose | Key flags / args |
|---|---|---|
| `synapse env list` | List project-default env vars (values masked). | `--json` |
| `synapse env set KEY=v [KEY=v…]` | Set one or more. | `--types=dev,prod,preview` (default: all three) |
| `synapse env unset KEY [KEY…]` | Delete one or more. | none |
| `synapse env pull [path]` | Dump as `.env` to stdout or file. | none |
| `synapse env push <path>` | Apply a `.env`-shaped file. | `--prune` to also delete vars not in file |

## Skills (AI agent integration)

| Command | Purpose | Key flags / args |
|---|---|---|
| `synapse skills install` | Write bundled Synapse skills to `.synapse/skills/`, symlink to detected harnesses (`.claude/skills/`, `.agents/skills/`). | none |
| `synapse skills update` | Refresh bundled skills, preserving customizations (3-way diff). | `--force` to overwrite, `--keep-mine` to only patch new skills |
| `synapse skills list` | Show installed skills + symlink targets + drift status. | `--json` |
| `synapse skills remove` | Undo install: remove symlinks. | `--purge` to also delete `.synapse/skills/` |
| `synapse skills link` | Re-create missing symlinks (idempotent). | none |

## Escape hatch

| Command | Purpose | Key flags / args |
|---|---|---|
| `synapse convex <args>` | Pass-through to `npx convex <args>` with Synapse creds injected + `CONVEX_DEPLOYMENT` stripped. Use for any `convex` subcommand we don't wrap. | passthrough |

## Common flags (all commands)

- `--json` — machine-parseable output to stdout (no decorative stderr)
- `--help` / `-h` — command-specific help
- `--yes` / `-y` — bypass confirmations where applicable

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Warnings present (doctor) OR generic failure |
| `2` | Issues present (doctor) — blocks deploys |

## Where state lives

- `~/.synapse/config.json` — auth session (mode 0600)
- `.synapse/project.json` — directory-level link to project + DEV/PROD
- `.synapse/skills/` — bundled AI skills (this catalog ships here)
- `.env.local` — Convex credentials for the linked DEV (auto-managed)
- `.claude/skills/synapse-*` — symlinks created by `synapse skills install`
- `.agents/skills/synapse-*` — same, for the Agent SDK convention
