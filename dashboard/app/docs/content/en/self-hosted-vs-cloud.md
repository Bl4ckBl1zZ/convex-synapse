# Self-hosted vs Convex Cloud — what Synapse intentionally doesn't ship

Synapse reimplements **100% of the OpenAPI subset that's relevant to a self-hosted box**, not 100% of the paths Convex Cloud exposes. Roughly 60 of the ~113 cloud paths are intentionally cut. This page is the canonical catalogue of *what* is cut and *why*.

The cut list lives in `synapse/internal/api/not_supported.go`. Anything matching is short-circuited by the `NotSupportedMiddleware` (before `chi` even sees it, before auth runs) and returns:

```json
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "code": "not_supported_in_self_hosted",
  "message": "This endpoint exists in Convex Cloud but is intentionally not implemented in Synapse self-hosted. See docs/ARCHITECTURE.md \"Out of scope\" for the rationale."
}
```

The structured `code` is stable across releases. Use it programmatically to distinguish "I typed the wrong URL" (`404 not_found`) from "this will never ship in self-hosted" (`404 not_supported_in_self_hosted`).

## Why a 404, not a 501

`501 Not Implemented` reads as *"we plan to ship it"*, which keeps callers (dashboards, cloud-spec test suites) retrying forever. `404 not_supported_in_self_hosted` says *"no resource here, never will be"* and lets tooling move on.

The middleware also runs **before** the auth gate — so an unauthenticated probe can find out the endpoint isn't coming back without first jumping through login.

## How the matcher works

Three layers, in order:

1. **Exact paths** — one-off cuts. (1 entry)
2. **Whole-prefix families** — every path under this prefix is cut. (5 prefixes)
3. **Parameterised patterns** — `/v1/<resource>/<id>/<verb>` where the middle segment is a wildcard. Matched with Go's `path.Match` — `*` is a single segment. (49 patterns)

Total: **1 exact + 5 prefix families + 49 parameterised patterns**.

## Categorised cut list

### Billing — Orb / Stripe (20 parameterised endpoints)

Convex Cloud uses Orb on top of Stripe for metered billing. None of this exists in self-hosted because the operator owns the VPS bill directly.

```
/v1/teams/*/apply_referral_code
/v1/teams/*/cancel_orb_subscription
/v1/teams/*/change_subscription_plan
/v1/teams/*/create_setup_intent
/v1/teams/*/create_subscription
/v1/teams/*/get_current_spend
/v1/teams/*/get_discounted_plan/*
/v1/teams/*/get_discounted_plan/*/*
/v1/teams/*/get_entitlements
/v1/teams/*/get_orb_subscription
/v1/teams/*/get_spending_limits
/v1/teams/*/has_failed_payment
/v1/teams/*/list_active_plans
/v1/teams/*/list_invoices
/v1/teams/*/referral_state
/v1/teams/*/set_spending_limit
/v1/teams/*/unschedule_cancel_orb_subscription
/v1/teams/*/update_billing_address
/v1/teams/*/update_billing_contact
/v1/teams/*/update_payment_method
```

### SSO via WorkOS (8 parameterised endpoints)

WorkOS is the enterprise-SSO add-on Convex Cloud sells. OIDC is on the Synapse roadmap, but the WorkOS-specific routes themselves will never ship. Email+password JWT is the current auth model.

```
/v1/teams/*/disable_sso
/v1/teams/*/enable_sso
/v1/teams/*/generate_sso_configuration_link
/v1/teams/*/get_sso
/v1/teams/*/update_sso
/v1/teams/*/workos_integration
/v1/teams/*/workos_invitation_eligible_emails
/v1/teams/*/workos_team_health
```

Plus the whole `/v1/workos/*` prefix family for the WorkOS webhook + callback handlers.

### OAuth apps (6 parameterised endpoints)

Convex Cloud sells "OAuth apps" as a product offering — third parties registering apps that consent-flow into a Convex account. Out of scope for a self-hosted control plane.

```
/v1/teams/*/oauth_apps
/v1/teams/*/oauth_apps/check
/v1/teams/*/oauth_apps/register
/v1/teams/*/oauth_apps/*/delete
/v1/teams/*/oauth_apps/*/regenerate_secret
/v1/teams/*/oauth_apps/*/update
```

### Usage / metering (4 parameterised endpoints)

Cloud-only metering surfaces. Self-hosted operators read their own docker / VPS metrics.

```
/v1/teams/*/usage/current_billing_period
/v1/teams/*/usage/query
/v1/teams/*/usage/team_usage_state
/v1/teams/*/usage/get_token_info
```

### Cloud-managed backups (6 parameterised endpoints)

Cloud schedules and stores backups for you. Self-hosted equivalent: `setup.sh --backup` (local or `--to-s3=s3://…`).

```
/v1/deployments/*/configure_periodic_backup
/v1/deployments/*/disable_periodic_backup
/v1/deployments/*/get_periodic_backup_config
/v1/deployments/*/list_cloud_backups
/v1/deployments/*/request_cloud_backup
/v1/deployments/*/restore_from_cloud_backup
```

Plus the whole `/v1/cloud_backups/*` prefix family.

### WorkOS-flavoured deployment / project routes (5 parameterised endpoints)

These tie a deployment or project to a WorkOS-managed environment. Same reasoning as the WorkOS cut above.

```
/v1/deployments/*/has_associated_workos_team
/v1/deployments/*/workos_environment
/v1/deployments/*/workos_environment_health
/v1/projects/*/workos_environments
/v1/projects/*/workos_environments/*
```

### Referrals (1 exact endpoint)

The single non-team-scoped referral endpoint. Referral programs only make sense for paid Cloud.

```
/v1/validate_referral_code
```

### Whole-prefix families

| Prefix | Why cut |
|---|---|
| `/v1/cloud_backups` | Replaced by `setup.sh --backup [--to-s3=…]` |
| `/v1/discord` | Cloud-only Discord webhook / integration surface |
| `/v1/profile_emails` | Cloud-only email management (verified secondary emails, etc) — Synapse uses a single login email |
| `/v1/vercel` | Cloud-only Vercel integration |
| `/v1/workos` | Enterprise SSO via WorkOS — OIDC is the planned replacement |

## What IS implemented — compatibility scorecard

From `docs/ROADMAP.md`:

| Resource | Coverage |
|---|---|
| Auth | custom (no WorkOS — OIDC tracked separately) |
| Profile (`/me`) | get / update_profile_name / delete_account / member_data / optins |
| Teams | get / update / delete / list_projects / list_members / list_deployments / invites / accept / update_member_role / remove_member |
| Projects | get / update (name+slug) / delete / transfer / env vars / list_deployments / **list/add/update_role/remove members (RBAC v1.0+)** |
| Deployments | get / create / adopt / delete / auth / cli_credentials / deploy_keys / custom domains (v1.0); `upgrade_to_ha` validation route is reserved and returns 501 until the snapshot export/import worker lands |
| Personal access tokens | user / team / project / app / deployment scopes + scope-aware auth middleware |
| Team invites | list / cancel / accept (custom: opaque-token URL flow) |
| Audit log | team-scoped read; admin-only |
| Reverse proxy | `/d/{name}/*` + Host-header subdomains (custom domains v1.0) |
| CLI compat | `cli_credentials` endpoint + signed admin keys |
| Cloud backups | self-hosted equivalent: `setup.sh --backup [--to-s3=...]` |
| Billing / SSO / Discord / Vercel / OAuth apps / referrals | intentionally cut — `404 not_supported_in_self_hosted` |

ROADMAP claims "100% of the self-hosted-relevant subset" since v1.0; the OpenAPI-coverage milestone is marked DONE there.

## "Maybe never" — bigger pieces that won't come back

- Full Stripe/Orb billing parity (irrelevant for self-hosted)
- LaunchDarkly equivalent (use static config + env vars)
- WorkOS-specific paths (use OIDC instead — on the roadmap)
- Discord / Vercel / etc integrations (out of scope)

## OIDC roadmap note

OIDC-based SSO is on the roadmap — explicitly listed as `OAuth / SSO via OIDC` under "Deferred / out of scope this milestone" in ROADMAP.md, with the note *"Synapse stays email+password JWT until then; enterprise SSO is the next big request once RBAC lands"*. RBAC has landed (v1.0+). OIDC is the next big auth piece. The WorkOS-specific cut list above is permanent regardless — OIDC will be a parallel auth model, not a fill-in for WorkOS routes.

## What to do when you hit a `not_supported_in_self_hosted`

- If you're a dashboard or CLI: branch on the `code` field. Render a "feature only available on Convex Cloud" message instead of a generic error.
- If you're a script: stop retrying. The endpoint isn't going to start working.
- If you're an operator who expected this to work: check this page first. If the cut surprises you, file an issue — but the bar is "this is genuinely useful for a self-hosted operator", not "Cloud has it".
