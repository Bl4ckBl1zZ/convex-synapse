# Release notes — Site origin (HTTP actions)

## What changed

Convex deployments now expose a dedicated **site origin** for HTTP
actions, instead of pretending the site URL equals the cloud URL.

A Convex backend opens two listeners: **cloud (3210)** and the **site
proxy (3211)**. HTTP actions — Better Auth `/api/auth/*`, webhooks,
`/engine/*` — are served on 3211 at their natural paths. Synapse used to
route only 3210 and set `CONVEX_SITE_ORIGIN == CONVEX_CLOUD_ORIGIN`, so
those requests 404'd from outside. They now reach 3211.

## New surfaces

- **Wildcard site host**: `https://<name>.site.<BASE_DOMAIN>` → port 3211
  (alongside the existing `https://<name>.<BASE_DOMAIN>` → 3210).
- **`role='site'` custom domains**: `POST /v1/deployments/{name}/domains`
  with `{"role":"site"}` routes a per-deployment domain to 3211.
- **`siteUrl`** in the deployment JSON + `cli_credentials`; the CLI writes
  the distinct `NEXT_PUBLIC_CONVEX_SITE_URL`; the dashboard card shows the
  real "HTTP Actions URL".

## Migrations

- `000022_deployment_domains_site_role` — additive: widens the
  `deployment_domains.role` CHECK to include `'site'`. No data migration.

## Operator action (cutover)

1. Add a second wildcard DNS record: `*.site.<BASE_DOMAIN>` → VPS IP.
   (Custom-domain users: add an A record for the chosen site host.)
2. Deploy the new Synapse version.
3. **Recreate/restart existing deployments once** — they froze
   `CONVEX_SITE_ORIGIN` at the cloud URL at create-time and need a rebake.
4. Point your app's `NEXT_PUBLIC_CONVEX_SITE_URL` at the site host
   (`synapse select` rewrites `.env.local`).

Full runbook: [`SITE_ORIGIN_CUTOVER.md`](./SITE_ORIGIN_CUTOVER.md).
Background + the two-port model: [`CONVEX_SITE_ORIGIN.md`](./CONVEX_SITE_ORIGIN.md).

## Limitations

- **Host-port mode** (`--no-tls`, no base domain) doesn't publish 3211, so
  there's no external site URL there; `CONVEX_SITE_ORIGIN` falls back to
  the cloud URL and site routing returns 501. Publishing a second host
  port is a documented TODO.
- **Adopted deployments**: site URL is operator-supplied (Synapse returns
  `""` and you wire the site host yourself).
