# CLI Backlog (`@iann29/synapse` npm package)

Issues + improvements collected from real Windows smoke (2026-05-20) against
`synapsepanel.com` running `1.6.15`. Each item ships independently — pick by
priority, attack from Linux, send a PR.

Severity legend: **P0** critical (broken feature) · **P1** high (visible UX
hole / blocker for a real flow) · **P2** medium (rough edge) · **P3** low
(polish).

---

## P0-001 — `synapse convex` crashes with `spawn EINVAL` on Windows

**Platform:** Windows + Node v18.20+ / v20.12+ / v22+ / v24+
**File:** `cli/lib/convex.js:32-38`

The core feature of the wrapper (`synapse convex <args>` = run `npx convex`
with the right env vars) is broken on Windows. Node tightened `child_process.spawn`
behaviour around `.cmd` / `.bat` files for CVE-2024-27980 — calling
`spawn("npx.cmd", ...)` without `shell: true` now returns `spawn EINVAL`.

**Repro (Windows):**
```powershell
synapse convex --help
# spawn EINVAL
```

**Workaround for users today:** use `npx convex` directly. The `.env.local`
written by `synapse select` is already what `npx convex dev` reads.

**Fix sketch (`cli/lib/convex.js`):**
```js
const child = spawnImpl(executable, ["convex", ...args], {
  env: buildConvexEnv(env, projectEnv, envFromCredentials(credentials)),
  stdio,
  shell: process.platform === "win32",   // <-- add this
});
```

`shell: true` is safe here because we control the argv (no user-supplied
shell-interpolated strings) and the alternative is "feature completely
broken on every Windows install with a modern Node".

**Test:** add a `cli/test/convex.test.js` case that spawns a tiny `node -e
"process.exit(0)"` echo binary and asserts `runConvex` resolves on every
supported platform (use `os.platform()` + a per-platform alias for the
echo binary).

---

## ~~P1-002~~ — DOWNGRADED to **P3-012** (`npx convex dev` already does this)

**Status:** invalidated 2026-05-20. Field-discovered: when the operator
runs `npx convex dev` in a Next/Vite/etc project, the Convex CLI itself
writes both `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL`
(or the framework-appropriate prefix) into `.env.local`. So `synapse
select` is *not* the right layer to do this.

**What's left (P3-012, optional polish):**

- After `synapse select` finishes, print a hint: `"Next step: run
  \`npx convex dev\` once — it will push your schema and add
  NEXT_PUBLIC_CONVEX_URL to .env.local."` — closes the discoverability
  gap for operators who don't know the upstream behaviour.
- Verify `synapse select` running *after* a previous `npx convex dev`
  does NOT clobber `NEXT_PUBLIC_CONVEX_URL` (current code only touches
  `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`, so this
  should already hold — add a regression test).

**File:** `cli/bin/synapse.js::selectDeployment` (just the hint line) +
`cli/test/env-file.test.js` (idempotency test).

---

## P1-003 — `synapse login` to unreachable URL exits silently (exit 4, no message)

**Platform:** cross-platform
**File:** `cli/bin/synapse.js::login` (line 227) + `cli/lib/api.js`

**Repro:**
```powershell
synapse login http://does-not-exist.local:8080
# Email: ...
# Password: ...
# (no message, process exits with code 4)
```

The `fetch` rejection bubbles up but the top-level catch in `bin/synapse.js:357`
only prints `err.message`, which for a DNS / ECONNREFUSED error is sometimes
empty or `"fetch failed"`. User has zero feedback.

**Fix sketch:**
- In `lib/api.js`, wrap `fetch` errors and rethrow a `SynapseAPIError` with a
  helpful message: `"Could not reach Synapse at ${baseUrl}: ${err.cause?.code || err.message}"`.
- In `bin/synapse.js:357`, also print a hint when the message looks
  network-flavoured: "Check the URL and that the server is reachable."

---

## P1-004 — No "Back" option in `choose()` menus

**Platform:** cross-platform
**File:** `cli/lib/prompts.js:92-114`

Once you pick the wrong team / project, you're stuck — Ctrl+C and start
over. Tedious when `synapse select` chains 3 prompts (team → project → dev
deployment → prod deployment).

**Fix sketch:**
- Reserve `b` / `back` / `0` as input that returns a sentinel `BACK` symbol.
- `selectDeployment` in `bin/synapse.js:262` becomes a loop with explicit
  state (`step = 'team' | 'project' | 'dev' | 'prod'`) that decrements on
  `BACK` and re-renders the previous menu.
- Show the hint inline: `Choose teams [1-2, b=back]:`

---

## P1-005 — `choose()` accepts garbage forever without abort

**Platform:** cross-platform
**File:** `cli/lib/prompts.js:106-113`

User typed `npx synapse select 2` (whole command line) at the
`Choose teams [1-2]:` prompt. CLI replied `Enter a number from 1 to 2.`
and re-prompted — correct behaviour, but with no exit guard. A truly
broken stdin (paste of a multi-line bash history, e.g.) loops indefinitely.

**Fix sketch:**
- Cap at 3 invalid attempts → throw `Error("too many invalid choices, aborting")`.
- Or: detect end-of-input on stdin and exit cleanly with a message.

---

## P1-006 — Listings have no colours

**Platform:** cross-platform
**File:** `cli/lib/prompts.js::choose` (line 101-104) + `cli/bin/synapse.js::deploymentLabel` (line 75-84)

Listings like:
```
dev deployments:
  1. lush-otter-8585 - dev - running
  2. fast-kestrel-2142 - dev - running
```
read like one flat blob. With colour, `running` should be green, `failed`
red, `provisioning` yellow, `stopped` dim, `deleted` strike-through.

**Fix sketch:**
- Add a tiny `lib/colors.js` with `green/red/yellow/dim/bold` helpers that
  no-op when `!process.stdout.isTTY` or `NO_COLOR` is set.
- Use only ANSI escape codes — no new dependencies.
- Apply in `deploymentLabel()` and inside `choose()` for the index prefix.

Reference:
```js
const SUPPORTS = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, s) => SUPPORTS ? `\x1b[${code}m${s}\x1b[0m` : s;
exports.green = (s) => wrap("32", s);
exports.red = (s) => wrap("31", s);
exports.yellow = (s) => wrap("33", s);
exports.dim = (s) => wrap("2", s);
exports.bold = (s) => wrap("1", s);
```

---

## P2-007 — `cli/test/config.test.js` fails on Windows

**Platform:** Windows
**File:** `cli/test/config.test.js:23-24`

```js
assert.equal(dirMode, 0o700);   // fails on NTFS — returns 0o666 (438)
assert.equal(mode, 0o600);      // same
```

NTFS doesn't model POSIX file modes; `fs.statSync().mode` returns 0o666.

**Repro:** `cd cli && npm test` on Windows → 24 pass, 1 fail.

**Fix sketch:**
```js
if (process.platform !== "win32") {
  assert.equal(dirMode, 0o700);
  assert.equal(mode, 0o600);
}
```

While here: `cli/lib/config.js::writeConfig` should also tolerate the
`fs.chmodSync` no-op on Windows (already does via try/catch in
`env-file.js:115` — confirm same pattern in `config.js`).

---

## P2-008 — README doesn't warn about `%APPDATA%\npm` not being in PATH on Windows

**Platform:** Windows
**File:** `cli/README.md`

On a fresh Node.js install on Windows, `C:\Users\<you>\AppData\Roaming\npm`
is **not** added to the user PATH automatically (varies by installer version).
After `npm install -g @iann29/synapse`, the `synapse` binary exists but
isn't found by the shell. User-hostile silent failure.

**Fix sketch:** add a "Windows note" subsection under Install:

```markdown
### Windows: ensure the npm global bin directory is in PATH

If `synapse --help` says "not recognised" after a global install, your PATH
is missing the npm global prefix. Fix once with PowerShell:

    [Environment]::SetEnvironmentVariable(
      'PATH',
      "$([Environment]::GetEnvironmentVariable('PATH','User'));$env:APPDATA\npm",
      'User'
    )

Close every terminal window (and your IDE — it caches the env at launch)
and reopen. `synapse --help` should now print the usage.
```

---

## P2-009 — Document the Windows `synapse convex` workaround until P0-001 lands

**Platform:** Windows
**File:** `cli/README.md`

Add a "Known limitations" subsection that says:

> On Windows with Node v18.20+, `synapse convex <args>` currently crashes
> with `spawn EINVAL` (issue [#XYZ]). Workaround: run `npx convex <args>`
> directly — the `.env.local` written by `synapse select` is already what
> `convex` looks for.

Delete the note after P0-001 ships.

---

## P3-010 — Auto-select message is grammatically odd ("Using projects: ingreis")

**Platform:** cross-platform
**File:** `cli/lib/prompts.js:96-99`

When only one option exists, `choose()` prints `Using ${label}: ...`. The
label is pluralised (`teams`, `projects`, `dev deployments`) for the menu
header, so the auto-select line reads:

```
Using projects: ingreis            <-- odd, looks like a multi-pick
Using teams: amage.ia              <-- ditto
Using dev deployments: lush-otter  <-- ditto
```

**Fix sketch:** accept an optional `singularLabel` in `choose()`:

```js
async function choose(label, choices, { singularLabel = label.replace(/s$/, ""), ... } = {}) {
  ...
  if (choices.length === 1) {
    output.write(`→ Auto-selected ${singularLabel}: ${choices[0].label} (only one available)\n`);
    return choices[0].value;
  }
```

Bonus: the `→ Auto-selected ... (only one available)` phrasing tells the
operator the CLI **didn't** silently pick one out of many.

---

## P1-013 — Session expires too fast (15min JWT access TTL)

**Platform:** cross-platform (dashboard + CLI)
**Files:**
- `synapse/internal/config/config.go` — default `SYNAPSE_JWT_ACCESS_TTL=15m`
- `synapse/internal/auth/jwt.go` — issuer
- `cli/bin/synapse.js:26-63` — `clientFromConfig` refresh proxy
- `dashboard/lib/api.ts:503-522` — 401-bounce-to-`/login` path

User feedback (2026-05-20 smoke): "tá expirando o login muito rápido".
Having to re-authenticate every 15 minutes during normal usage is hostile —
that's a *post-compromise* security setting, not a default for a self-hosted
dev tool.

Three fixes, in order of bang-for-buck:

1. **Bump the default** to a sane developer-tool TTL. Suggested: `1h`
   (`SYNAPSE_JWT_ACCESS_TTL=1h`). Refresh token stays at 720h (30d) as the
   real session length. Operators who want stricter for prod can override
   via env var — defaults aren't load-bearing security; refresh+revoke is.
   Single-line change in `config.go::Load`.

2. **Silent refresh on the dashboard 401**. Today `dashboard/lib/api.ts:503`
   wipes auth + redirects to `/login` on any 401. There's no refresh-token
   loop in the dashboard at all (the CLI has one via the `clientFromConfig`
   Proxy in `cli/bin/synapse.js:29-58`). Port that pattern to the dashboard:
   intercept 401 once, POST `/v1/auth/refresh` with the saved refresh token,
   retry the original request. Only bounce to `/login` when refresh itself
   fails. Closes the "I left the tab open for 20min and now I'm logged out"
   complaint.

3. **Integration test for CLI auto-refresh**. The Proxy in `clientFromConfig`
   handles 401 → refresh → retry, but there's no test simulating an
   expired-access + valid-refresh sequence. Add a `cli/test/refresh.test.js`
   that stubs an httptest-style server returning 401 on first call and 200
   on second, and asserts the CLI swaps tokens transparently.

**Test plan:**
- Existing Go integration tests already exercise `/v1/auth/refresh`
  (`synapse/internal/test/auth_test.go`). Add one that asserts the default
  TTL after `config.Load()` with no env vars is `1h`, not `15m`.
- Dashboard: Playwright spec that mocks the API to return 401 once, asserts
  the user stays on the current page (no redirect to /login).
- CLI: see #3 above.

## P3-011 — `synapse select` warning about missing prod is buried

**Platform:** cross-platform
**File:** `cli/bin/synapse.js:286-291`

Output ends with:
```
Linked ingreis to ...\project.json.
Selected dev deployment lush-otter-8585. Updated ...\.env.local.
Warning: no prod deployment found. `synapse convex deploy` will require ...
```

The warning is just a `stderr.write` — visually identical to the success
lines above. Operators skim and miss it.

**Fix sketch:** prefix the warning with a coloured `Warning:` (yellow,
landing under P1-006) and an empty line above for breathing room.

---

## Quick wins to ship first

If you only have one session, attack in this order — each is < 30 min:

1. **P0-001** (`shell: true` on Windows) — single-line fix, unblocks the
   entire wrapper on Windows.
2. **P2-007** (Windows test skip) — one-line guard.
3. **P2-008** + **P2-009** (README) — pure docs.

That batch closes the "Synapse CLI is unusable on Windows" gap with one PR.
P1-002 (NEXT_PUBLIC_CONVEX_URL) is next big win — closes the silent
"page hangs forever" mystery for every Next operator.

---

# Feature gaps + broken flows from prod-deployment smoke (2026-05-20)

Discovered while smoking a real `dev + prod` setup on `synapsepanel.com`
(version 1.6.15) against project `testesprojects/ingreis`:
- dev deployments: `lush-otter-8585`, `fast-kestrel-2142`
- prod deployment: `mellow-lemur-9143` with custom domain `api.ingreis.com`

## P0-014 — `synapse deploy` shortcut doesn't exist

**Platform:** cross-platform
**File:** `cli/bin/synapse.js` (the command switch)

In every real Convex workflow, `convex dev` and `convex deploy` are
**the two** commands operators run dozens of times a day. The wrapper
exposes `synapse convex` (broken on Windows per P0-001), but operators
who don't know Convex deeply look for `synapse deploy` and get this:

```
PS> npx synapse deploy
Unknown command: deploy
```

Then they fall back to `npx convex deploy` directly, which **works** —
because `synapse select` already wrote the right env vars — but they bypass
the wrapper. That's fine functionally, but it means `synapse convex` is
mostly dead weight (used neither for `dev` nor for `deploy`).

**Fix sketch:**
- Add `synapse deploy` as a first-class command — same plumbing as
  `synapse convex deploy`, with the prod-deployment target hard-coded.
- Add `synapse dev` while you're there — same, with dev target.
- Both should warn if no prod / dev deployment is selected, instead of
  spawning into a `convex` invocation that fails opaquely.

```js
case "dev":
  return await convex(["--target", "dev", "dev", ...args]);
case "deploy":
  return await convex(["--target", "prod", "deploy", ...args]);
```

Once both ship, `synapse convex` can stay as the escape hatch for arbitrary
upstream-CLI invocations (run, import, export, env list, etc).

**Bonus**: print on `--help` that operators can also do `npx convex
<args>` directly. Currently the wrapper *looks* like it's the only way.

---

## P1-015 — `synapse select` doesn't show prod deployments

**Platform:** cross-platform
**File:** `cli/bin/synapse.js::selectDeployment` (line 262) and the
prompt loop in `cli/lib/prompts.js::choose`
**Repro:**

```
PS> npx synapse select
teams:
  1. amage.ia (amageia)
  2. testesprojects
Choose teams [1-2]: 2
projects:
  1. ingreis
  2. ...
Choose projects [1-2]: 1
dev deployments:
  1. lush-otter-8585 - dev - running
  2. fast-kestrel-2142 - dev - running
PS C:\Users\mago\...  ← prompt returned WITHOUT asking for prod
```

Project `ingreis` has a prod deployment (`mellow-lemur-9143`) but
`select` either:
- (a) crashed silently between the dev prompt and the prod prompt, OR
- (b) `chooseDeploymentForType("prod", deployments)` returned `null`
      because `list_deployments` paged its way to the prod row but the
      array shape check on `cli/lib/api.js:78`
      (`if (!Array.isArray(page.data))`) bailed.

The dashboard's `lib/api.ts:660` defensively unwraps both shapes:
```ts
(r) => (Array.isArray(r) ? r : r.deployments ?? []),
```
The CLI's `listAll` doesn't — it throws on `{deployments: [...]}` envelope
the backend started returning. Confirm by curling
`/v1/projects/<ingreis-id>/list_deployments` and checking the shape; if
it's an envelope, mirror the dashboard's defensive unwrap into
`cli/lib/api.js::listAll`.

**Investigation steps:**
1. Reproduce: `synapse whoami` → `synapse select` against the same project.
   Capture the entire stderr + stdout (including stderr-to-file redirects).
2. Curl directly:
   ```bash
   curl -H "Authorization: Bearer $(jq -r .accessToken ~/.synapse/config.json)" \
        https://synapsepanel.com/v1/projects/<INGREIS_ID>/list_deployments
   ```
   Inspect: is it `[...]` or `{deployments: [...]}`?
3. If envelope: patch `listAll` to accept both shapes (defensive).
4. If array: log every row + the result of `chooseDeploymentForType("prod", ...)`
   under a `DEBUG_SYNAPSE=1` env var to localise the filter failure.

**Fix sketch** (defensive listAll — safe to land regardless of the cause):
```js
async listAll(path) {
  const items = [];
  let cursor = "";
  do {
    const pageURL = new URL(path, "http://synapse.local");
    pageURL.searchParams.set("limit", "500");
    if (cursor) pageURL.searchParams.set("cursor", cursor);
    const page = await this.request(
      "GET", `${pageURL.pathname}${pageURL.search}`,
      undefined, { includeHeaders: true },
    );
    // Backend has historically returned both `[…]` and `{deployments:[…]}`.
    // Dashboard already tolerates both — mirror that here.
    const arr = Array.isArray(page.data)
      ? page.data
      : page.data && Array.isArray(page.data.deployments)
        ? page.data.deployments
        : page.data && Array.isArray(page.data.projects)
          ? page.data.projects
          : page.data && Array.isArray(page.data.teams)
            ? page.data.teams
            : null;
    if (!arr) throw new SynapseAPIError(0, "bad_response", `Expected ${path} to return a JSON array`);
    items.push(...arr);
    cursor = page.headers.get("x-next-cursor") || "";
  } while (cursor);
  return items;
}
```

**Test:** `cli/test/api.test.js` with a stub `fetchImpl` returning each
shape — assert `listAll` returns the items either way.

---

## P1-016 — "Open dashboard" auto-login broken for prod + some dev deployments

**Platform:** cross-platform (browser dashboard, not the CLI)
**Files:**
- `dashboard/app/embed/[name]/page.tsx` (the iframe shell + postMessage handshake)
- `synapse/internal/api/deployments.go::deploymentAuth` / `publicDeploymentURL`
- `synapse/internal/api/deployments.go::cliDeploymentURL` (custom-domain
  fallout from v1.6.3 fix, see commit `78e08d5`)
- `installer/templates/convex-dashboard.caddyfile` (X-Frame strip)

**Repro:** in `testesprojects/ingreis`:
- Click "Open dashboard" on `lush-otter-8585` (dev) → auto-logged ✅
- Click "Open dashboard" on `fast-kestrel-2142` (dev) → "deployment URL or
  admin key is invalid" — operator has to paste manually ❌
- Click "Open dashboard" on `mellow-lemur-9143` (prod, custom domain
  `api.ingreis.com`) → same broken state ❌ (screenshot shows the manual
  Convex login form)

Visible state in the iframe header is correct ("Production · mellow-lemur-9143")
— so the embed shell *itself* loaded fine. What's broken is the postMessage
handshake: the embed page sends `{adminKey, deploymentUrl}` to the iframe,
the upstream Convex Dashboard tries to connect, and Convex rejects.

**Two hypotheses** (need triage before writing the fix):

1. **Wrong `deploymentUrl` for custom-domain prods.** v1.6.3 fix
   `78e08d5` updated `cliDeploymentURL` + `deploymentAuth` to honour
   custom domains. The embed shell may still be sending the loopback
   form (e.g. `https://synapsepanel.com:3213`) while the backend container
   is now bound to a different host. Test: open the embed page, F12,
   look at the postMessage payload in the network/console — what URL is it
   sending? Does it match what `npx convex deploy` resolves to?

2. **CORS / WebSocket origin mismatch.** When the prod deployment lives
   at `api.ingreis.com`, the iframe runs at the same origin as the
   Synapse Dashboard (`synapsepanel.com`) but the Convex Dashboard tries
   to open a WebSocket against `api.ingreis.com`. If the backend's
   `CORS_ALLOWED_ORIGINS` / `convex_origin` doesn't include
   `https://synapsepanel.com`, the handshake silently drops. Test: WS
   tab in DevTools should show the connection attempt and the close
   code.

For the dev deployment that *also* breaks (`fast-kestrel-2142` works for
some operators, not others — or vice versa with `lush-otter`), check
whether one was *recently provisioned* (cliCredentials may be cached) or
whether one has a stale `INSTANCE_SECRET` from a deploy-key rotation
(`mellow-lemur-9143` panel mentions "All existing deploy keys for this
deployment stop working after the rotation" — possibly the embed
admin key is also stale).

**Investigation steps:**
1. Diff the network traffic of clicking "Open dashboard" on the working
   vs broken deployment. Both should call
   `GET /v1/deployments/{name}/auth` — compare the `adminKey` +
   `deploymentUrl` they receive.
2. Check the backend health worker logs for the broken deployment:
   `docker logs synapse-api 2>&1 | grep <name>`
3. Try `curl -H "convex-client: ..." <deploymentUrl>/api/check_admin_key`
   with the broken adminKey directly. If 401, the credential is stale —
   regenerate via "Show CLI credentials".
4. If the credential is valid but the iframe still rejects, the bug is
   in the embed shell's postMessage payload — likely `dashboard/app/embed/[name]/page.tsx`.

Once root cause is known, file follow-up items under here (P1-016a /
P1-016b / etc).

---

## P3-017 — Custom-domain operators see loopback URL in "Use with Convex CLI" snippet

**Platform:** cross-platform (dashboard)
**File:** `synapse/internal/api/deployments.go::deploymentCLICredentials` +
the dashboard component rendering the snippet
(`dashboard/components/CliCredentialsPanel.tsx`)

**Repro:** prod deployment `mellow-lemur-9143` has custom domain
`api.ingreis.com` (proven by `npx convex deploy` succeeding against
that URL). But the **panel** shows:

```
CONVEX_SELF_HOSTED_URL='https://synapsepanel.com:3213'
CONVEX_SELF_HOSTED_ADMIN_KEY='mellow-lemur-9143|...'
```

— the loopback / port-mapped form. Operators who copy-paste this into
their `.env.local` get a working setup (because both URLs reach the
same backend through different paths), but it's misleading: the panel
should surface the **operator's intended URL** (the custom domain)
when one is bound to the deployment.

**Fix sketch:** in `deploymentCLICredentials`, when `deployment_domains`
has an `active` row with `role='api'` for this deployment, return its
hostname as the `convexUrl` instead of the loopback form.

`cli_credentials` returns the same value the snippet shows, so the CLI
benefits automatically.

---

# How this list was generated

Smoke run against a real `synapsepanel.com` install (v1.6.15) from a fresh
Windows 11 dev box on 2026-05-20:

1. `npm install -g @iann29/synapse@1.6.17` → CLI installed
2. `synapse --help` → command not in PATH (P2-008)
3. `cd cli && npm test` → 1/25 fails (P2-007)
4. `synapse convex --help` → `spawn EINVAL` (P0-001)
5. `synapse login http://nao-existe.local` → silent exit 4 (P1-003)
6. `synapse login https://synapsepanel.com` + `synapse select` →
   noticed P1-004 / P1-005 / P1-006 / P3-010 / P3-011
7. `synapse select` followed by manual `.env.local` edit → noticed P1-002
   when the Next dev server hung without `NEXT_PUBLIC_CONVEX_URL`
