# Deploy keys

Per-deployment named admin keys for CI integrations (Vercel, GitHub Actions, Claudin, etc). Each key has its own name, prefix and audit trail, so a leaked Vercel credential doesn't force you to rotate everything else. Mirrors Convex Cloud's **Personal Deployment Settings → Deploy Keys** surface.

Available since **v1.0.3** (migration `000009_deployment_deploy_keys`).

> **Don't confuse deploy keys with access tokens.** They live in different tables for different purposes:
>
> - **`deploy_keys`** — per-deployment admin credential. Format `<deployment>|<hex>`. Verified by the Convex backend by signature against `INSTANCE_SECRET`. Used by CI scripts running `npx convex deploy`.
> - **`access_tokens`** — per-user / team / project / app / deployment session token. Opaque Synapse string verified by Synapse itself. Used by the dashboard, the `synapse` CLI, and human PAT use cases.

---

## The GitHub-PAT model

When you create a deploy key, the **full admin key** is shown **exactly once** in the response. Synapse stores only:

- `admin_key_hash` — SHA-256 of the value (so we can't reconstruct it).
- `admin_key_prefix` — the first 8 hex chars after the `|` separator, shown in the dashboard as a chip so two keys for the same deployment are visually distinguishable.

If you lose the value, you cannot retrieve it. Revoke the row, create a new one. The dashboard's `CreateDeployKeyDialog` surfaces a yellow banner reinforcing this: *"Save this snippet now — you won't see the full key again."*

---

## API surface

All three endpoints live under `/v1/deployments/{name}/deploy_keys` and are gated by `canAdminProject` (project-admin or above).

### `POST /v1/deployments/{name}/deploy_keys`

Mint a fresh admin key signed by the deployment's `INSTANCE_SECRET`.

```bash
curl -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"vercel"}' \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/deploy_keys
```

Request body:
- `name` (required) — short label like `vercel`, `github-actions`, max 64 chars. Must be unique among the deployment's **active** rows (revoked rows free the name up).

Response (`201 Created`, full key shown only here):

```json
{
  "id": "9c5b7e74-...",
  "deploymentId": "...",
  "name": "vercel",
  "adminKey": "brave-dolphin-1060|01234567abcd...",
  "prefix": "01234567",
  "createdBy": "<userId>",
  "createTime": "2026-05-23T12:34:56Z",
  "envSnippet": "CONVEX_SELF_HOSTED_URL=...\nCONVEX_SELF_HOSTED_ADMIN_KEY=...",
  "exportSnippet": "export CONVEX_SELF_HOSTED_URL=...\nexport CONVEX_SELF_HOSTED_ADMIN_KEY=..."
}
```

The `envSnippet` and `exportSnippet` use the same `cliDeploymentURL` resolution as the rest of the deployment surface (custom domain → wildcard → host:port — see the custom-domains doc), so they're paste-ready for the operator's CI environment.

Error codes:
- `deploy_keys_unsupported_for_adopted` (409) — adopted deployments use operator-supplied credentials; deploy keys don't apply.
- `deploy_keys_unsupported_for_ha` (409) — HA deployments don't support deploy keys until replica-wide credential rotation lands.
- `deployment_not_running` (409) — only running single-replica deployments can mint deploy keys.
- `name_in_use` (409) — there's already an active row with that name.
- `missing_name`, `name_too_long` (400) — validation.

### `GET /v1/deployments/{name}/deploy_keys`

Lists **non-revoked** rows for this deployment with metadata only — no secrets. Returns the prefix, name, creator, created/last-used timestamps.

```bash
curl -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/deploy_keys
```

```json
{
  "deployKeys": [
    {
      "id": "...",
      "name": "vercel",
      "prefix": "01234567",
      "createdByName": "Ian Bee",
      "createTime": "...",
      "lastUsedAt": null
    }
  ]
}
```

### `POST /v1/deployments/{name}/deploy_keys/{id}/revoke`

Revoke a single deploy key — but read the next section before you do.

```bash
curl -X POST -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/deploy_keys/<id>/revoke
```

Errors:
- `not_found` (404) — key not found, already revoked, or belongs to a different deployment.
- `deploy_keys_unsupported_*` — same gates as create.

---

## Revoke semantics — important

Revoking a deploy key in Synapse is **heavier than the dashboard makes it look**. The Convex backend authenticates admin keys by checking the key's signature against the deployment's `INSTANCE_SECRET`, with no per-key state on the backend. There is no "deny list" the backend consults. So to actually invalidate a leaked key, the secret has to change.

What the revoke endpoint does, atomically in one transaction:

1. `SELECT … FOR UPDATE` on the deployment + the deploy key row.
2. Generates a fresh `INSTANCE_SECRET` and a new admin key signed by it.
3. Calls `Docker.Recreate` to recreate the deployment's container with the new secret in `INSTANCE_SECRET` env var.
4. Updates `deployments` with the new secret + admin key + container ID + host port.
5. Marks **all active deploy_key rows for that deployment** as revoked (`revoked_at = now()`) — not just the one being revoked. They all signed against the old secret; they're all dead now.

The dashboard's `DeployKeysPanel` confirm dialog spells this out:

> *Synapse will rotate this deployment's credentials and restart its container. All existing deploy keys for this deployment will stop working.*

Expect ~15 seconds of downtime for the container recreate. The dashboard's main admin key (the one the embedded Convex Dashboard iframe uses) also rotates and the embed will re-mint its key automatically on next load.

If the embed shows "admin key invalid" after some other credential issue and you don't want to nuke every deploy key, click **Refresh credentials** in the embed header — that re-mints just the dashboard's own admin key without touching `INSTANCE_SECRET`.

### Fully invalidating a key without rotating

To wipe a specific key while keeping every other deploy key for the deployment working, there's no surgical path. Your options are:

- **Revoke** (rotate INSTANCE_SECRET) — all deploy keys die together.
- **Delete + recreate the deployment** — the deployment gets a brand new identity. Most destructive option, but the only one that's truly air-gapped from the old credential.

There is no per-key revocation on the Convex backend itself, by design of how admin keys work upstream.

---

## Audit log

Every create and revoke writes to the audit log:

- `ActionCreateDeployKey` / `TargetDeployKey` — metadata includes the deployment id + name, the key name, and the prefix (not the value).
- `ActionRevokeDeployKey` / `TargetDeployKey` — metadata includes the deployment id + name and a count of how many rows were revoked together by the rotation.

Audit rows are scoped to the deployment's team, so they show up in the team-activity feed alongside other team-scoped events.

---

## Schema (`migration 000009`)

`000009_deployment_deploy_keys.up.sql` repurposes the orphaned v0 `deploy_keys` table:

```sql
ALTER TABLE deploy_keys
    DROP CONSTRAINT deploy_keys_token_hash_key;

ALTER TABLE deploy_keys
    RENAME COLUMN token_hash TO admin_key_hash;

ALTER TABLE deploy_keys
    ADD COLUMN admin_key_prefix TEXT NOT NULL DEFAULT '',
    ADD COLUMN revoked_at       TIMESTAMPTZ;

CREATE UNIQUE INDEX deploy_keys_active_name
    ON deploy_keys (deployment_id, name)
    WHERE revoked_at IS NULL;
```

Key points:

- The pre-existing global `UNIQUE (token_hash)` was dropped. Admin keys embed the deployment name, so hashes won't collide across deployments anyway; a per-deployment partial unique on `(deployment_id, name) WHERE revoked_at IS NULL` is what we actually want.
- That partial unique means **names are reusable after revoke** — you can have `vercel` revoked, then create `vercel` again. Convenient when rotating creds for the same CI integration.
- `admin_key_hash` is sha256 of the wire value (used only as a fingerprint — Convex doesn't consult it for auth).
- `admin_key_prefix` powers the dashboard chip.
- `revoked_at` NULL is the active marker.

---

## CI usage

The snippets returned by create are paste-ready. For Vercel, drop the `.env.production` snippet straight into project settings → Environment Variables. For GitHub Actions, drop the `export` snippet into a step before `npx convex deploy`:

```bash
# .env.production
CONVEX_SELF_HOSTED_URL='https://api.client.com'
CONVEX_SELF_HOSTED_ADMIN_KEY='brave-dolphin-1060|01234567...'
```

```bash
# GitHub Actions step
- name: Deploy
  run: |
    export CONVEX_SELF_HOSTED_URL='https://api.client.com'
    export CONVEX_SELF_HOSTED_ADMIN_KEY='brave-dolphin-1060|01234567...'
    npx convex deploy
```

The URL in those snippets respects the same custom-domain → wildcard → host:port resolution as the rest of the dashboard.
