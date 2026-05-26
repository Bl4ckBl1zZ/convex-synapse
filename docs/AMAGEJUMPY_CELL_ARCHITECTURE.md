# Amagejumpy & Cells — the conceptual model

This is a **conceptual** document. None of it is implemented in Synapse today;
it exists to lock in the architecture so future work (and future Claude
sessions) don't regress into the wrong shape.

> **The regression to prevent:** "one Convex deployment per normal customer."
> That is wrong. Normal customers are **workspaces inside a single Core**.

## The shape

```
Amagejumpy CORE  (exactly one, user-facing)
  • auth / users / sessions (Better Auth)
  • workspaces  ← normal customers live HERE, as rows/workspaces
  • billing / UI / RBAC of end users

Satellite CELLS  (internal, NOT customers)
  • runtime cell       — executes internal commands / workloads
  • integration cell   — talks to third parties
  • preview cell       — ephemeral environments
  • enterprise-app cell — the exception: a dedicated cell for ONE big customer

Synapse (control plane)
  • manages the CONTRACT (CellLink), PLACEMENT (where a cell runs), LIVENESS
  • does NOT manage end-user auth, sessions, RBAC, or workspace data
```

## Why normal customers are workspaces, not Cells

- A Convex deployment per customer multiplies deployments without bound and
  fragments operations.
- Auth/session/billing live once in the Core; splitting them per customer means
  re-solving identity N times and breaks a single sign-in.
- A **Cell** is an operational/runtime unit, not a tenant. Tenancy is a Core
  concept (workspace), not a Synapse concept.

The **enterprise-app cell** is the deliberate exception: a single large customer
that genuinely needs an isolated deployment gets a dedicated Cell. That's a
business decision, not the default.

## Why not share a session across multiple user-facing Convex backends

Better Auth sessions are bound to one Core. Multiple user-facing Convex
deployments would each need their own session story, and stitching them is both
a security risk and a UX mess. So there is **one** user-facing Core; everything
else is internal.

## Why Synapse manages Cells, not end-user RBAC

Synapse authenticates **operators** (infra managers) and **agents** (machines).
It records *where* things run and *whether* they're alive. It must never become
the place that decides whether end user X may do action Y — that authority is
the Core's, full stop. (See [SAFETY_INVARIANTS.md](SAFETY_INVARIANTS.md) #1–#4.)

## The future flow (NOT implemented)

```
1. End user acts in the Core.
2. Core authorizes the user (its RBAC) and emits an INTERNAL command.
3. A Runtime Cell executes the command.
4. The Runtime Cell returns an event to the Core.
5. Synapse, throughout, manages the CellLink (contract), the placement
   (where the runtime cell runs), and liveness — never the user's permission,
   never the payload's content.
```

Today Synapse models the CellLink + placement + liveness for this flow, but does
**not** transport the command/event payloads, does not run the runtime cell's
workload, and does not authorize the end user. Those are future blocks gated by
explicit review.

## One-line summary

> Core = tenants + auth (one). Cells = internal runtime units (many, not
> customers). Synapse = contract + placement + liveness (never end-user auth,
> never payload transport, never apply — yet).
