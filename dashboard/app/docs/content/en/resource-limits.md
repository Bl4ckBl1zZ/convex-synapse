# Per-deployment CPU/RAM limits

Optional CPU and memory caps per deployment, enforced by Docker — the self-hosted answer to Cloud's deployment classes. On a shared VPS this is the difference between "one tenant's hot loop slows everyone down" and "one tenant's hot loop throttles that tenant".

Available since **v1.26** (migration `000034_deployment_resources`).

---

## What the limits are

| Field | Range | Maps to |
|---|---|---|
| `cpus` | 0.1 – 64, fractions allowed (`0.5` = half a core) | Docker `NanoCPUs` (`--cpus`) |
| `memoryMb` | 128 – 1 048 576 | Docker `Memory` (hard limit, bytes) |

Both are optional and independent. **Absent = unlimited** — exactly the pre-v1.26 behavior, and what every existing deployment keeps after an upgrade. Out-of-range values are rejected with `400 invalid_resources`.

When a memory-capped container exceeds its limit, the kernel OOM-kills it — and the health worker then flips it to `stopped` (firing a [deployment-down alert](/docs/en/deployment-alerts) if configured) or auto-restarts it. A CPU cap just throttles; nothing is killed.

## Setting limits at create time

The **Create deployment** dialog has two optional fields (CPU limit / Memory limit). Via the API:

```bash
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"type":"prod","cpus":1,"memoryMb":1024}' \
  https://synapsepanel.com/v1/projects/<project-id>/create_deployment
```

Limited deployments show a badge on the card — `1 CPU · 1024 MB`. The values come back as `cpus`/`memoryMb` on every deployment GET/list.

## Resizing a running deployment

Docker fixes `HostConfig` at container-create time — a plain restart keeps the old caps. So **Resize** (button on the expanded card, members+) **recreates the container** with the new limits:

- The data volume is kept — no data loss.
- Expect a brief downtime (seconds) while the container is replaced.
- The body is the **full desired state**: leave a field blank for unlimited. Clearing both removes the badge and uncaps the container.

```bash
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"cpus":2,"memoryMb":2048}' \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/update_resources
```

Audited as `updateDeploymentResources`.

## Guarantees worth knowing

- **Limits survive every recreate.** Custom-domain rebakes, CORS rebuilds and resizes all reload the persisted limits from the database — no code path can silently uncap a container.
- **Restarts are safe** — `docker restart` keeps the existing HostConfig, so the Restart button never changes limits.
- **HA creates** apply the limits to **both** replicas.
- Verify against the daemon any time: `docker inspect -f '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' convex-<name>` (0 0 = unlimited; `5e8` = 0.5 CPU).

## Limitations (v1)

Stable error codes on `update_resources`:

- `409 cannot_resize_adopted` — external backend, no Synapse-managed container.
- `409 ha_resize_not_supported` — resizing a live HA deployment needs a rolling per-replica recreate (tracked); set limits at create time instead.
- `409 remote_resize_not_supported` — recreate only dispatches to the local Docker daemon today.
- `409 deployment_not_running` — the recreate path needs a live container.

## Picking sane values

The Convex backend is a single Rust process; for small/medium apps `0.5–1 CPU` and `512–1024 MB` is a comfortable floor. Going below `0.25 CPU` / `256 MB` makes cold starts and pushes noticeably sluggish — the bounds floor (`0.1` / `128`) exists for experiments, not production. When in doubt, start uncapped, watch `docker stats`, then cap with headroom.
