# Synapse docs

Index of the documentation under `docs/`. Synapse is an open-source control
plane for self-hosted Convex deployments.

## Cell Control Plane

The `feat/cell-control-plane` layer — hosts, agents, cells, placements,
service-to-service contracts, and the desired/observed/**drift** + dry-run
engine. **Observe + diagnose + plan only — it never applies changes.**

| Doc | What's in it |
|---|---|
| [CELL_CONTROL_PLANE.md](CELL_CONTROL_PLANE.md) | **Start here.** What it is, why, vocabulary, architecture, Amagejumpy relationship. |
| [CELLS.md](CELLS.md) | Cells, kinds, environments, isolation, CellResource, placements, backfill. |
| [HOSTS_AND_AGENTS.md](HOSTS_AND_AGENTS.md) | Hosts, the observe-only agent, liveness, containerScan, pruning. |
| [CELL_LINKS_AND_SERVICE_TOKENS.md](CELL_LINKS_AND_SERVICE_TOKENS.md) | Service-to-service contracts, link-scoped tokens, discovery. |
| [DESIRED_OBSERVED_DRIFT.md](DESIRED_OBSERVED_DRIFT.md) | Intent vs reality vs drift; statuses, host trust, dry-run. |
| [OPERATION_RUNS.md](OPERATION_RUNS.md) | OperationRun vs audit log; types, steps, debugging. |
| [SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md) | The rules that must not break (read before changing this layer). |
| [API_CELL_CONTROL_PLANE.md](API_CELL_CONTROL_PLANE.md) | Endpoint map with RBAC + security notes. |
| [RUNBOOK_CELL_CONTROL_PLANE.md](RUNBOOK_CELL_CONTROL_PLANE.md) | Operational flows + common diagnostics. |
| [AMAGEJUMPY_CELL_ARCHITECTURE.md](AMAGEJUMPY_CELL_ARCHITECTURE.md) | Conceptual: Core + Satellite Cells; anti-regression. |

## General Synapse

| Doc | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Overall system architecture. |
| [API.md](API.md) | Core REST API. |
| [DESIGN.md](DESIGN.md) | Design notes / trade-offs. |
| [QUICKSTART.md](QUICKSTART.md) | Get a stack running. |
| [PRODUCTION.md](PRODUCTION.md) | Production deployment. |
| [ROADMAP.md](ROADMAP.md) | General roadmap. |
| [HA_TESTING.md](HA_TESTING.md) | HA-per-deployment testing. |
| [HOST_DOMAIN_WILDCARD.md](HOST_DOMAIN_WILDCARD.md) | Custom domains / wildcard TLS. |
| [V0_5_PLAN.md](V0_5_PLAN.md) · [V0_6_INSTALLER_PLAN.md](V0_6_INSTALLER_PLAN.md) | Version plans. |
| [REMOTE_HOSTS.md](REMOTE_HOSTS.md) | v1.18+ multi-host deployment via Headscale + SSH. |
| [SECURITY_REMOTE_HOSTS.md](SECURITY_REMOTE_HOSTS.md) | v1.18+ Remote Hosts threat model + key rotation. |
| [SCREENSHOTS.md](SCREENSHOTS.md) | Visual tour of the dashboard. |

## Historical / archived

| Doc | What's in it |
|---|---|
| [archive/HANDOFF_OPENAPI_PUSH.md](archive/HANDOFF_OPENAPI_PUSH.md) | v0.6.1-era handoff to close the OpenAPI gap. All Priority-1 items shipped (see API.md). |
