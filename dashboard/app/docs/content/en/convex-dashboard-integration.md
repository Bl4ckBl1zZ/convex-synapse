# The Convex Dashboard, embedded

The Convex Dashboard (data tables, function editor, logs panel, schedules, files, history, schema view, settings) is **not forked** by Synapse. We run the official upstream image and iframe it inside the Synapse Dashboard, auto-logged-in against the right deployment.

## Why this works

Every Synapse deployment runs the **same Convex backend container** as Convex Cloud — `ghcr.io/get-convex/convex-backend`. The upstream Convex Dashboard image, `ghcr.io/get-convex/convex-dashboard`, was built to talk to that backend with an admin key. It doesn't know or care whether the backend was provisioned by Cloud's "Big Brain" or by Synapse.

So the integration reduces to: get the upstream dashboard image in front of the operator, hand it the admin key + deployment URL, get out of the way.

## The `/embed/<name>` route

The Synapse Dashboard ships a thin shell at `/embed/<name>` (source: `dashboard/app/embed/[name]/page.tsx`). It:

1. Fetches the deployment record via `GET /v1/deployments/<name>` (for projectId, type, status).
2. Fetches credentials via `GET /v1/deployments/<name>/auth` (adminKey, deploymentUrl).
3. Renders a thin header (40px) with breadcrumbs + the **deployment picker pill** + a "Refresh credentials" escape hatch.
4. Renders an `<iframe>` pointing at `NEXT_PUBLIC_CONVEX_DASHBOARD_URL` (defaults to `http://localhost:6791`; production: `https://<host>:6791`).
5. Listens for the upstream's `postMessage` handshake.

Operators reach this page from the "Open dashboard" button on any deployment row.

## The `postMessage` handshake

The upstream Convex Dashboard runs entirely client-side. On mount it `postMessage`s its parent window:

```js
parent.postMessage({ type: "dashboard-credentials-request" }, "*")
```

The Synapse `/embed/<name>` page replies:

```js
iframe.contentWindow.postMessage({
  type: "dashboard-credentials",
  adminKey: auth.adminKey,
  deploymentUrl: auth.deploymentUrl,
  deploymentName: auth.deploymentName,
}, CONVEX_DASHBOARD_ORIGIN)
```

The reply uses the iframe's exact origin as `targetOrigin` — a misconfigured `NEXT_PUBLIC_CONVEX_DASHBOARD_URL` can't leak credentials to a different page. The upstream dashboard caches the creds in its own localStorage.

The operator lands on the data / functions / logs UI **already authenticated**. No "paste your admin key" step.

## The Caddy sidecar — `convex-dashboard-proxy`

The upstream image serves with default security headers that block iframe embedding:

- `X-Frame-Options: SAMEORIGIN`
- `Content-Security-Policy: frame-ancestors 'self'`

Synapse runs a tiny Caddy sidecar (`convex-dashboard-proxy`) whose only job is to strip those two headers from every response. Without the sidecar the iframe loads but renders blank.

Caddy also fronts the `<host>:6791` port with the same TLS cert it uses for the rest of the install, so the iframe handshake works under HTTPS.

## The "Refresh credentials" escape hatch

If the upstream dashboard ever surfaces "deployment URL or admin key is invalid" (typically after an admin-key rotation in another tab), the operator clicks **Refresh credentials** in the header. Internally:

1. `POST /v1/deployments/<name>/reissue_admin_key` mints a fresh admin key — no container rotation, existing deploy keys keep working.
2. `authNonce` bumps in React state.
3. The iframe `key` includes `authNonce`, forcing React to unmount + remount the iframe.
4. The fresh mount fires a new `postMessage` handshake.

## The unreachable-URL banner

When the deployment URL falls back to `<host>:<dynamic-port>` (no wildcard, no custom domain), Caddy doesn't TLS-front that port — the iframe handshake would fail silently with "deployment URL or admin key is invalid".

Rather than let operators chase a fake auth error, `/embed/<name>` replaces the iframe with an amber banner that names the real cause and lists the two fixes (wildcard subdomain or per-deployment custom domain).

## The in-header deployment picker

Source: `dashboard/components/DeploymentPicker.tsx`. The green-pill switcher above the iframe lets operators switch between deployments in the same project without leaving the embedded view.

**Visual model.** A pill, type-coloured: Production → green, Development → blue, Preview → orange, Custom → neutral. Next to the type dot, a smaller status dot (running / provisioning / failed / stopped).

**Dropdown.** Click the pill (or hit `/`) to open a 320px menu. Sections grouped by type in order: Production → Development → Preview → Custom. Inside each section, the default-flagged deployment is first, then newest-first. Each item shows the deployment name (monospace), the status dot, a "default" badge, and a `visited Nm ago` recency hint.

**Keyboard shortcuts** (always-on when more than one deployment exists):

- **Ctrl+Alt+1** → first Production deployment
- **Ctrl+Alt+2** → first Development deployment
- **`/`** → open the dropdown

Dropdown-scoped: **↑ / ↓** traverse, **Enter** select, **Escape** close.

**Search.** When the project has 6+ deployments, the dropdown grows a filter input. Matches name OR type OR reference, case-insensitive.

**How a switch happens.** A parent-page navigation, not an in-iframe swap:

```ts
router.push(`/embed/${encodeURIComponent(newName)}`)
```

The iframe `key` includes the deployment name, so React unmounts + remounts on the new route. The new mount fires a fresh `postMessage` handshake. Trade-off vs in-iframe credential swap: a ~1s full reload per switch instead of instant. We accept that to avoid forking the upstream image.

## The reserved Strategy B endpoint

For a future "in-iframe picker" (Strategy B), Synapse already exposes:

```
GET /v1/internal/list_deployments_for_dashboard?token=<short-lived-PAT>
→ 200 { deployments: [{ name, url, adminKey }, …] }
```

Source: `synapse/internal/api/dashboard_proxy.go`. We haven't taken that path yet — the overlay picker (Strategy E) is good enough and avoids the fork. The endpoint is shipped, audited, and reserved.

## Why feature parity is automatic

The upstream Convex Dashboard handles data tables, function editor, logs panel, schedules, files, history, schema view, settings — all by talking to the Convex backend container with the admin key Synapse handed out. **Synapse contributes zero feature code to any of those pages.** When upstream ships a new feature, we pick it up by bumping the image tag — no fork to maintain, no rebase tax.

Synapse owns the *control plane* (teams / projects / multi-deployment lifecycle); the upstream Convex Dashboard owns the *data plane* (everything inside one deployment). The iframe + postMessage handshake is the seam.
