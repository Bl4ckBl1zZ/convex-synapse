# Site origin — production cutover runbook

> **Operator-run.** This is the human checklist for turning on the site
> origin in production. DNS changes and the prod deploy are yours to run.
> Background + the why: [`CONVEX_SITE_ORIGIN.md`](./CONVEX_SITE_ORIGIN.md).

## What you're enabling

HTTP actions (Better Auth `/api/auth/*`, webhooks, `/engine/*`) move from
"404 on the cloud host" to "served on a dedicated site host" that maps to
the Convex backend's port 3211. Two ways to expose it; pick per app:

- **Wildcard** (if the app uses `<name>.<BASE_DOMAIN>`): the site host is
  `<name>.site.<BASE_DOMAIN>` — no per-deployment config.
- **Custom domain** (if the app uses its own domain, e.g. cloud =
  `mip.amagejumpy.com` / `role=api`): add a `role='site'` domain such as
  `site.mip.amagejumpy.com`.

## Pre-flight (no changes yet)

- [ ] Confirm the new Synapse build is the one you're deploying (this
      release includes migration `000022_deployment_domains_site_role`).
- [ ] Know each app's cloud host and which exposure you'll use.
- [ ] Have DNS access (Cloudflare/registrar) for the relevant zone.

## Step 1 — DNS

**Wildcard apps:** add a second wildcard A record next to the existing one.

```
*.<BASE_DOMAIN>        A   <vps-ip>      # already exists (cloud)
*.site.<BASE_DOMAIN>   A   <vps-ip>      # NEW (site / HTTP actions)
```

**Custom-domain apps:** add an A record for the chosen site host.

```
site.mip.amagejumpy.com   A   <vps-ip>
```

Verify propagation (synthetic name proves the wildcard, any name resolves):

```bash
dig +short probe-test.site.<BASE_DOMAIN>     # → <vps-ip>
dig +short site.mip.amagejumpy.com           # → <vps-ip>
```

## Step 2 — Deploy Synapse

Deploy the new version the usual way (e.g. `setup.sh --upgrade` or the
dashboard auto-update). The migration runs on startup. Caddy picks up the
`*.site.<base>` block automatically when `SYNAPSE_BASE_DOMAIN` is set; for
a custom site domain, add it in the dashboard:

```
Deployment → Domains → Add  →  domain: site.mip.amagejumpy.com, role: site
```

Wait for the row to go `active` (DNS verified), then Caddy issues TLS on
first hit (gated by `tls_ask`).

## Step 3 — Rebake existing deployments (REQUIRED)

Deployments created before this release froze `CONVEX_SITE_ORIGIN` at the
cloud URL. They need one recreate/restart to pick up the new value
(Better Auth derives its cookie/callback origin from it):

- Dashboard → deployment row → **Restart**, or
- recreate via the provisioner.

Verify the container env after:

```bash
docker inspect convex-<name> --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep CONVEX_SITE_ORIGIN
# expect the site host, NOT the cloud host
```

## Step 4 — Point the app + verify

Re-link so `.env.local` gets the distinct site URL:

```bash
synapse select        # rewrites NEXT_PUBLIC_CONVEX_SITE_URL
```

`NEXT_PUBLIC_CONVEX_URL` / `CONVEX_SELF_HOSTED_URL` stay the cloud host
(3210); only `NEXT_PUBLIC_CONVEX_SITE_URL` changes to the site host (3211).

Smoke test (the key assertion — NOT a 404):

```bash
# Cloud host still serves the app (200):
curl -s -o /dev/null -w '%{http_code}\n' https://<name>.<base>/

# Site host serves HTTP actions at natural paths (200 or app-level 4xx/5xx,
# NOT a routing 404):
curl -s -o /dev/null -w '%{http_code}\n' https://<name>.site.<base>/api/auth/get-session
# (custom domain) https://site.mip.amagejumpy.com/api/auth/get-session
```

Then exercise real login in the app end-to-end.

## Rollback

The change is additive and per-deployment in effect:

- **DNS**: removing `*.site.<base>` / the custom site record makes the
  site host unreachable again; the cloud host is unaffected.
- **Synapse**: rolling back the binary reverts routing. The
  `000022` migration is additive (CHECK widening) — leaving it applied is
  harmless; if you must revert it, delete any `role='site'` rows first
  (the down migration does this).
- **App**: pointing `NEXT_PUBLIC_CONVEX_SITE_URL` back at the cloud URL
  restores the old (broken-for-HTTP-actions) behaviour — only do this if
  the new path misbehaves.

Cloud traffic (queries/mutations/deploy) is never touched by any step
here, so a botched site cutover can't take the app down — login just
stays broken until fixed.
