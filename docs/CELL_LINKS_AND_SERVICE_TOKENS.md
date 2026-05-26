# Cell Links & Service Tokens

Part of the [Cell Control Plane](CELL_CONTROL_PLANE.md). A **CellLink** is a
service-to-service **contract** between two Cells in the same project: it
declares *who may talk to whom*, with *what commands/events*, under *what auth
mode*. A **ServiceToken** is the link-scoped credential for that contract.

> Synapse registers the **contract** and resolves a reachable **endpoint**. It
> does **not** transport payloads, proxy traffic, or broker jobs. Calling code
> uses the token + endpoint to talk directly.

## CellLink

| Field | Meaning |
|---|---|
| `sourceCellId` / `targetCellId` | The two cells (same project). |
| `protocol` | `http` · `convex_action` · `outbox` · `webhook` · `polling` (descriptive). |
| `authMode` | `service_token` (implemented) · `mtls` (placeholder) · `none` (placeholder). |
| `allowedCommands` / `allowedEvents` | The contract's allow-lists (informational today). |
| `status` | `active` · `disabled`. |
| `serviceTokenCount` | Computed count of active tokens. |
| `endpoint` / `endpointSource` | Best-effort reachable URL of the target + where it came from. |

### Guards

- **Intra-project only.** Self-links and cross-project links are rejected.
- **One active link** per `(source, target, protocol)` (partial unique index;
  re-creating after disable is allowed).
- Only `authMode=service_token` links mint tokens; `mtls`/`none` return
  `400 auth_mode_not_token`.

### Endpoint resolution (`endpointSource`)

Synapse resolves a reachable URL for the target cell **without inventing any
routing** — it reuses what already exists:

1. `route` — an active `deployment_domains` (api) custom domain, else
2. `deployment` — the target deployment's URL, else
3. `none` — `endpoint:null` (surfaced as "endpoint unresolved" in topology).

## ServiceToken

- Prefix `syn_svc_`. **Stored only as a SHA-256 hash**; the plaintext is shown
  **once** at creation and never again.
- **Link-scoped**: a token belongs to exactly one CellLink and discovers only
  that link (not all the source cell's links).
- `scopes`: `discovery:read` (default, required for discovery) ·
  `commands:send` (reserved) · `events:send` (future). Max 20 scopes, ≤64 chars
  each.
- `effectiveStatus`: `active` · `revoked` · `expired`. **`expired` is computed**
  from `expiresAt` even if the stored status is still `active` (no reaper).
- **Revoke**: `POST /v1/service_tokens/{id}/revoke` — the token stops
  authenticating immediately.

## Discovery

```
GET /v1/internal/cell_links/discovery
Authorization: Bearer syn_svc_...
```

- **Public route** (mounted outside the JWT group) — authenticated by the
  service-token bearer, looked up in `service_tokens` (never `access_tokens`).
- Requires the `discovery:read` scope → `403 insufficient_scope` otherwise.
- **Link-scoped**: returns only the token's own link (target cell + protocol +
  authMode + allowed commands/events + resolved endpoint/endpointSource).
- Rejects revoked + expired tokens.

## What Synapse does NOT do here

- Does not transport command/event payloads between Cells.
- Does not proxy or gateway traffic.
- Does not enforce the `allowedCommands` / `allowedEvents` at call time (they're
  a declared contract, not a runtime filter — runtime enforcement is a future
  block).

## API

See [API_CELL_CONTROL_PLANE.md](API_CELL_CONTROL_PLANE.md#cell-links--service-tokens).

```
GET  /v1/projects/{id}/cell_links          list (project-RBAC)
POST /v1/projects/{id}/cell_links          create
GET  /v1/cell_links/{id}                    get
PATCH /v1/cell_links/{id}                   update
POST /v1/cell_links/{id}/disable            disable
GET  /v1/cell_links/{id}/service_tokens     list tokens (metadata only)
POST /v1/cell_links/{id}/service_tokens     mint token (plaintext once)
POST /v1/service_tokens/{id}/revoke         revoke
GET  /v1/internal/cell_links/discovery      PUBLIC, syn_svc_ bearer, discovery:read
```
