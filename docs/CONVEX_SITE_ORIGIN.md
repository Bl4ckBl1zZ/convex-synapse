# Convex cloud origin vs site origin (the two-port model)

> **Institutional memory.** This document exists so nobody ever again
> treats a Convex deployment's "cloud URL" and "site URL" as the same
> thing. They are two different TCP ports on the same container. Getting
> this wrong silently breaks HTTP actions — Better Auth login, webhooks,
> and `/engine/*` callbacks — with a 404 that looks like a routing bug
> but is actually a missing listener.

## TL;DR

A Convex self-hosted backend opens **two** listeners:

| Listener | Port | Serves | Env var that *describes* it |
|---|---|---|---|
| **cloud** | `3210` | client sync/WebSocket, queries/mutations, file storage, `npx convex deploy`, and HTTP actions **only under the `/http/` prefix** | `CONVEX_CLOUD_ORIGIN` |
| **site** | `3211` | the *site proxy*: takes any path and rewrites it to `127.0.0.1:3210/http<path>`, so HTTP actions are reachable at their **natural** paths (`/api/auth/*`, webhooks, `/engine/*`) | `CONVEX_SITE_ORIGIN` |

The split is **by PORT**, not by Host header or by origin. The
`CONVEX_*_ORIGIN` env vars only generate URLs/metadata (and drive
Better Auth's cookie/callback origins); they do **not** route traffic.

Synapse gives each deployment a dedicated site host that maps to 3211:

- cloud: `https://<name>.<BASE_DOMAIN>`        → port 3210 (always existed)
- site:  `https://<name>.site.<BASE_DOMAIN>`   → port 3211 (this feature)

…plus an opt-in per-deployment **`role='site'` custom domain** (e.g.
`https://site.<your-app>.com`) for installs that front deployments with
their own domains rather than the wildcard.

## Why HTTP actions 404 without this

In Convex Cloud the two surfaces live on two domains: `<name>.convex.cloud`
(cloud) and `<name>.convex.site` (site). Your app's Better Auth client is
configured to hit the **site** URL for `/api/auth/*`.

Before this feature, Synapse:

1. Exposed/routed only port 3210, and
2. Set `CONVEX_SITE_ORIGIN == CONVEX_CLOUD_ORIGIN` (the same URL).

So a request to `https://<deployment>/api/auth/get-session` hit the cloud
listener (3210), where that path doesn't exist — HTTP actions there live
only under `/http/`. Result: **404**. The route was alive the whole time
on 3211; nothing externally ever reached it.

## Upstream evidence (`github.com/get-convex/convex-backend`, `main`)

Confirmed by reading the backend source — don't take it on faith, the
files are short:

- **`crates/local_backend/src/router.rs`** — HTTP actions are mounted
  only under a prefix: `.nest("/http/", http_action_routes())`, where
  `http_action_routes()` routes `/{*rest}` and `/` to the http-action
  handler. On the cloud listener, `/api/auth/x` is **not** an HTTP action
  route; `/http/api/auth/x` is.
- **`crates/local_backend/src/proxy.rs`** — the site proxy rewrites every
  request: `let new_uri = format!("{}{}", site_forward_prefix, request.uri())`
  and forwards it via an HTTP client. It handles GET/POST/PUT/PATCH/DELETE/
  OPTIONS. The upstream target is whatever `site_forward_prefix` holds.
- **`crates/local_backend/src/config.rs`** — defaults: the API/cloud port
  is `3210`; `site_proxy_port` is `3211`; `site_forward_prefix` resolves
  to `http://127.0.0.1:3210/http`; the site proxy **binds 3211 by default**
  (no flag needed); `convex_origin` defaults to `:3210` and `convex_site`
  to `:3211`.
- **`self-hosted/advanced/hosting_on_own_infra.md`** — the official guide
  tells operators to set up **two distinct hostnames**: one → 3210
  (`CONVEX_CLOUD_ORIGIN`) and one → 3211 (`CONVEX_SITE_ORIGIN`). That is
  the upstream-blessed shape; Synapse's `<name>.site.<base>` is the same
  idea with collision-free naming.

## Empirical evidence (read-only probes, prod box)

From inside the docker network (the path the Synapse proxy itself takes),
against a real deployment:

| Port | Path | Result |
|---|---|---|
| 3210 cloud | `/` | 200 |
| 3210 cloud | `/api/auth/get-session` | **404** |
| 3210 cloud | `/http/api/auth/get-session` | 200 |
| 3211 site  | `/api/auth/get-session` | **200** |

Container env at the time: `CONVEX_CLOUD_ORIGIN == CONVEX_SITE_ORIGIN`.
Container `ExposedPorts`: both `3210/tcp` and `3211/tcp` (the upstream
image already EXPOSEs both). So 3211 was open and answering all along —
the only missing piece was the proxy routing to it.

## How Synapse solves it

Two reachability paths, both landing on the backend's port 3211:

1. **Wildcard** (`SYNAPSE_BASE_DOMAIN` set): `<name>.site.<base>`. The
   `site` label is a separate DNS level, so it can never collide with a
   deployment name (a single label). Mirrors Cloud's `.convex.site` 1:1.
2. **`role='site'` custom domain**: a per-deployment domain
   (`POST /v1/deployments/{name}/domains` with `role: "site"`) routed to
   3211. This is what unblocks an app already fronted by a custom domain
   (its cloud is, say, `mip.example.com` / `role=api`, and its site
   becomes `site.mip.example.com` / `role=site`).

End to end:

- **URL computation** (`internal/deploymenturl/url.go`): `Computer.Site()`
  returns `https://<activeSiteDomain>` (custom) → `https://<name>.site.<base>`
  (wildcard) → `""` (host-port mode / adopted; provisioner then keeps the
  cloud origin as a fallback).
- **Provisioner** (`internal/docker/provisioner.go`): bakes
  `CONVEX_SITE_ORIGIN = spec.SiteURL` (so Better Auth derives the right
  cookie/callback origin) and exposes `3211/tcp`.
- **Domain activation → container rebake**: whenever a `role='site'` domain
  becomes `active`, the container is recreated so `CONVEX_SITE_ORIGIN` picks
  up the new host. Both paths do this now: the synchronous `POST /verify`
  endpoint (`rebuildCORSAndRestart`) **and** the background DNS verifier
  (`internal/dns/verifier.go` `OnActivated` → `rebakeAfterDomainActivation`,
  v1.12.1). Before v1.12.1 the background loop flipped the row to `active`
  but never rebaked, so an auto-verified site domain left
  `CONVEX_SITE_ORIGIN` frozen at the cloud URL — and the manual `/verify`
  rebake only fires on the pending→active transition, so there was no way to
  fix an already-active row short of recreating the deployment.
- **Proxy** (`internal/proxy/proxy.go`): `matchSiteSubdomain` + a
  `role='site'` check flag the request as a site request; `ResolveAllSite`
  re-ports the cloud address `convex-<name>:3210` → `convex-<name>:3211`.
  The cloud path is untouched. Host-port mode returns 501
  (`site_routing_unsupported`) — 3211 isn't published there.
- **On-demand TLS** (`internal/api/tls_ask.go`): approves
  `<name>.site.<base>` for real deployments (its branch runs before the
  multi-label reject, since `<name>.site` contains a dot).
- **Caddy** (`installer/templates/caddy.wildcard`): a sibling
  `*.site.<base>` block forwards to Synapse, which routes by Host header.
- **CLI** (`cli/lib/env-file.js`): `synapse select` writes the distinct
  site URL (from `GET .../cli_credentials` → `siteUrl`) into
  `NEXT_PUBLIC_CONVEX_SITE_URL`; `CONVEX_SELF_HOSTED_URL` and
  `NEXT_PUBLIC_CONVEX_URL` stay the cloud URL (deploy/admin/client hit 3210).
  Because the upstream `npx convex dev|deploy` re-derives the site URL from
  the backend container's `GET /get_canonical_urls` on every run and
  overwrites `.env.local`, the wrapper (`runConvexCommand`) re-asserts the
  authoritative value via `reassertPublicConvexUrls` after the run, and
  `guardPublicConvexUrls` keeps it correct for the whole `dev` session
  (v1.12.1). `cli_credentials.siteUrl` is the source of truth — it's
  recomputed from `deployment_domains` per request, so it can't go stale the
  way a container's baked origin can.
- **Dashboard**: the deployment card shows the real "HTTP Actions URL".

## URL matrix

| Surface | Var | Host | Port |
|---|---|---|---|
| Cloud / client API + deploy | `CONVEX_SELF_HOSTED_URL`, `NEXT_PUBLIC_CONVEX_URL` | `<name>.<base>` (or custom `role=api`) | 3210 |
| Site / HTTP actions | `NEXT_PUBLIC_CONVEX_SITE_URL` | `<name>.site.<base>` (or custom `role=site`) | 3211 |

## Operator setup

The wildcard path needs a **second** wildcard DNS record:
`*.site.<BASE_DOMAIN>` → VPS IP (alongside the existing `*.<BASE_DOMAIN>`).
The custom-domain path needs an A record for the chosen site host. Caddy
issues TLS on demand once `tls_ask` approves the host.

**Existing deployments** provisioned before the site-origin release froze
`CONVEX_SITE_ORIGIN` at the cloud URL — they must be recreated/restarted
once to bake the new value. The same applies to any deployment whose
`role='site'` domain went active via the **background** DNS verifier on a
pre-v1.12.1 build (it flipped the row but skipped the rebake): recreate the
deployment once, or delete + re-add the site domain, to refresh the
container. v1.12.1's CLI re-assert keeps `.env.local` correct regardless, so
the frontend gets the right `NEXT_PUBLIC_CONVEX_SITE_URL` even before the
container is rebaked — but Better Auth's in-container origin still needs the
rebake.

## Host-port mode (the documented gap)

When Synapse runs without a base domain and without TLS (`--no-tls`,
host-port addressing), port 3211 is not published on the host, so there's
no externally reachable site URL. `Computer.Site()` returns `""` and the
proxy answers 501 for site hosts. Publishing a second host port for 3211
in this mode is a deliberate, documented TODO — base-domain and
custom-domain mode (the production shapes) ship unblocked.

**In-container origin (fixed).** The provisioner used to keep
`CONVEX_SITE_ORIGIN == CONVEX_CLOUD_ORIGIN` here, which named an address
where HTTP actions 404: the backend mounts them on 3210 only under
`/http`. That broke every in-container consumer that derives a URL from
`CONVEX_SITE_URL`. The visible casualty was Better Auth — Convex builds
its JWKS URL as `CONVEX_SITE_URL + /api/auth/convex/jwks`, the fetch
404'd, so no JWT could be verified and users completed an OAuth flow only
to arrive unauthenticated, with every request returning 200 and nothing
in the logs. `docker.SiteOriginFallback` now advertises
`<cloud origin>/http`, reproducing what the 3211 proxy would have done.

This fixes what the *container* advertises about itself; it does not make
3211 externally reachable. Browser-facing site URLs in host-port mode
still need the second published port.

## Environment-variable categories (v1.17+)

The cloud-vs-site split above is about **where requests land**. There is
a sibling distinction about **where env vars land** — operators reading
this doc almost always ask it next, and the two models echo each other.
After v1.17 Synapse exposes three operator-visible env-var categories,
each backed by a different store and read by a different consumer.

### 1. CLI / deploy credentials (operator's workstation)

- **Owner:** the `npx convex` CLI. `synapse select` writes them into the
  operator's `.env.local` (next to the app source tree).
- **Variables:** `CONVEX_DEPLOYMENT`, `CONVEX_SELF_HOSTED_URL`,
  `CONVEX_SELF_HOSTED_ADMIN_KEY`, `CONVEX_DEPLOY_KEY`,
  `CONVEX_DEPLOYMENT_TOKEN`.
- **Read by:** the `npx convex` binary on the operator's machine
  (deploy, env, run, dashboard).
- **Lifetime:** as long as the project stays linked on that workstation.

### 2. Frontend public vars (browser-visible, baked at build time)

- **Owner:** the operator's frontend build (Next.js, Vite, etc) —
  inlined into the JS bundle.
- **Variables:** `NEXT_PUBLIC_CONVEX_URL` (cloud listener, port 3210)
  and `NEXT_PUBLIC_CONVEX_SITE_URL` (the site origin — port 3211, the
  whole point of the two-port model above).
- **Read by:** the browser bundle at runtime.
- **Written by:** `synapse select` into `.env.local`; the framework
  picks them up at build.

### 3. Convex function runtime env (what functions actually read)

- **Owner:** the Convex backend's internal env store (Postgres-backed
  metadata, per deployment).
- **Variables:** every operator-defined application value —
  `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, `DATABASE_URL`, feature
  flags, third-party API keys, etc.
- **Read by:** `process.env.NAME` inside any Convex query / mutation
  / action / HTTP action.
- **Written by:** the **Convex Dashboard env panel**, `npx convex env
  set`, **or** (since v1.17) the **Synapse "Environment variables"
  project-settings panel**. All three paths land in the same store via
  the backend's `POST /api/update_environment_variables` endpoint
  (auth = the deployment's admin key).

The Synapse panel auto-syncs to every running deployment in the project
after each save. If a deployment is offline or transiently unreachable
the push is reported as `failed` inline; the operator clicks **Re-sync
to deployments** to retry. Adopted deployments are included whenever
their admin key is on file.

### Why this matters

Before v1.17, Synapse's "Default environment variables" panel wrote to
**container ENV** — the OS-level env of the Convex backend Rust process.
Convex functions never read from there (they read from the internal env
store), so operators setting `BETTER_AUTH_SECRET` in the Synapse panel
found their app still 500'ing because the secret never reached the
function isolate. v1.17 substitutes the container path for the
function-runtime path — the panel now writes to the same store the
Convex Dashboard's own panel uses, so values reach functions and show
up in both UIs.

System env vars (`CONVEX_CLOUD_ORIGIN`, `CONVEX_SITE_ORIGIN`,
`INSTANCE_SECRET`, S3/Postgres HA creds) still flow into container ENV
— the Convex backend's startup process reads them directly. Operators
don't set or see those; Synapse manages them internally in
`internal/docker/provisioner.go`.
