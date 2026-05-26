# Cell Control Plane — API map

Endpoints added by the [Cell Control Plane](CELL_CONTROL_PLANE.md) (Blocos
1–9c). All under `/v1`. "RBAC" abbreviations:

- **instance-admin** — `users.is_instance_admin` (gated by `requireInstanceAdmin`).
- **project-member / project-admin** — resolved via `effectiveProjectRole`
  (project_members override → team_members fallback).
- **agent-bearer** — a `syn_agent_` token in `host_agents`.
- **service-bearer** — a `syn_svc_` token in `service_tokens`.

Every mutating handler writes a best-effort audit row. None of these endpoints
apply changes to a host (see [SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md)).

## Hosts

| Method | Path | RBAC | Notes |
|---|---|---|---|
| GET | `/v1/hosts` | instance-admin | List hosts (+ computed `effectiveStatus`). 403 hides the panel for non-admins. |
| POST | `/v1/hosts` | instance-admin | Create a host row. |
| GET | `/v1/hosts/{id}` | instance-admin | Get a host. |
| PATCH | `/v1/hosts/{id}` | instance-admin | Update name/region/ip/labels/status. |
| POST | `/v1/hosts/{id}/drain` | instance-admin | Set `status=draining` (operator intent). |
| POST | `/v1/hosts/{id}/adoption_token` | instance-admin | **Mints a single-use adoption token (plaintext returned once)** + a join command. |
| GET | `/v1/hosts/{id}/agents` | instance-admin | List the host's agents (no-secrets observed summary). |
| GET | `/v1/hosts/{id}/desired_state` | instance-admin | Host-scoped active desired states. |
| GET | `/v1/hosts/{id}/observed_state` | instance-admin | Host-scoped observed states (safe metadata only). |
| GET | `/v1/hosts/{id}/drift/latest` | instance-admin | Latest host-scoped DriftReport + items. |
| POST | `/v1/hosts/{id}/drift/recompute` | instance-admin | Recompute drift; persists report + `compute_drift` run. |
| POST | `/v1/hosts/{id}/reconcile/dry_run` | instance-admin | Build a `reconcile_dry_run` plan. `apply:true` → 400. |

### Host agents (lifecycle)

| Method | Path | RBAC | Notes |
|---|---|---|---|
| POST | `/v1/host_agents/{id}/revoke` | instance-admin | Token stops authenticating immediately (heartbeats 401). |
| POST | `/v1/host_agents/{id}/rotate_token` | instance-admin | **New token returned once**, old invalidated, agent un-revoked. |

## Agents

Public group (no JWT). Authenticated by the adoption token (register) or the
agent bearer (heartbeat / desired_state).

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/agents/register` | adoption token (body) | Single-use claim → mints an agent token (returned **once**). Creates/binds the host. |
| POST | `/v1/agents/heartbeat` | agent-bearer | Records liveness + host facts + observed containers. Host id from the **token**, never the body. Records observed state best-effort. |
| GET | `/v1/agents/desired_state` | agent-bearer | Host-scoped active desired states + `applyAllowed:false`, `mode:"observe-only"`. |

## Cells

Project-scoped (reuse project RBAC).

| Method | Path | RBAC | Notes |
|---|---|---|---|
| GET | `/v1/projects/{id}/cells` | project-member | List cells. |
| POST | `/v1/projects/{id}/cells` | project-admin/member | Create a cell. |
| GET | `/v1/cells/{id}` | project-member | Get a cell. |
| PATCH | `/v1/cells/{id}` | project-admin/member | Update name/desc/status/region/tier. |
| POST | `/v1/cells/{id}/drain` | project-admin/member | Set `status=draining`. |
| POST | `/v1/cells/{id}/attach_deployment` | project-admin/member | Attach a deployment → CellResource + placement. 409 if already in another cell. |
| POST | `/v1/cells/{id}/attach_host` | project-admin/member | Set the cell's primary host. |
| GET | `/v1/cells/{id}/resources` | project-member | List CellResources + placements. |
| GET/POST | `/v1/cells/{id}/drift/{latest,recompute}` · `/reconcile/dry_run` | latest=member · recompute/dry_run=project-admin | Cell-scoped drift + dry-run. |

## Cell links & service tokens

| Method | Path | RBAC | Notes |
|---|---|---|---|
| GET | `/v1/projects/{id}/cell_links` | project-member | List links. |
| POST | `/v1/projects/{id}/cell_links` | project-admin/member | Create a link (intra-project only). |
| GET | `/v1/cell_links/{id}` | project-member | Get a link (+ resolved endpoint/source). |
| PATCH | `/v1/cell_links/{id}` | project-admin/member | Update allowed commands/events etc. |
| POST | `/v1/cell_links/{id}/disable` | project-admin/member | Disable the link. |
| GET | `/v1/cell_links/{id}/service_tokens` | project-member | List tokens (metadata only; `effectiveStatus`). |
| POST | `/v1/cell_links/{id}/service_tokens` | project-admin/member | **Mint a token (plaintext once)**. Only `authMode=service_token`. |
| POST | `/v1/service_tokens/{id}/revoke` | project-admin/member | Revoke a token. |
| GET | `/v1/internal/cell_links/discovery` | **service-bearer** (public route) | Link-scoped discovery; requires `discovery:read` → 403 `insufficient_scope`. |

## Topology

| Method | Path | RBAC | Notes |
|---|---|---|---|
| GET | `/v1/projects/{id}/cell_topology` | project-member | Real Host → Cell → Deployment → Links + warnings. `mode=legacy_synthetic` when no cells. Non-admins get host IPs stripped; no secrets. |
| GET | `/v1/projects/{id}/topology` | project-member | Legacy synthetic single-host topology (fallback; untouched). |

## State & Drift

| Method | Path | RBAC | Notes |
|---|---|---|---|
| POST | `/v1/projects/{id}/desired_state/sync_from_placements` | project-admin | Derive desired from placements (idempotent). Wrapped in a `sync_desired_from_placements` run. No host change. |
| GET | `/v1/projects/{id}/desired_state` | project-member | List active project desired states. |
| GET | `/v1/projects/{id}/drift/latest` | project-member | Latest project DriftReport + items (`report:null` if none). |
| POST | `/v1/projects/{id}/drift/recompute` | project-admin | Recompute + persist report + `compute_drift` run. |
| POST | `/v1/projects/{id}/reconcile/dry_run` | project-admin | `reconcile_dry_run` plan. `apply:true` → 400 `apply_not_supported`. |
| GET | `/v1/projects/{id}/operation_runs` | project-member | Recent operation runs for the project. |
| GET | `/v1/operation_runs/{id}` | project-member (project-scoped run) / instance-admin (host-only run) | Run + steps + plan/result. |

### Main response shapes

```jsonc
// drift latest / recompute
{ "report": { "id", "status": "clean|warning|drifted|failed", "summary": {…}, "createdAt", "operationRunId"? } | null,
  "items": [ { "driftStatus", "severity", "resourceKey", "recommendedAction", "diff": {…} } ] }

// reconcile dry_run
{ "operationRun": { "type":"reconcile_dry_run", "status":"succeeded",
                    "plan": { "mode":"dry-run", "applyAllowed":false, "summary":{…} } },
  "steps": [ { "action", "status", "resourceKey", "reason", "willApply": false } ] }

// observed_state items (safe metadata only)
{ "items": [ { "resourceType":"docker_container", "observed": { "state", "labels": {"synapse.*"} } } ] }
```

## Security notes (cross-cutting)

- Adoption / agent / service tokens: hash-at-rest, plaintext once, never logged.
- `desired`/`observed`/`diff`/`plan` payloads carry no secrets; the dashboard
  redacts suspicious keys regardless.
- Host-level desired/observed/drift detail is instance-admin (private IPs, raw
  facts); project/cell drift is member-visible but redacted.
- No endpoint accepts `apply:true`. See [SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md).
