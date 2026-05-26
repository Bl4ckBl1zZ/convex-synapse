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
- **CLI** (`cli/lib/env-file.js`): writes the distinct site URL into
  `NEXT_PUBLIC_CONVEX_SITE_URL`. `CONVEX_SELF_HOSTED_URL` and
  `NEXT_PUBLIC_CONVEX_URL` stay the cloud URL (deploy/admin/client hit 3210).
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

**Existing deployments** provisioned before this change froze
`CONVEX_SITE_ORIGIN` at the cloud URL — they must be recreated/restarted
once to bake the new value. See [`SITE_ORIGIN_CUTOVER.md`](./SITE_ORIGIN_CUTOVER.md)
for the full cutover runbook.

## Host-port mode (the documented gap)

When Synapse runs without a base domain and without TLS (`--no-tls`,
host-port addressing), port 3211 is not published on the host, so there's
no externally reachable site URL. `Computer.Site()` returns `""`, the
provisioner keeps `CONVEX_SITE_ORIGIN == CONVEX_CLOUD_ORIGIN`, and the
proxy answers 501 for site hosts. Publishing a second host port for 3211
in this mode is a deliberate, documented TODO — base-domain and
custom-domain mode (the production shapes) ship unblocked.
