# AI agent skills (`synapse skills`)

Bundled, version-controlled knowledge about Synapse that drops straight into your AI coding agent's skill catalogue. Shipped with CLI **v1.9.x**.

## What it is

The Synapse CLI ships a small library of Markdown "skills" that any compatible AI agent (Claude Code, the Anthropic Agent SDK, anything that reads project-local skill files) can load on demand. They teach the agent how Synapse differs from Convex Cloud, which `synapse` subcommand to reach for, what the benign warnings look like, and where state lives.

The intent is mundane and load-bearing: when an agent in your repo decides to deploy, debug, or set an env var, it should pick the *right* command on the first try — `synapse deploy`, not `npx convex deploy`. Without these skills the agent guesses from training data that predates self-hosted Convex.

## The six bundled skills

| Skill | Loads when… | Contains |
|---|---|---|
| `synapse-overview` | First time the agent reads the project; "what is synapse"; explaining Cloud vs self-hosted | Mental model, Cloud-vs-Synapse diff table, where state lives, where to load next |
| `synapse-deploy` | "deploy", "push to prod", "ship", "release", "rebuild backend" | `synapse dev` / `synapse deploy`, the y/N confirmation, benign `NEXT_PUBLIC_CONVEX_SITE_URL` warning, pre-deploy gates, decision tree |
| `synapse-debug` | "broken", "401", "stuck", "Email or password is incorrect", "deploy hangs", embedded-dashboard banner | `synapse doctor` first; canonical fixes for stale `project.json`, PowerShell code-page bug, wildcard-subdomain banner, stale `.env.local` |
| `synapse-env` | "set env var", "STRIPE_KEY", "OPENAI_API_KEY", "rotate credentials", "sync .env" | `synapse env list/set/unset/pull/push`, `--for=` scoping, reserved-key blocklist, project-vars-vs-`.env.local`, "Apply to existing deployments" |
| `synapse-multi-deployment` | "preview deploy", "staging", "switch to prod", "deploy to a specific deployment" | dev/prod/preview model, `synapse select`, `synapse deployment create`, preview-deploy CI pattern with app tokens |
| `synapse-cli-reference` | Any time the agent is about to run `synapse <cmd>` and needs to confirm syntax | Compact one-line-per-command catalogue, flags, return shape, exit codes, state-file paths |

Every skill is a single `SKILL.md` file with a YAML frontmatter (`name`, `description`, `autoTrigger`) plus a Markdown body. The frontmatter is what tells the harness *when* to load it.

## Install model

Skills live in three places at once:

```
.synapse/skills/
├── .bundled                          ← JSON stamp (committed)
├── synapse-overview/SKILL.md         ← canonical content (committed)
├── synapse-deploy/SKILL.md
├── synapse-debug/SKILL.md
├── synapse-env/SKILL.md
├── synapse-multi-deployment/SKILL.md
└── synapse-cli-reference/SKILL.md

.claude/skills/synapse-overview       ← symlink → ../../.synapse/skills/synapse-overview   (gitignore)
.agents/skills/synapse-overview       ← symlink (same target)                              (gitignore)
…
```

- **`.synapse/skills/`** is the canonical source. **Commit it.** Everyone on the team gets the same Synapse knowledge.
- **`.claude/skills/synapse-*`** and **`.agents/skills/synapse-*`** are symlinks (or NTFS junctions on Windows) into the canonical source. **Gitignore them** — they're per-machine reconstructable plumbing.

Symlinks use **relative** targets on Unix so the repo stays portable across checkout paths. Windows uses **directory junctions** (`fs.symlinkSync(target, link, "junction")`).

## Harness detection

| Harness | Marker (any of) | Symlink target |
|---|---|---|
| `claude` (Claude Code) | `.claude/` exists, or `CLAUDE.md` at repo root | `.claude/skills/synapse-*` |
| `agents` (Agent SDK convention) | `.agents/` exists, or `AGENTS.md` at repo root | `.agents/skills/synapse-*` |

If nothing is detected, install still defaults to creating `.claude/skills/` pre-emptively. Pass `--all-harnesses` to fan symlinks into every known harness regardless of detection.

## 4-state classification

`.synapse/skills/.bundled` stores a SHA-256 hash of every skill we last wrote:

```json
{
  "version": "1.9.0",
  "written_at": "2026-05-22T15:04:05Z",
  "skills": ["synapse-overview", "synapse-deploy", …],
  "hashes": { "synapse-overview": "a1b2…", "synapse-deploy": "c3d4…" }
}
```

On every `update` / `list`, each local file is classified four ways:

| State | Meaning | What `update` does |
|---|---|---|
| `missing` | No local `SKILL.md` for this bundled name | Creates from bundled content |
| `ok` | Local file == current bundled file (already up to date) | Leaves alone |
| `pristine` | Local file != bundled, but == stamp-recorded hash. Operator didn't touch it; bundled just changed. | Safely overwrites with new bundled content |
| `customised` | Local file diverges from BOTH bundled and stamp | **Preserves** the local file, reports the divergence. `--force` overrides |

Hashing normalises CRLF → LF and trims trailing whitespace per line.

## All five verbs

```bash
synapse skills install              # first-time setup
synapse skills update               # pull new content, preserve customisations
synapse skills list                 # status report (per-skill + per-harness symlinks)
synapse skills remove               # drop symlinks (keep .synapse/skills/)
synapse skills link                 # re-create symlinks only (no SKILL.md writes)
```

Common flags: `--force`, `--force-links`, `--all-harnesses`, `--purge`, `--json`.

## Doctor check `ai-skills-installed`

`synapse doctor` includes the AI-skills check. **Silently skipped** when no harness markers are present. **`ok`** when `.synapse/skills/` exists. **`warn`** when a harness IS detected but skills aren't installed yet — auto-fixable under `synapse doctor --fix --yes`.

## How to customise a bundled skill

Edit the `SKILL.md` in `.synapse/skills/<name>/` directly. The next `synapse skills update` will see it differs and classify it `customised` — your edits stay. To explicitly accept upstream and lose your edits, pass `--force`.

## How to add your own skill

The CLI **only manages files whose folder name starts with `synapse-`**. Drop any other folder into `.synapse/skills/`:

```
.synapse/skills/
├── synapse-overview/SKILL.md      ← managed by CLI
├── my-team-conventions/SKILL.md   ← yours, untouched by `synapse skills update`
```

The CLI won't try to symlink it into `.claude/skills/` — that's your responsibility.

## Why this exists

LLMs are confidently wrong about self-hosted Convex. They've been trained on years of `npx convex …` documentation and zero years of Synapse. With skills, the same prompt triggers `synapse-deploy`, which reminds the agent that `synapse deploy` is the wrapper, that it prompts y/N, and that the `NEXT_PUBLIC_CONVEX_SITE_URL` warning is decorative.

The cheapest way we know to make every AI agent in every Synapse-powered repo immediately correct.
