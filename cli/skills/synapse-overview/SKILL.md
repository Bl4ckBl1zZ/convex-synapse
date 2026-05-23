---
name: synapse-overview
description: >
  Background on Synapse — the self-hosted Convex control plane this project
  uses instead of (or alongside) Convex Cloud. Loads when the agent needs
  context on what Synapse is, how it differs from Convex Cloud, or what
  the project's runtime architecture looks like.
autoTrigger:
  - when the user asks "what is synapse" / "como funciona o synapse"
  - when explaining differences vs Convex Cloud
  - when the agent needs runtime-architecture context (which container holds
    state, where deploys live, who owns the URL)
  - first time the agent reads this project — load this to ground all
    subsequent answers in the right model
---

# Synapse — context for AI agents working in this project

This project's Convex backend is hosted on **Synapse**, an open-source
self-hosted alternative to Convex Cloud. Anything that would have hit
`*.convex.cloud` in a Cloud setup goes through the Synapse host
instead.

> **Heads up to the agent:** "Synapse" and "Convex" are not the same
> thing. Synapse is the control plane (teams / projects / multi-deployment
> management) — Convex itself (the database + query engine + functions
> runtime) is unchanged. Each Synapse deployment runs the official
> open-source Convex backend container.

## Mental model

```
your laptop ────► npx convex (CLI) ────► one Convex backend container
                  │                       (= a Synapse deployment)
                  │
                  └─► synapse CLI wraps   ◄── the synapse-api Go service
                      and injects creds       routes traffic to the right
                      from the host           container by Host header
```

- **Host**: a VPS running `synapse-api` (Go), Postgres, Caddy, plus N
  Convex backend containers.
- **Team**: groups users + projects (synapse-side concept).
- **Project**: like Convex Cloud projects — has env vars, members, and
  one or more deployments.
- **Deployment**: a single Convex backend container of type `dev`,
  `prod`, or `preview`. Each has its own SQLite (or Postgres+S3 if HA),
  admin key, and URL.
- **URL form**: wildcard subdomain by default
  (`<deployment-name>.app.<host>`, e.g.
  `brave-dolphin-1060.app.synapsepanel.com`). Optionally a per-deployment
  custom domain (`api.client.com`).

## Cloud vs Synapse — quick diff table

| Surface | Convex Cloud | Synapse |
|---|---|---|
| Auth | Account-based, `~/.convex/config.json` | Per-host JWT, `~/.synapse/config.json` |
| Local config | `CONVEX_DEPLOYMENT=dev:<name>` in `.env.local` | `CONVEX_DEPLOYMENT` **commented**, `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY` active |
| Dashboard | `dashboard.convex.dev` | operator's own host (e.g. `synapsepanel.com`) |
| API URL | `<name>.convex.cloud` | `<name>.app.<host>` |
| HTTP Actions URL | `<name>.convex.site` (separate domain) | same as API URL (one container, two routes) |
| CLI you run | `npx convex …` directly | **`synapse …`** which wraps `npx convex` with the right creds |
| Deployment provisioning | Cloud handles it | Each deployment is a Docker container on the host VPS |

## Why this matters for code generation

When generating commands, scripts, or CI configs that touch the Convex
backend, **prefer `synapse` over `npx convex` directly**:

| Want to … | Right command | Wrong (will fail or hit wrong env) |
|---|---|---|
| Watch + push schema | `synapse dev` | `npx convex dev` (no creds) |
| Push to prod | `synapse deploy` | `npx convex deploy` (no creds) |
| Run any other `npx convex` subcommand | `synapse convex <args>` | `npx convex <args>` direct |
| Get deployment credentials | `synapse credentials <name>` | manual lookup |

The `synapse` wrapper injects `CONVEX_SELF_HOSTED_URL` +
`CONVEX_SELF_HOSTED_ADMIN_KEY` into the child env so the underlying
Convex CLI authenticates correctly. It also strips
`CONVEX_DEPLOYMENT` from the env (the Convex CLI errors if both modes
are set together).

## What to load next

- For deploy-shaped questions → load `synapse-deploy`
- For "X is broken" / debugging → load `synapse-debug`
- For env vars / secrets → load `synapse-env`
- For dev vs prod vs preview workflows → load `synapse-multi-deployment`
- For a full command catalog → load `synapse-cli-reference`

## Files this project carries (Synapse-related)

| Path | Purpose | Commit it? |
|---|---|---|
| `.synapse/project.json` | links cwd to a team/project/deployment | Yes — shared by team |
| `.env.local` | Convex credentials for THIS machine | No — gitignored (admin key) |
| `.synapse/skills/` | these AI agent skills | Yes — shared |
| `.claude/skills/synapse-*` | symlinks → `.synapse/skills/synapse-*` | No — per-machine, gitignored |
| `~/.synapse/config.json` | this machine's session JWT | No — outside repo |

## Sanity check the agent can run

If you're not sure the project is properly linked, run
`synapse doctor`. It enumerates ~19 health checks (Node version, env
file, backend reachability, deployment health, optional local-HTTPS
dev category) and exits 0/1/2 based on severity. Includes auto-fix
flags (`--fix --yes`) for the recoverable ones.
