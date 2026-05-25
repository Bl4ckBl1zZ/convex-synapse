# Safety Invariants

The [Cell Control Plane](CELL_CONTROL_PLANE.md) is **observe + diagnose + plan
only**. These invariants MUST hold. Breaking any of them is a release blocker —
not a refactor decision. They exist because the next capability (apply) is
destructive, so the diagnosis layer is built with hard guarantees first.

## Boundaries with Amagejumpy

1. Synapse does **not** store an end user's Better Auth session.
2. Synapse does **not** decide an Amagejumpy user's RBAC / permissions.
3. Synapse does **not** transport Amagejumpy commands or event payloads today.
4. Synapse is **not** a job broker, a gateway, or Kubernetes.

## The agent is observe-only

5. The agent is **observe-only**: no container create / start / restart / stop /
   remove, no volume ops, no Caddy/proxy changes.
6. The agent's only Docker calls are read-only `docker version` and
   `docker ps -a`.
7. `SYNAPSE_AGENT_APPLY` defaults to `false` and there is **no** apply code path.
8. `GET /v1/agents/desired_state` always returns `applyAllowed: false`,
   `mode: "observe-only"`.

## No apply, anywhere

9. The dashboard has **no Apply button**; it never sends `apply: true`.
10. A `reconcile/dry_run` (or drift recompute) request with `apply: true` is
    rejected `400 apply_not_supported`.
11. Dry-run **never executes** OperationSteps — steps are only `planned` /
    `no_op` / `skipped`, and every plan carries `applyAllowed: false` /
    `willApply: false`.
12. **Docker mutation is forbidden** until a future, explicitly-reviewed block.
13. **Caddy / proxy mutation is forbidden** until a future, explicitly-reviewed
    block.

## No secrets in state

14. **DesiredState** contains no secrets — only placement intent + `synapse.*`
    labels (no env, admin keys, instance secrets, DB URLs, tokens).
15. **ObservedState** contains no env vars, command, logs, mounts, or tokens —
    only safe container metadata + `synapse.*` labels.
16. Drift **diff JSON**, operation **plan/input/result**, and anything the
    dashboard renders are passed through a redactor that scrubs keys matching
    token / secret / password / key / env / admin / instance / database.

## Token handling

17. **ServiceTokens** and **agent tokens** are stored **only as SHA-256 hashes**.
18. A ServiceToken / agent token / adoption token plaintext is shown **once** at
    creation and never again; tokens never appear in logs.
19. ServiceTokens are **link-scoped** (a token discovers only its own CellLink).
20. Agent tokens live in `host_agents`, never `access_tokens` — an agent token
    cannot authenticate as a user.

## Drift correctness

21. Drift must **not** treat a host that is offline / stale / has no agent /
    has docker unavailable / has a degraded scan as `missing`. Such cases are
    `host_unreachable`.
22. Observed-container **pruning** happens **only** when the agent's
    `containerScan` is `succeeded && complete` — never on a failed or
    docker-unavailable scan.
23. `draining` (lifecycle) does **not** mask real drift on an otherwise-online,
    trusted host.

## Tenancy

24. Heartbeat takes the host id from the **agent token**, never the request body.
25. CellLinks are **intra-project only**; cross-project / self links are
    rejected.
