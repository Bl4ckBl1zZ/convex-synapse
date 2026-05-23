# Deployments

## What a deployment is

A Synapse deployment is **one running Convex backend** that Synapse provisioned (or adopted) on your behalf. From the operator's point of view a deployment is a triple:

- a globally-unique **name** (e.g. `quiet-cat-1234`),
- a single **URL** clients connect to,
- a single **admin key** that authenticates writes against that URL.

Behind the scenes a non-HA deployment is one Docker container (`convex-<name>`) plus one data volume (`synapse-data-<name>`). An HA deployment is two containers (`convex-<name>-0`, `convex-<name>-1`) sharing a dedicated Postgres database and S3 bucket prefix instead of local SQLite. Either way, the dashboard, the CLI and your application code only ever talk to the deployment by name and URL.

## Deployment types

When you create a deployment you pick a type. The type is metadata: it gates which project-default env vars get seeded into the container, drives `is_default` lookups, and is the value `convex` CLI tools show in their status output.

| Type      | Use case                                                | `is_default` semantics                                         |
|-----------|---------------------------------------------------------|----------------------------------------------------------------|
| `dev`     | Developer-machine instance, low-stakes, easy to wipe    | At most one `dev` per project is marked default                |
| `prod`    | Production, the deployment customers reach              | At most one `prod` per project is marked default               |
| `preview` | Short-lived per-branch instance for CI / PR previews    | Multiple preview deployments coexist; default is informational |
| `custom`  | Anything that doesn't fit above (staging, perf testing) | Default is informational                                       |

Invalid types are rejected with HTTP 400 `invalid_type` before provisioning starts.

## Name generation

Synapse auto-generates the deployment name as `<adjective>-<animal>-<NNNN>` (e.g. `bright-otter-4710`, `snappy-axolotl-2031`). Four-digit suffix, lowercase ASCII, dashes — safe for use as a Docker container name, a URL slug, and the `INSTANCE_NAME` env var the Convex backend reads at boot.

- Adjective pool: 34 short, kid-friendly words (`quiet`, `bright`, `lush`, …).
- Animal pool: 36 animals (`cat`, `otter`, `axolotl`, `capybara`, …).
- Suffix: a random 4-digit number in the range `1000-9999`.

Total namespace is comfortably larger than the deployment counts a single Synapse instance is built for. Collisions are caught by a `UNIQUE` constraint on `deployments.name` and retried up to 25 times before the API returns `500`.

You cannot rename a deployment after it exists. If you `adopt` an external backend you may supply your own name; otherwise the auto-generated one is what you keep.

## Lifecycle

```
            ┌──────────────┐    Docker provisions container
provision → │ provisioning │ ── + healthcheck passes ────────► running
            └──────────────┘                                     │
                  │                                              │
                  │ Docker / healthcheck fails                   ▼
                  ▼                                       ┌───────────┐
              ┌────────┐                                  │  stopped  │
              │ failed │                                  └─────┬─────┘
              └────────┘                                        │
                                                                ▼
                                                          ┌──────────┐
                                                          │ deleted  │  (terminal)
                                                          └──────────┘
```

Status values come from `models.Deployment.Status` and are persisted on the `deployments` row:

| Status         | Meaning                                                                                                                                                         |
|----------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `provisioning` | Row inserted; a `provision` job sits in `provisioning_jobs` waiting for a worker. The container does not exist yet.                                             |
| `running`      | Container is up and its admin-key healthcheck returned 2xx. The deployment is serving traffic.                                                                  |
| `stopped`      | The container exists but is not running. Reachable by manual `docker stop` or by a failed restart attempt.                                                      |
| `failed`       | The provision job ran and Docker (or the healthcheck) returned an error. The row is kept so you can see why; no container is running.                          |
| `deleted`      | Terminal. Container + volume have been removed. The row is kept for audit history but is invisible to every list endpoint.                                      |

The provisioner worker reconciles `deployment_replicas.status` with the actual container state and rolls the worst-case replica state up to the deployment row.

## Provisioning time

For a Synapse-managed, non-HA deployment the warm path (image already cached, no Postgres+S3 wiring) takes on the order of a second from `POST /create_deployment` to `status=running`. Cold paths (first deployment ever — the `ghcr.io/get-convex/convex-backend` image is being pulled) can take a minute or two on a slow connection; the provisioner job timeout is **5 minutes**, after which a stuck Docker call is marked `failed` and the row recovers.

HA deployments take longer because two replicas are provisioned in parallel against Postgres + S3 and each one has to clear the same healthcheck.

## HA model

HA is opt-in per deployment and only available when `SYNAPSE_HA_ENABLED=true` is set on your Synapse instance. The model is **active-passive replicas per deployment**, not active-active sharding:

- `replica_count = 2` containers are provisioned, indexed `0` and `1`.
- Both replicas point at the **same** dedicated Postgres database (`convex_<name>`) and the **same** dedicated S3 bucket prefix (`<prefix>-<name>-{files,modules,search,exports,snapshots}`). Storage credentials are encrypted at rest with `SYNAPSE_STORAGE_KEY` and stored in the `deployment_storage` table.
- Only one replica holds the Convex single-writer lease at any moment. The other is hot-standby ready to take over.
- The proxy returns a multi-replica address list and fails over on connection error.

You can upgrade an existing single-replica deployment in place with `POST /v1/deployments/{name}/upgrade_to_ha`. The worker keeps the old container serving while it provisions the two HA replicas, exports a snapshot from the old container, imports it into the new pair, then atomically swaps the DB rows. Adopted deployments cannot be upgraded — convert on the source side and re-adopt.

## The `--default` flag

When you create a deployment with `--default` (or `isDefault: true` in the API), the row's `is_default` boolean is set. The flag tells the dashboard and the CLI which deployment to pick when you don't name one explicitly:

- `GET /v1/projects/{id}/deployment?defaultProd=true` returns the `prod` deployment with `is_default=true`.
- `GET /v1/projects/{id}/deployment?defaultDev=true` returns the `dev` one.
- The dashboard's "open default" button on a project card uses the same query.

A common pattern is to mark one `dev` and one `prod` deployment as default per project. Nothing stops you from marking multiple — the resolver just picks the most recent one. The flag has no effect on provisioning behaviour, just on lookups.

## Adopt-existing flow

If you already run a Convex backend outside Synapse (in another Docker stack, on Fly, on bare metal), you can register it into Synapse's catalog via `POST /v1/projects/{id}/adopt_deployment`. You supply:

| Field            | Required | Notes                                                                       |
|------------------|----------|-----------------------------------------------------------------------------|
| `deploymentUrl`  | yes      | `http://...` or `https://...`. Trailing slash is stripped.                  |
| `adminKey`       | yes      | The admin key the running backend already trusts.                           |
| `deploymentType` | no       | One of `dev`/`prod`/`preview`/`custom` (defaults to `dev`).                 |
| `name`           | no       | If omitted, Synapse generates one. If supplied, must be globally unique.    |
| `isDefault`      | no       | Same semantics as the create flow.                                          |
| `reference`      | no       | Free-form label (e.g. a git branch, a vercel preview ID).                   |

Before recording the row Synapse probes the URL with `GET /version` (reachability) and `GET /api/check_admin_key` (auth). Either failing surfaces as `400 invalid_url`, `400 invalid_admin_key`, or `502 probe_failed`. On success the row is inserted with `adopted=true`, `status=running`, and `instance_secret=''`.

Adopted deployments are **read-only from Synapse's lifecycle perspective**: delete just unregisters the row (the actual container keeps running until you stop it), and `upgrade_to_ha` / `reissue_admin_key` are refused with `cannot_*_adopted`. Synapse does not touch the container, the volume, or the credentials.

## Reissue admin key

`POST /v1/deployments/{name}/reissue_admin_key` re-mints the deployment's stored admin key from its current `instance_secret`. Use this when the stored key has drifted out of sync with the running container — symptom: the embedded Convex Dashboard surfaces "deployment URL or admin key is invalid" even though the deployment is up.

| Property                | Behaviour                                                                                                  |
|-------------------------|------------------------------------------------------------------------------------------------------------|
| Rotates `instance_secret` | **No.** The secret is untouched.                                                                         |
| Invalidates deploy keys | **No.** Every existing deploy key keeps working because they were all signed by the same `INSTANCE_SECRET`. |
| Recreates the container | **No.** The backend accepts any key signed by the current secret.                                          |
| Refused for             | Adopted deployments, deployments with an empty `instance_secret`.                                          |
| Permission              | Project admin.                                                                                             |

Revoking a **deploy key** is different — that one rotates `INSTANCE_SECRET`, recreates the container, and invalidates every active deploy key on the deployment. See the deploy-keys docs for that path.

## Deletion

`POST /v1/deployments/{name}/delete` is **irreversible**:

1. For Synapse-managed deployments: Docker stops + removes the container; the data volume (`synapse-data-<name>` or the per-replica equivalents) is also removed. SQLite data is gone. HA Postgres + S3 buckets are also dropped.
2. For adopted deployments: the row is just marked `deleted`. Synapse never touched the container; it keeps running.
3. In either case the `deployments` row flips to `status=deleted` and is hidden from every list endpoint. The row itself is kept so the audit log can reference it.
4. If the row was still `provisioning` at delete-time, Synapse marks it `deleted` without calling Docker; the in-flight provision worker sees the status change after `Provision` returns and tears down whatever it built.

Permission: project admin.

## URL forms

The URL Synapse returns to clients depends on how your install is configured. The decision matrix (first match wins) is in `publicDeploymentURL`:

| Configuration                                | Returned URL                            | Used when                                                                     |
|----------------------------------------------|-----------------------------------------|-------------------------------------------------------------------------------|
| Adopted deployment                           | The URL you supplied at adopt time      | Always wins for adopted rows                                                  |
| Active custom domain with role `api`         | `https://<custom_domain>`               | You registered a custom domain via `POST /v1/deployments/{name}/domains`      |
| `SYNAPSE_BASE_DOMAIN=<host>` set             | `https://<name>.<host>`                 | Wildcard subdomain mode (requires `*.<host>` DNS + on-demand TLS in Caddy)    |
| `SYNAPSE_PUBLIC_URL` + proxy enabled         | `<PublicURL>/d/<name>`                  | Path-proxy mode (works without wildcard DNS, default for `setup.sh`)          |
| `SYNAPSE_PUBLIC_URL` set, proxy disabled     | `<PublicURL_host>:<HostPort>`           | Direct port exposure (firewall must allow the dynamic port)                   |
| Nothing set                                  | `http://127.0.0.1:<HostPort>` (legacy)  | Local dev, no public URL config. The dashboard renders a red "no-domain" chip |

The CLI gets a slightly different form (`cliDeploymentURL`) that never uses the `/d/<name>` path-proxy form: the `npx convex` CLI builds API requests with `new URL("/api/...", baseUrl)`, which is host-anchored and would drop a path prefix. Custom-domain and `BaseDomain` modes work transparently for both browsers and the CLI.
