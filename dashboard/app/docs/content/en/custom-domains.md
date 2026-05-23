# Custom domains

Synapse exposes provisioned Convex deployments under URLs your CLI, browser and embedded dashboard can all reach over HTTPS. Two routing modes live side-by-side, and a third legacy path-based form is always available as a fallback:

| Form | Example | When it's used |
|---|---|---|
| `custom` | `https://api.client.com` | A per-deployment custom domain row (active) exists for this deployment |
| `wildcard` | `https://brave-dolphin-1060.app.synapsepanel.com` | `SYNAPSE_BASE_DOMAIN` is set and no active custom domain wins first |
| `host` | `https://synapsepanel.com:3214` | Neither of the above; `SYNAPSE_PROXY_ENABLED=false` |
| `path` | `https://synapsepanel.com/d/brave-dolphin-1060` | Neither of the above; `SYNAPSE_PROXY_ENABLED=true` (legacy v0.2 default) |

The decision matrix lives in `synapse/internal/deploymenturl/url.go`. Both the dashboard's "Copy URL" button and the CLI's `cliCredentials` endpoint go through the same `Computer.Public` / `Computer.CLI` helpers, so what the dashboard shows and what `npx convex` connects to never disagree.

> The `path` form is fine for browsers but breaks the official `npx convex` CLI: it constructs API URLs via `new URL("/api/...", baseUrl)`, which drops any path component. `Computer.CLI` therefore never emits the path form — if no domain or wildcard is configured it falls back to `<PublicURL_host>:<HostPort>`.

---

## Mode A — Host wildcard subdomain

The instance admin sets `SYNAPSE_BASE_DOMAIN=app.synapsepanel.com` (any host under their control). Every existing and future deployment is then reachable at `https://<name>.app.synapsepanel.com`.

### What you need (one-time, operator-side)

1. **Wildcard DNS A record** at your DNS provider:
   ```
   *.app  A  <your-VPS-IPv4>
   ```
   Cloudflare: set proxy status to **DNS only (grey cloud)**. Orange-cloud terminates TLS itself and bypasses our `tls_ask` gate.
2. **ACME contact email** (`ACME_EMAIL` in `.env`) — Let's Encrypt sends renewal warnings here.
3. **Wildcard Caddyfile block.** `setup.sh --base-domain=app.synapsepanel.com` appends `installer/templates/caddy.wildcard` to the standalone Caddyfile and sets `on_demand_tls { ask http://synapse-api:8080/v1/internal/tls_ask }` in the global block.

### Runtime UI (v1.9.0+)

The full flow is exposed in the dashboard at **Admin → Host domain** (`/admin/host-domain`). On a plain-TLS install the page shows a suggestion card; clicking **Configure wildcard…** opens a form with a live URL preview, applies the change via the `synapse-updater` daemon (unix socket on the host, outside docker compose), and streams job status to the UI. See `docs/HOST_DOMAIN_WILDCARD.md` for the long-form walk-through.

### DNS preflight (`setup.sh`)

`installer/install/preflight.sh::check_base_domain` queries a synthetic random subdomain like `synapse-probe-7f3a.<base>`. The randomness defeats DNS caches:

- Empty / NXDOMAIN → warn "wildcard not resolving" (install continues).
- Resolves to a different IP → warn "wildcard points at X, this host is Y".
- Resolves to the host's public IP → green "wildcard OK".

Failures are warnings, not hard stops — operators can fix DNS after install and the wildcard will start working as soon as it propagates.

### TLS issuance gating

Caddy's `tls { on_demand }` directive asks Synapse before issuing a certificate. The endpoint is **public, no auth**, served at `GET /v1/internal/tls_ask?domain=<host>` and implemented by `synapse/internal/api/tls_ask.go`:

- The host must be `<sub>.<BASE>` (case-insensitive).
- `<sub>` must contain no dots (multi-label sub → 403).
- A deployment named `<sub>` must exist with `status <> 'deleted'`.
- Falls through to the custom-domain branch (mode B) on any miss.

Without this gate, anyone could trigger Let's Encrypt cert requests for arbitrary subdomains under your base by sending TLS handshakes. The rate limits would eventually save you, but the explicit refusal is cleaner.

---

## Mode B — Per-deployment custom domain

Use this when the wildcard isn't desired (you don't want a single base for everything), or when one specific deployment needs a different brand domain (`api.client.com` per-tenant). Both modes can coexist; the custom-domain row wins over the wildcard for that one deployment.

### API surface

All routes live under `/v1/deployments/{name}/domains`. Auth gates use the same `loadDeploymentForRequest` + `canEditProject` helpers as the rest of the deployment surface — viewers cannot manage domains.

```bash
# List
curl -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/domains

# Add
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"domain":"api.client.com","role":"api"}' \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/domains

# Verify (re-run DNS check)
curl -X POST -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/domains/<id>/verify

# Auto-configure via stored Cloudflare credential (instance-admin only)
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"credentialId":"<uuid>"}' \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/domains/<id>/auto_configure

# Delete
curl -X DELETE -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/domains/<id>
```

### Role: `api` vs `dashboard`

The `role` column on `deployment_domains` selects what the proxy forwards to (see `proxy.go::Handler`):

- **`api`** — forwards to the deployment's Convex backend container. Queries, mutations, HTTP actions land here. This is the role that participates in URL classification (`active custom domain api` beats `BaseDomain` in `Computer.Public` / `Computer.CLI`).
- **`dashboard`** — forwards to `Resolver.DashboardAddr` (the `convex-dashboard-proxy` sidecar). Lets you front the embedded Convex Dashboard UI on your own brand domain.

### Schema (`migration 000012_deployment_domains`)

```sql
CREATE TABLE deployment_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    domain CITEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('api', 'dashboard')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'failed')),
    dns_verified_at TIMESTAMPTZ,
    last_dns_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (domain)
);
```

The `UNIQUE (domain)` constraint enforces that one hostname can only ever point at one deployment across the whole instance.

### Status lifecycle

- `pending` — just registered, awaiting first DNS verification, or resolver can't see the record yet (NXDOMAIN / timeout / SERVFAIL). This is a **transient** verdict; the verifier loop retries every 15s.
- `active` — a returned A record matches `SYNAPSE_PUBLIC_IP`. TLS and routing are allowed.
- `failed` — the resolver returned A records but **none** matched the expected IP. Deterministic miss (orange-cloud, wrong host, etc.). The operator needs to fix the DNS record.

If `SYNAPSE_PUBLIC_IP` isn't set on the host, every row stays `pending` with `last_dns_error` carrying the exact prefix `SYNAPSE_PUBLIC_IP not configured…`. The dashboard's `CustomDomainsPanel` pattern-matches that prefix to surface a single yellow banner instead of repeating the long error on every row.

### Dashboard panel (`CustomDomainsPanel.tsx`)

Mounted per-deployment under "Manage custom domains". Features:

- Live provider detection (debounced 500ms). When Cloudflare is detected and the caller is an instance admin with a stored CF credential covering the zone, the form offers a **"Auto-configure with Cloudflare"** toggle that upserts the A record via the stored token at create time.
- Per-row **Auto-configure DNS** retry for rows added before a credential was registered.
- Per-row **Verify** (forces a fresh DNS lookup) and **Remove**.
- Status badges with relative-time `verified Xm ago`.

### How the proxy matches by Host header

`proxy.go::Handler` runs three dispatch rules in order on every request:

1. **Wildcard subdomain** (mode A) — `matchHostSubdomain(r.Host, baseDomain)` returns the leftmost label when `r.Host == "<sub>.<base>"`. Empty subdomain or multi-label sub falls through.
2. **Custom domain** (mode B) — `Resolver.ResolveDomain` looks up the full Host in `deployment_domains` where `status='active'`. Cache is per-host with the same TTL as the deployment-name cache (default 30s); `InvalidateDomain` drops a host immediately after add/delete/verify.
3. **Path fallback** — `/d/{name}/{rest}` is parsed out of the URL path. This is the v0.2 contract — every operator with `SYNAPSE_PROXY_ENABLED=true` gets it regardless of domain configuration.

When `role='dashboard'` matches, the request bypasses `ResolveAll` entirely and goes straight to `Resolver.DashboardAddr`. HA replica failover applies to `role='api'` only.

### Caddy block for custom domains (catch-all)

`installer/templates/caddy.standalone` ends with a `:443` catch-all that accepts any inbound host not already claimed by a more specific block, gates issuance through `tls_ask`, and forwards to `synapse-api:8080`. The Synapse proxy then re-routes by Host header. Caddy's longest-match rule means your primary `{{DOMAIN}}` and the optional wildcard block always win for the hosts they cover.

---

## Legacy: path-based routing (`/d/{name}/*`)

Always on as long as `SYNAPSE_PROXY_ENABLED=true`. URLs like `https://synapsepanel.com/d/brave-dolphin-1060/version` reverse-proxy to the deployment's backend container at `/version`. This is the v0.2 contract and predates both wildcard and custom-domain modes.

It works for browsers but **does not work for the official `npx convex` CLI** — the URL builder drops the path component. If you're stuck on this form, `synapse select` will emit URLs in `host:port` form rather than path form, which means your dynamic backend port has to be publicly reachable. Most VPS firewall defaults block this.

The fix is to enable mode A or mode B.
