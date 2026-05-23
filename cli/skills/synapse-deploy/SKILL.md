---
name: synapse-deploy
description: >
  How to deploy Convex code (schema + functions + components) via the
  Synapse CLI. Covers dev push, prod push, the benign warnings to
  expect, and what NOT to do. Use whenever the user asks to deploy,
  push, release, ship, or any synonym thereof.
autoTrigger:
  - "deploy", "push to prod", "ship to production", "release"
  - "convex deploy", "convex dev"
  - "rebuild backend", "redeploy schema"
  - any time the user wants their local convex/ folder to go live
---

# Deploying with Synapse

This project is Synapse-managed. **Always use `synapse dev` /
`synapse deploy` — never `npx convex dev` / `npx convex deploy` directly**.
The `synapse` wrapper injects the right `CONVEX_SELF_HOSTED_*`
credentials; bare `npx convex` will either fail with auth errors or
target the wrong environment.

## The two main commands

### `synapse dev` — push to DEV, watch + hot-reload

```bash
synapse dev
```

- Targets the DEV deployment linked in `.synapse/project.json`
- Watches `convex/` and pushes on every save
- Equivalent to `npx convex dev` against Cloud
- Add `--once` for a one-shot push without watch:
  `synapse dev --once`
- Forwards any other flag to the underlying `convex dev`:
  `synapse dev --typecheck=disable`

### `synapse deploy` — push to PROD, with confirmation

```bash
synapse deploy
```

- Targets the PROD deployment linked in `.synapse/project.json`
- Asks `About to run \`convex deploy\` against PROD deployment <name>. Continue? [y/N]`
  — **must answer `y`** to proceed (safety against muscle-memory `Enter`)
- To bypass the prompt in CI: `synapse deploy --yes`
- Equivalent to `npx convex deploy` against Cloud

## What the operator will see

A normal `synapse deploy` against an existing project looks like:

```
About to run `convex deploy` against PROD deployment lush-heron-4656. Continue? [y/N] y
Using Synapse prod deployment lush-heron-4656.
(npx convex may warn it can't modify NEXT_PUBLIC_CONVEX_SITE_URL — benign; Synapse owns those values.)
✔ No indexes are deleted by this push
Uploading functions to Convex...
Generating TypeScript bindings...
Running TypeScript...
Pushing code to your Convex deployment...
Schema validation complete.
Finalizing push...
✔ Deployed Convex functions to https://lush-heron-4656.app.synapsepanel.com
```

## Benign warnings to expect (do NOT treat as errors)

1. **"Can't safely modify .env.local for NEXT_PUBLIC_CONVEX_SITE_URL, please edit manually."**
   - This is from `npx convex`, not Synapse. The Convex CLI is being
     defensive about touching the `NEXT_PUBLIC_CONVEX_SITE_URL` value
     because it doesn't look like the `*.convex.site` pattern it
     expects. The Synapse wrapper already wrote the right value; this
     warning is decorative.
   - The synapse wrapper prints a one-line note explaining this
     before the convex output.

2. **"Detected unused indexes"** / **"No indexes are deleted by this push"**
   - Standard Convex CLI behaviour. Same as Cloud.

3. **First deploy of a new schema takes 30s+**
   - Index creation per table — normal for large schemas with many
     tables. Subsequent deploys are seconds.

## What to do BEFORE deploying for the first time in this directory

```bash
synapse select    # link this directory to a project + dev/prod deployment
synapse doctor    # verify env, creds, backend reachability
synapse dev       # initial push to seed the dev deployment
# only then:
synapse deploy    # push to prod
```

If `synapse deploy` errors with **"No prod deployment saved for this
project"**, the project has no PROD deployment yet. Create one via:

```bash
synapse deployment create --type=prod
synapse select   # re-pick to refresh .synapse/project.json
```

## Pre-deploy hooks the operator may want

This project may have pre-deploy gates the agent should respect — check
for these and run them BEFORE `synapse deploy` if present:

```bash
# Typical patterns:
npm run typecheck && npm run test
npm run lint
npm run build   # if the deploy uploads built artifacts
```

If the user has a custom `predeploy` script in `package.json`, prefer
running that.

## What `synapse deploy` does NOT do

- It does NOT push to your dev deployment first; only PROD. Use
  `synapse dev --once` to push to dev.
- It does NOT migrate data between deployments. Convex has its own
  `npx convex import` / `npx convex export` for that — accessible via
  `synapse convex export <file>` / `synapse convex import <file>`.
- It does NOT seed env vars on a fresh deployment. Those come from
  project-level defaults set via `synapse env set` (see `synapse-env`
  skill).

## Quick decision tree

| Goal | Command |
|---|---|
| Iterate on functions locally with hot-reload | `synapse dev` |
| Run a one-shot dev push, no watch | `synapse dev --once` |
| Ship a stable version to PROD | `synapse deploy` |
| Push to PROD in CI (no prompt) | `synapse deploy --yes` |
| Run any other `convex` subcommand | `synapse convex <args>` |
| Verify everything's healthy before deploying | `synapse doctor` |
