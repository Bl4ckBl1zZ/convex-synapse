# Synapse documentation

Synapse is an open-source control plane for self-hosted Convex. One VPS, one `setup.sh`, and you have a dashboard that provisions real Convex backend containers, manages teams and projects, scopes access tokens, and handles auto-updates from the dashboard.

This documentation covers everything — installation, architecture, every API endpoint, every CLI command, every operator lifecycle action, and the rationale behind the choices that aren't obvious from the code.

## Where to start

- **New to Synapse?** Read [Getting started](/docs/en/getting-started) then [Architecture](/docs/en/architecture).
- **Coming from Convex Cloud?** Skim [Self-hosted vs Cloud](/docs/en/self-hosted-vs-cloud) for what is and isn't implemented.
- **Day-to-day operator?** Bookmark [Operator playbook](/docs/en/operator-playbook), [Troubleshooting](/docs/en/troubleshooting), and the [CLI reference](/docs/en/cli).
- **Running a fleet?** Read the [Cell Control Plane](/docs/en/cell-control-plane) — hosts, cells, drift; it observes and plans, but never applies.
- **Building against the API?** Jump to the [API reference](/docs/en/api).
- **Using AI coding agents?** Set up [AI agent skills](/docs/en/ai-agent-skills) so Claude Code / Anthropic Agent SDK pick the right `synapse` command on the first try.

## Index

### Introduction
- [Overview](/docs/en) — this page
- [Getting started](/docs/en/getting-started) — install in one command
- [Architecture](/docs/en/architecture) — control plane, data plane, where state lives
- [Self-hosted vs Cloud](/docs/en/self-hosted-vs-cloud) — what's intentionally cut

### Identity
- [Auth & access](/docs/en/auth-and-access) — register, JWT, PATs, scopes
- [Teams & projects](/docs/en/teams-and-projects) — membership, invites, RBAC, transfer

### Resources
- [Deployments](/docs/en/deployments) — types, HA, adopt, lifecycle
- [Environment variables](/docs/en/env-vars) — project defaults, scoping, sync
- [Custom domains](/docs/en/custom-domains) — wildcard + per-deployment, on-demand TLS
- [Deploy keys](/docs/en/deploy-keys) — named admin keys for CI
- [Convex Dashboard integration](/docs/en/convex-dashboard-integration) — embedded iframe, deployment picker

### Cell Control Plane
- [Overview](/docs/en/cell-control-plane) — observe → compare → plan, never apply
- [Hosts & agents](/docs/en/hosts-and-agents) — register hosts, the observe-only agent
- [Cells, links & topology](/docs/en/cells-links-topology) — group deployments, wire contracts, read the map
- [State & drift](/docs/en/state-and-drift) — desired vs observed, the dry-run planner

### Operations
- [Operator playbook](/docs/en/operator-playbook) — every `setup.sh` mode
- [Auto-update](/docs/en/auto-update) — dashboard banner + updater daemon
- [Audit log](/docs/en/audit-log) — what's recorded, where to read it
- [Troubleshooting](/docs/en/troubleshooting) — symptoms, diagnosis, fix

### Reference
- [CLI reference](/docs/en/cli) — every `synapse <cmd>`
- [API reference](/docs/en/api) — every endpoint
- [AI agent skills](/docs/en/ai-agent-skills) — bundled skills for AI coding agents
