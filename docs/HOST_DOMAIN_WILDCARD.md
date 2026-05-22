# Wildcard subdomain — runtime-editable via dashboard

> v1.9.0+ · /admin/host-domain panel
>
> Why this exists: prior to v1.9.0 enabling per-deployment wildcard
> subdomains required SSH-editing `.env`, restarting the API container,
> reloading Caddy by hand, and praying nothing collided. The
> infrastructure for doing it from the UI has existed since v1.5.6
> (the `host_domain` admin endpoints + the `synapse-updater` daemon)
> but wasn't discoverable. v1.9.0 surfaces it with a prominent
> suggestion card + a live URL preview so any instance admin can
> upgrade a `tls` host to `tls_with_wildcard` in 60 seconds.

## What the wildcard buys you

Without wildcard, deployment URLs fall back to one of two ugly forms:

| Form | Example | Problem |
|---|---|---|
| `path proxy` | `synapsepanel.com/d/brave-dolphin-1060` | Browser OK; Convex CLI breaks because `new URL("/api/...", base)` host-anchors and drops the `/d/<name>` path |
| `host:port` | `synapsepanel.com:3214` | Caddy doesn't TLS-front dynamic ports → TLS handshake fails → embedded Convex Dashboard shows the "deployment isn't browser-reachable" banner |

With wildcard at `app.<host>`:

| Form | Example | Outcome |
|---|---|---|
| `wildcard` | `brave-dolphin-1060.app.synapsepanel.com` | Browser OK + CLI OK + embed-dashboard OK + TLS via Caddy on-demand |

## Three things you need

1. **A domain you control.** Already true if you're running Synapse.
2. **A wildcard DNS A record.** One time, at your DNS provider:
   ```
   *.app  A  <your-VPS-IPv4>
   ```
   At Cloudflare specifically: **set proxy status to DNS only (grey cloud)** —
   the orange-cloud "Proxied" mode terminates TLS itself and bypasses our
   `tls_ask` gate, which would either burn Let's Encrypt quota on random
   subdomains or fail outright.
3. **An ACME contact email.** Optional but recommended — Caddy / Let's
   Encrypt sends renewal warnings here.

## Enabling via the dashboard

1. Log in as an instance admin (the first user registered is auto-promoted; subsequent users can be promoted via SQL or via team-admin role).
2. Top nav → **Admin** → **Host domain** (`/admin/host-domain`).
3. If your host is currently on plain `tls`, a cyan card appears: **"Enable wildcard subdomain"** — click **Configure wildcard…**
4. The form opens with mode pre-set to `TLS + wildcard`. Type the wildcard base, e.g. `app.synapsepanel.com`.
5. As you type, the form shows a live preview:
   ```
   Deployments will appear as: https://<name>.app.synapsepanel.com
   ```
6. Click **Apply** → confirm modal → confirm.
7. The daemon (`synapse-updater`, runs on the host outside docker) edits `.env`, recreates the `synapse-api` container with the new env, and reloads Caddy. Job status streams to the UI; total downtime ~30 seconds.
8. Refresh — every deployment URL (existing and future) now uses the wildcard form. The `cliCredentials` endpoint recomputes URLs at read time, so no DB rewrite is needed.

## Verifying it works

```bash
# Pick any deployment name from your dashboard. First curl will be slow
# (~5s — Caddy mints a fresh Let's Encrypt cert on-demand). Second curl
# is fast (~200ms — cert cached).
curl -I https://brave-dolphin-1060.app.synapsepanel.com/version
curl -I https://brave-dolphin-1060.app.synapsepanel.com/version
```

Both should return `HTTP/2 200` with a valid TLS cert. If the first returns 502 or hangs, check:

- `dig +short test.app.synapsepanel.com` should return your VPS IPv4.
- `tls_ask` smoke: `curl https://synapsepanel.com/v1/internal/tls_ask?domain=brave-dolphin-1060.app.synapsepanel.com` should return 200; an unknown subdomain returns 404.

## CLI side

After enabling wildcard, run `synapse select` in your project — the regenerated `.env.local` now writes URLs in wildcard form:

```bash
NEXT_PUBLIC_CONVEX_URL="https://brave-dolphin-1060.app.synapsepanel.com"
NEXT_PUBLIC_CONVEX_SITE_URL="https://brave-dolphin-1060.app.synapsepanel.com"
CONVEX_DEPLOYMENT=dev:brave-dolphin-1060 # team: amage.ia, project: amagejumpy
CONVEX_SELF_HOSTED_URL="https://brave-dolphin-1060.app.synapsepanel.com"
CONVEX_SELF_HOSTED_ADMIN_KEY="brave-dolphin-1060|..."
```

(Cloud-style `NEXT_PUBLIC_*` vars require `@iann29/synapse@1.8.2+`.)

## What this does NOT do

- **It does not change `synapsepanel.com` itself.** Your dashboard URL stays put. The wildcard is purely additive — a new shape for per-deployment URLs.
- **It does not migrate custom domains.** Operators with `api.<client>.com` set on a specific deployment keep using that domain. The wildcard is the fallback for deployments WITHOUT a custom domain.
- **It does not edit existing `.env.local` files in operator project directories.** Each operator must run `synapse select` once to pick up the new URL shape.

## Rolling back

If the wildcard upgrade goes sideways:

1. Use the **fallback URL** displayed during the apply flow (`http://<your-vps-ip>:8080` for the API, `http://<your-vps-ip>:6790` for the dashboard) — these are unaffected by the change.
2. SSH in, edit `.env` to unset `SYNAPSE_BASE_DOMAIN`, `docker compose up -d --force-recreate synapse`, `docker compose exec caddy caddy reload`.
3. File an issue with the daemon log at `/var/log/synapse-updater/reconfigure-*.log`.

The infra is well-trodden — it's the same flow used to provision the initial domain in v0.6, hardened across v1.5–v1.8 with DNS preflight, Cloudflare auto-config, and job-tracking via `admin_jobs`.
