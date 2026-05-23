# Architecture

Synapse is a **control plane**, not a runtime. It runs on a single host (one VPS, one Docker daemon) and orchestrates N **data-plane** containers — each one a real, open-source Convex backend. The dashboard, CLI, and Convex apps talk to Synapse the same way they would talk to Convex Cloud's Big Brain, except every byte of data and every cent of compute stays on hardware you control.

## The control plane / data plane split

```
                                  ┌──────────────────────────────────┐
   Operator's browser ─────────▶  │           Synapse host           │
   `npx convex deploy` ────────▶  │                                  │
                                  │  ┌────────────┐  ┌────────────┐  │
                                  │  │  Caddy     │  │ Dashboard  │  │
                                  │  │ (optional) │  │ (Next.js)  │  │
                                  │  └─────┬──────┘  └─────┬──────┘  │
                                  │        ▼               ▼         │
                                  │  ┌──────────────────────────┐    │
                                  │  │   synapse-api (Go)       │◀──┐│
                                  │  │   chi router + pgx       │   ││
                                  │  └──────┬───────────────────┘   ││
                                  │         │ docker.sock           ││
                                  │         ▼                       ││
                                  │  ┌────────────────────────┐     ││
                                  │  │ Postgres (synapse-db)  │◀────┘│
                                  │  │ metadata only          │      │
                                  │  └────────────────────────┘      │
                                  │                                  │
                                  │  ┌─── synapse-network ────────┐  │
                                  │  │  convex-<name-a>           │  │ ← data plane
                                  │  │  convex-<name-b>           │  │   (provisioned
                                  │  │  convex-<name-c>           │  │    on demand)
                                  │  └────────────────────────────┘  │
                                  └──────────────────────────────────┘
```

Two important properties fall out of this:

- **One VPS = N deployments.** A single Synapse install hosts as many Convex backends as the host's RAM and disk allow. Each deployment is a sibling container on the `synapse-network` bridge.
- **Synapse never touches your data.** It owns the metadata (teams, projects, env vars, who can do what) and orchestrates Docker. The dashboard's data/functions/logs panes talk straight to the deployment, signed by an admin key Synapse merely stores.

## The pieces that come up

Every install brings these up via `docker compose up -d --build`:

| Container | Image | Port (host) | Role |
|---|---|---|---|
| `synapse-postgres` | `postgres:16-alpine` | 5432 | Metadata DB for the control plane |
| `synapse-api` | `synapse:local` (built from `synapse/`) | 8080 | Go HTTP server: API + reverse proxy |
| `synapse-dashboard` | `synapse-dashboard:local` (built from `dashboard/`) | 6790 | Next.js dashboard |
| `synapse-convex-dashboard` | `ghcr.io/get-convex/convex-dashboard@sha256:…` | — | Upstream Convex UI (data/functions/logs) |
| `synapse-convex-dashboard-proxy` | `caddy:2-alpine` | — | Strips iframe-blocking headers off the upstream UI |
| `synapse-caddy` | `caddy:2-alpine` | 80, 443, 6791 | TLS terminator (only when the `caddy` compose profile is active) |
| `synapse-backend-pg`, `synapse-minio` | postgres + minio | 5433, 9000, 9001 | Backing store for HA deployments (only with `--profile ha`) |

Plus, for every provisioned deployment, one or more Convex backend containers:

| Container | Image | Network |
|---|---|---|
| `convex-<name>` (single-replica) or `convex-<name>-<index>` (HA) | `ghcr.io/get-convex/convex-backend@sha256:…` (pinned) | `synapse-network` |

All Synapse-managed containers carry the Docker label `synapse.managed=true`. This is the canonical way to find them:

```bash
docker ps --filter label=synapse.managed=true
```

## How a request reaches a deployment

`synapse-api` mounts a reverse proxy (`synapse/internal/proxy/proxy.go`) that supports three simultaneous routing modes:

1. **Path-based** — `/d/<name>/<rest>` always routes to the deployment named `<name>`. This is the v0.2 contract and works on every install with `SYNAPSE_PROXY_ENABLED=true`.
2. **Host-header wildcard** — when `SYNAPSE_BASE_DOMAIN` is set (via `--base-domain=<host>`), a request whose `Host` looks like `<sub>.<base>` is routed to the deployment named `<sub>`. `matchHostSubdomain` does a case-insensitive longest-suffix match, then strips the suffix.
3. **Custom domain** — when neither of the above matches, the proxy looks the `Host` up in `deployment_domains`. Active rows bind a hostname to a deployment + role (`api` → backend, `dashboard` → the Convex UI sidecar).

Caddy handles TLS termination and forwards to `synapse-api`. The path of a typical request looks like this:

```
Browser ──▶ https://bold-fox.synapse.example.com/api/query
        ──▶ Caddy (TLS, on-demand cert via /v1/internal/tls_ask)
        ──▶ synapse-api: matches wildcard, looks up "bold-fox"
        ──▶ resolver: reads deployment_replicas, picks address
        ──▶ httputil.ReverseProxy ──▶ convex-bold-fox:3210
```

The resolver caches name → replica list for 30 seconds, with `Invalidate(name)` called after writes so deletes propagate immediately within a node.

## Where state lives

| Kind of state | Where it lives | Backed by |
|---|---|---|
| Users, teams, projects, env vars, deployment metadata, audit events, provisioning jobs | `synapse-postgres` | Named volume `synapse-pgdata` |
| Per-deployment SQLite data (default mode) | The deployment's own Docker volume | `synapse-data-<name>` (single-replica) or `synapse-data-<name>-<index>` (HA) |
| HA deployment data (Postgres + S3 mode) | A per-deployment database on the configured Postgres + buckets on the configured S3 | `backend-postgres` + `minio` when using the bundled `ha` profile |
| Caddy certificates and config | Caddy's own volumes | `synapse-caddy-data`, `synapse-caddy-config` |
| Encrypted secrets (HA backend URL, S3 keys, Cloudflare API tokens) | `deployment_storage` rows, AES-256-GCM | Envelope key `SYNAPSE_STORAGE_KEY` (v0.5+) |

The data plane and control plane have separate lifetimes. `docker compose down -v` clears the metadata DB but leaves the per-deployment volumes alone — operators have to `docker volume rm synapse-data-*` to actually drop deployment data.

## Multi-node safety inside one node

Synapse is built so multiple processes against the same Postgres + Docker daemon do not step on each other. Even single-node installs pay the (cheap) tax so the same code path works under HA scale-out later.

- **Resource allocation races** (port, deployment name, slug) wrap SELECT-then-INSERT in `db.WithRetryOnUniqueViolation`. The UNIQUE constraint catches the race; the helper retries with a freshly generated candidate.
- **Periodic sweeps** (health worker, orphan provisioning sweep, DNS verifier) wrap each tick in `db.WithTryAdvisoryLock(ctx, pool, key, fn)`. Single-node always acquires; multi-node coordinates so exactly one node runs the work each tick. The lock keys live in `synapse/internal/db/advisorylock.go` as constants — never reused for unrelated work.
- **Long-running async work** (deployment provisioning, upgrade-to-HA) is enqueued as rows in `provisioning_jobs`. The `provisioner.Worker` runs N parallel goroutines pulling via `SELECT FOR UPDATE SKIP LOCKED`, so handlers return 201 immediately and any node can pick up the work — including after a crash.

The principle is consistent: no `go someAsyncWork()` directly from a handler.

## The HA model

HA in Synapse is **active-passive, per deployment** — not active-active. The constraint comes from the Convex backend itself (`crates/postgres/src/lib.rs` in the upstream repo): each backing Postgres holds a single-writer lease, so only one replica can be the live writer at a time.

What that buys you in practice:

- A deployment with HA enabled runs **two backend replicas** on the same Synapse host. Both share one Postgres database and one S3 bucket (encrypted credentials live in `deployment_storage`, sealed with the `SYNAPSE_STORAGE_KEY` envelope).
- A `HealthProbe` in `proxy/proxy.go` hits `/api/check_admin_key` on each replica every few seconds and updates `last_seen_active_at` on success.
- The proxy resolves replicas in preference order (most-recently-healthy first, ties by `replica_index`). Single-replica deployments take a fast path; HA deployments buffer the body in memory (1 MB cap) and **transparently retry against the next replica** on connection-level errors.
- Failover is the proxy's job, not the backend's. The dead replica's lease eventually expires; the surviving replica becomes the writer; clients never see a 502 unless every replica is unreachable.

Active-active across replicas is not possible without changes to the upstream backend's lease design.

## "Managed by Synapse"

The canonical definition is: a Docker container or volume created by Synapse's provisioner (`synapse/internal/docker/`). Provisioned containers always:

- Live on the `synapse-network` bridge.
- Carry the label `synapse.managed=true` (set in `client.go` and `provisioner.go`).
- Use the naming scheme `convex-<deployment-name>` (single replica) or `convex-<deployment-name>-<index>` (HA).
- Have data in `synapse-data-<deployment-name>` (single) or `synapse-data-<deployment-name>-<index>` (HA).

This label is what `--uninstall`, `--backup` and the cleanup snippets in the Quickstart filter on. Everything else on the host (your apps, your other containers, Caddy itself, even the Postgres holding metadata) is **not** considered Synapse-managed and is never touched by the lifecycle commands.
