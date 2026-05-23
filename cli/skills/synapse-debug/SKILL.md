---
name: synapse-debug
description: >
  Diagnose Synapse / Convex-on-Synapse problems. Symptoms include CLI
  login failures, "Email or password is incorrect" loops, deployments
  not responding, schema-push errors, stale .synapse/project.json,
  401 / 403 on `synapse dev`, and the embedded Convex Dashboard
  rendering a "not browser-reachable" banner. Load when the user reports
  ANY Synapse-related thing as broken / failing / unexpected.
autoTrigger:
  - "broken", "failing", "doesn't work", "error", "stuck"
  - "401", "403", "Email or password is incorrect"
  - "convex backend not responding", "deploy hangs"
  - "stale project", "project.json", ".env.local broken"
  - "synapse status not what I expect"
---

# Debugging Synapse — the agent's playbook

## Always start with `synapse doctor`

```bash
synapse doctor
```

Runs ~19 checks across local environment, project metadata, backend
connectivity, per-deployment health, and (when relevant) local-HTTPS
dev. Categorises results as **ok / warn / issue / skipped** and exits
**0** (clean), **1** (warnings), or **2** (issues).

If issues are auto-fixable, the footer shows one of:

```
💡 Tip: 1 issue is auto-fixable — run `synapse doctor --fix`.
💡 Tip: 2 auto-fixable + 1 prompt-fixable — run `synapse doctor --fix --yes` to apply both.
```

Just run the suggested command. The `--yes` variant additionally
applies "prompt" class fixes (e.g. re-link stale `.synapse/project.json`
after the project was deleted on the backend).

```bash
synapse doctor --fix          # auto-safe fixes only
synapse doctor --fix --yes    # plus prompt-class fixes (stale links, etc)
```

## Common issues + canonical fixes

### "Email or password is incorrect" on a known-good password (Windows)

CLI v1.8.10+ ships a fix for this. Symptom: dashboard works fine but
`synapse login` always returns 401 on PowerShell. Cause: stdin raw mode
on Windows reads bytes in the local code page (e.g. CP-1252); non-ASCII
chars in the password get corrupted to U+FFFD before bcrypt compare.

**Fix:** upgrade to CLI ≥ 1.8.10 (`npm install -g @iann29/synapse@latest`).
The CLI now calls `chcp 65001` automatically. As a workaround on older
versions, run `chcp 65001` in PowerShell manually before `synapse login`.

### `synapse dev` errors with "CONVEX_DEPLOYMENT must not be set when CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY are set"

CLI v1.8.4+ writes `CONVEX_DEPLOYMENT` as a **commented** line in
`.env.local`. v1.8.2 / v1.8.3 wrote it active and broke this flow.
Fix: upgrade CLI, then `synapse select` to rewrite `.env.local`.

Also check the operator's shell rc files (`.zshrc`, `.bashrc`) for a
stray `export CONVEX_DEPLOYMENT=…` that shadows the local one. Run
`echo $CONVEX_DEPLOYMENT` — if it returns anything, the operator needs
to `unset CONVEX_DEPLOYMENT` (and remove the export from rc).

### Stale `.synapse/project.json` (project deleted / transferred on the backend)

Symptom: every command says "project not found" or "team not found".

```bash
synapse doctor --fix --yes
```

The doctor's `project-still-exists` check has a B-then-C fix:
- **Heuristic B**: if exactly one other team owns a project with the
  same slug, auto-relink (project was transferred).
- **Fallback C**: write a stale marker to `.synapse/project.json` and
  prompt the operator to run `synapse select` to start fresh.

### "URL not browser-reachable" / embedded Convex Dashboard shows the orange "not browser-reachable" banner

Cause: the deployment's URL falls back to `<host>:<dynamic-port>` form
because the Synapse host doesn't have wildcard subdomain mode enabled.
Caddy doesn't TLS-front those dynamic ports.

The fix is INSTANCE-ADMIN side (not project-member side):

1. Owner of the Synapse host opens dashboard at `<host>/admin/host-domain`
2. Suggestion card "Enable wildcard subdomain" → click Configure
3. Operator side: add wildcard DNS A record `*.<base> → <host-ip>`
4. After ~30s reconfigure, all deployments get `<name>.<base>` URLs

If the user reporting this isn't the instance admin, tell them to ping
whoever runs the Synapse host. As a per-deployment workaround, instance
admin can add a custom domain (`api.<client>.com`) to that one
deployment via the dashboard's "Custom domains" panel.

### `synapse open` opens a broken page with cascading "Failed to load X" errors

CLI v1.8.1+ pre-checks the project state before launching the browser:
warns on stale link, opens anyway. Dashboard v1.8.1+ shows a clean
EmptyState for 404/403 instead of cascading. **Fix:** upgrade both
(CLI: `npm install -g @iann29/synapse@latest`; Synapse host:
`bash setup.sh --upgrade` on the VPS).

### `synapse status` shows a red `no-domain` chip in the FORM column

(Internally that's URL form `host` — the operator-facing label is
`no-domain` in red.) Same root cause as the "not browser-reachable"
issue above — wildcard subdomain mode isn't enabled on the host. Same
fix path.

### `synapse deploy` fails with "No prod deployment saved for this project"

The `.synapse/project.json` has no prod entry. Either:
- The prod deployment was never created (create via dashboard or
  `synapse deployment create --type=prod`)
- The project has a prod but `synapse select` was run pre-prod and
  the link is stale (re-run `synapse select` to pick up the new one)

### `synapse dev` succeeds but the app in the browser still talks to the OLD deployment

`.env.local` is stale. The operator probably did `synapse select`
to a different deployment without restarting their `npm run dev`.

```bash
synapse select                            # confirms .env.local is fresh
cat .env.local | grep CONVEX_SELF_HOSTED  # eyeball the URL
# restart the app's dev server (Next.js / Vite / whatever)
```

### Backend is on an older version than expected

```bash
synapse version                           # cli vs backend versions
```

If the backend (`synapsepanel.com` etc) is behind, the instance admin
needs to run `bash setup.sh --upgrade` on the host. The dashboard also
has an "Upgrade" banner for instance admins.

## What to inspect when nothing else helps

```bash
synapse status               # all deployments in this project + URL form
synapse status --json        # machine-parseable
synapse doctor --verbose     # show data dump per check
cat .synapse/project.json    # what cwd is linked to
grep -E "CONVEX_" .env.local # what creds the CLI will inject
```

For agent-side reasoning: if you see the URL form is "wildcard" + status
"running" + `synapse doctor` reports all-green, the issue is almost
certainly **in the user's app code**, not Synapse. Pivot the debugging
to client-side (browser console, network tab, Convex query failures).
