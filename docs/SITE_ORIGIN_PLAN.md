# Site Origin — implementation plan (Phase 0 recon)

> **Status:** Phase 0 (recon) complete — model confirmed against upstream
> AND live on the prod box (read-only probes). Awaiting go for Phase 1.
> **Branch:** `feat/site-origin` off `main`.
> **Scope decision:** ship BOTH — `role='site'` custom domains as a
> first-class path (this is what unblocks the real amagejumpy app) AND
> the `<name>.site.<base>` wildcard (Cloud parity).

## 1. The bug, in three lines

The Convex self-hosted backend opens **two** TCP listeners: port **3210**
(cloud / client API + WebSocket + deploy) and port **3211** (the *site
proxy*, where HTTP actions are served at their natural paths). Synapse
today exposes/routes only 3210 and sets `CONVEX_SITE_ORIGIN ==
CONVEX_CLOUD_ORIGIN`. Result: HTTP actions (Better Auth `/api/auth/*`,
webhooks, `/engine/*`) live on 3211, which is never reachable from
outside → **404 externally**. The fix gives each deployment a dedicated
site origin `<name>.site.<BASE_DOMAIN>` that routes to port 3211.

## 2. Model — confirmed against convex-backend upstream

The separation is by **PORT**, not by Host header or origin. The
`CONVEX_CLOUD_ORIGIN` / `CONVEX_SITE_ORIGIN` env vars only generate
URLs/metadata; they do not route.

| Listener | Default port | Serves | Env var that *describes* it |
|---|---|---|---|
| cloud / API | `3210` | client sync, queries/mutations, storage, deploy, **HTTP actions under `/http/`** | `CONVEX_CLOUD_ORIGIN` |
| site proxy | `3211` | any path → rewrites to `127.0.0.1:3210/http<path>` → HTTP actions at natural paths | `CONVEX_SITE_ORIGIN` |

Upstream evidence (`github.com/get-convex/convex-backend`, `main`):

- **`crates/local_backend/src/router.rs`** — `.nest("/http/", http_action_routes())`.
  HTTP actions are mounted only under the `/http/` prefix on the cloud
  listener. `http_action_routes()` routes `/{*rest}` + `/` to the http
  action handler.
- **`crates/local_backend/src/proxy.rs`** — the site proxy rewrites with
  `let new_uri = format!("{}{}", site_forward_prefix, request.uri());`
  and forwards via HTTP client. Upstream host/port come entirely from
  `site_forward_prefix`. Handles GET/POST/DELETE/PATCH/PUT/OPTIONS.
- **`crates/local_backend/src/config.rs`** — API port `default_value =
  "3210"`; `site_proxy_port` `default_value = "3211"`;
  `site_forward_prefix` = `format!("http://127.0.0.1:{}/http", self.port)`
  → `http://127.0.0.1:3210/http` by default; `site_bind_address()` =
  `Some((interface, site_proxy_port))` → the site proxy binds **3211 by
  default** (no flag needed); `convex_origin` default `:3210`,
  `convex_site` default `:3211`.
- **`self-hosted/advanced/hosting_on_own_infra.md`** — instructs **two
  distinct hostnames**: `api.my-domain.com` → 3210 (`CONVEX_CLOUD_ORIGIN`)
  and `my-domain.com` → **3211** (`CONVEX_SITE_ORIGIN`). Confirms the
  cloud/site split is the upstream-blessed deployment shape.

Empirical evidence (Ian, prod deployment `agile-cat-9412` @ `mip.amagejumpy.com`):

- container `:3210` → `/` = 200, `/api/auth/get-session` = **404** (only
  `/http/api/auth/...` = 200).
- container `:3211` → `/api/auth/get-session` = **500** (route EXISTS,
  500 is an app-secret error) → proves the route lives on 3211.
- A reference self-hosted Convex (no Synapse) with the domain pointed at
  the site proxy → `/api/auth/get-session` = 200.

**Key consequence for the design:** port 3211 is *already open and
answering inside every provisioned container today* (Ian's 500 proves
it). In compose / BASE_DOMAIN (DNS) mode the proxy reaches it over the
docker network — so the provisioner does **not** need to publish a new
host port to unblock the site path. What unblocks it is: proxy routing
(Phase 3) + on-demand-TLS gate (Phase 4) + Caddy wildcard (Phase 6) +
the operator's `*.site.<base>` DNS record (Ian, cutover).

## 2.5 Live prod confirmation (read-only probes, `jumpy-vps`)

Confirmed the model on the running prod box — not just from code. All
probes read-only (`docker ps`/`inspect`, ephemeral `--rm` curl container
on `synapse-network`, `psql` SELECT). Nothing on prod was changed.

- **The bug is live.** `convex-agile-cat-9412` env:
  `CONVEX_CLOUD_ORIGIN == CONVEX_SITE_ORIGIN == https://mip.amagejumpy.com`.
- **3211 is already exposed by the image.** `ExposedPorts =
  {3210/tcp, 3211/tcp}` (the convex-backend image declares both).
  `PortBindings` publishes only `3210/tcp → host`. So Phase 2's "add
  3211 to ExposedPorts" is already satisfied in base mode — keep it as
  an explicit/defensive no-op; it only *matters* for host-port mode's
  2nd PortBinding (still a TODO).
- **3211 is reachable on the docker network today** and answers the
  natural HTTP-action path. Probes from inside `synapse-network`:

  | Port | Path | Result |
  |---|---|---|
  | 3210 cloud | `/` | 200 |
  | 3210 cloud | `/api/auth/get-session` | **404** |
  | 3210 cloud | `/http/api/auth/get-session` | 200 |
  | 3211 site | `/api/auth/get-session` | **200** |

  → The only reason it 404s externally is the Synapse proxy never routes
  to `convex-<name>:3211`. Route it, and Better Auth works.

- **Prod uses a CUSTOM DOMAIN, not the wildcard.** `SYNAPSE_BASE_DOMAIN =
  app.synapsepanel.com`, but `agile-cat-9412` is reached via the
  `deployment_domains` row `mip.amagejumpy.com / role=api / active`. The
  app's Better Auth client hits `mip.amagejumpy.com/api/auth/*`. So the
  thing that unblocks the real app is a **`role='site'` custom domain**
  (e.g. `site.mip.amagejumpy.com` → 3211), NOT
  `agile-cat-9412.site.app.synapsepanel.com`. The wildcard ships too,
  for Cloud parity and for installs that don't use custom domains.
- **Custom-domain-site reuses existing infra.** Prod Caddy already has
  the `:443` catch-all → `synapse-api`, and `tls_ask` branch B already
  approves any active `deployment_domains` row regardless of role. So a
  `role='site'` custom domain needs: proxy routing `role='site'`→3211,
  `validateRole` accepting `site`, migration 000022, and correct
  `CONVEX_SITE_ORIGIN`. No new Caddy block, no new preflight probe — the
  `*.site` wildcard pieces (Phase 6) are only for the wildcard path.

## 3. Locked decisions (do not relitigate)

- **Scheme A:** `<name>.site.<BASE_DOMAIN>`. Zero-collision by
  construction (`site` is a separate DNS level, never collides with a
  deployment name), mirrors Cloud's `.convex.cloud` / `.convex.site` 1:1,
  code path separate from cloud. `<name>-site.<base>` rejected (collision
  + threads logic into the shared cloud path).
- **Focus:** BASE_DOMAIN (wildcard) mode — the production shape. In
  wildcard/compose mode the proxy reaches the container by docker DNS
  (`convex-<name>:3211`); no new host-port publish, no port-allocator
  change, **no schema migration** for the routing itself.
- **`role='site'` custom domains are FIRST-CLASS** (revised after live
  prod confirmation): this is the path that unblocks the real amagejumpy
  app (custom domain, not wildcard). It lands in the same Phase 3/5
  slices as the wildcard, not deferred. The only thing still deferred is
  **host-port-mode** publishing of a 2nd host port for 3211 — a
  documented TODO that must not block base/custom-domain mode.
- **Prod/DNS is Ian's hand.** I produce the runbook; I do not run
  `setup.sh` on prod, do not touch `ssh jumpy-vps`, do not create the
  `*.site.<base>` DNS record.

## 4. Confirmed file map (change surface, with file:line)

### URL computation & models
- `synapse/internal/deploymenturl/url.go` — `Computer{PublicURL,
  ProxyEnabled, BaseDomain}` (`:36-51`); `Public()` (`:66-89`); `CLI()`
  (`:104-125`); `LookupActiveAPIDomain()` role='api' (`:135-155`).
  → **add** `Site(d, activeSiteDomain) string` + `LookupActiveSiteDomain()`.
- `synapse/internal/models/models.go` — `DomainRoleAPI`/`DomainRoleDashboard`
  + `DomainStatus*` (`:278-283`); `Deployment` fields `HostPort`/
  `DeploymentURL`/`Adopted` (`:84-94`).
  → **add** `DomainRoleSite = "site"`.

### Provisioner (container env + ports)
- `synapse/internal/docker/provisioner.go` — `DeploymentSpec.PublicURL`
  doc (`:63-69`), `EnvVars` (`:43`); single-replica env build sets
  `CONVEX_CLOUD_ORIGIN`/`CONVEX_SITE_ORIGIN = publicOrigin` (`:358-363`),
  `spec.EnvVars` loop (`:388-390`), `containerPort := nat.Port("3210/tcp")`
  + `ExposedPorts`/`PortBindings` (`:344-345, 402-409`). HA path mirrors
  at `:352`.
  → **add** `SiteURL` to spec; `CONVEX_SITE_ORIGIN = spec.SiteURL`
  (fallback `publicOrigin`); add `3211/tcp` to `ExposedPorts`; host-port
  2nd PortBinding = documented TODO.
- `synapse/internal/provisioner/worker.go` — `Config.PublicURL/ProxyEnabled/
  BaseDomain` (`:87-98`); `computePublicOrigin()` (`:1159-1189`); spec
  build sites (`:694-698`, `:810-824`).
  → **add** `computeSiteOrigin()` mirroring `computePublicOrigin`; set
  `spec.SiteURL`.

### Proxy (routing)
- `synapse/internal/proxy/proxy.go` — `Resolver` (`:41-85`); `addressFor()`
  → `convex-<name>:3210` (`:249-259`); `ResolveDomain()` returns role
  (`:309-354`); `Handler()` dispatch: wildcard (`:417-424`) → custom
  domain (`:430-438`) → path `/d/` (`:442-456`); `matchHostSubdomain()`
  (`:528-539`); `DomainRoleAPI/Dashboard` consts (`:513-516`).
  → **add** `matchSiteSubdomain()`; port-aware addressing
  (`siteAddressFor` → `convex-<name>:3211`); Handler branch: site
  subdomain OR `role=='site'` → 3211. Cloud path untouched.

### On-demand TLS gate
- `synapse/internal/api/tls_ask.go` — branch A wildcard `<sub>.<base>`
  (`:55-88`, rejects multi-label at `:62`), branch B custom domain
  (`:92-109`).
  → **add** site-subdomain branch *before* the generic base check (since
  `<name>.site.<base>` is itself a multi-label subdomain of `<base>` and
  would currently 403 at `:62-65`).

### Custom-domain role
- `synapse/internal/api/domains.go` — `validateRole()` accepts only
  `api`/`dashboard` (`:145-153`); `MountInDeploymentRoutes` (`:84-94`).
  → **add** `site` to `validateRole`.
- `synapse/internal/db/migrations/000012_deployment_domains.up.sql` —
  `role TEXT NOT NULL CHECK (role IN ('api', 'dashboard'))`. **A CHECK
  constraint exists** → Phase 5 needs an **additive migration 000022**
  to allow `'site'` (`ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT
  ... CHECK (role IN ('api','dashboard','site'))`).

### API surface
- `synapse/internal/api/deployments.go` — `publicDeploymentURL()`
  (`:531-533`), `cliDeploymentURL()` (`:572-574`), `urlComputer()`
  (`:537-543`); spec builds (`:223-237`, `:335-357`, `:2589-2597`);
  deployment JSON `deploymentUrl` (`:1322`, `:2146`); cli_credentials
  resp (`:2146-2172`); `rebuildCORSAndRestart` origin (`:223-237`).
  → **add** `siteDeploymentURL()`; expose `siteUrl` in deployment JSON +
  cli_credentials; thread `SiteURL` into every spec build.

### CLI
- `cli/lib/env-file.js` — header comment "API calls and HTTP actions on
  the same host" (`:16-19`) is the documented wrong assumption;
  `NEXT_PUBLIC_CONVEX_SITE_URL = convexUrl` (`:163`); `writeProjectEnv`
  passes `credentials.convexUrl` (`:250-256`).
- `cli/lib/api.js` — `cli_credentials` fetch (`:132`).
- `cli/lib/convex.js` — `envFromCredentials` (`:4`).
  → **change** `NEXT_PUBLIC_CONVEX_SITE_URL = credentials.siteUrl`;
  fix the header comment; `CONVEX_SELF_HOSTED_URL` + `NEXT_PUBLIC_CONVEX_URL`
  stay cloud (`:162,164`).

### Dashboard
- `dashboard/app/teams/[team]/[project]/page.tsx:615` — "HTTP Actions
  URL: same as Cloud URL in self-hosted."
  → **change** to render the real `siteUrl` labeled "HTTP Actions URL".

### Installer / Caddy
- `installer/templates/caddy.wildcard` — `*.{{SYNAPSE_BASE_DOMAIN}}`
  block, `tls{on_demand}` + `reverse_proxy {{CADDY_UPSTREAM_HOST}}:{{SYNAPSE_PORT}}`.
  → **add** sibling `*.site.{{SYNAPSE_BASE_DOMAIN}}` block.
- `installer/templates/caddy.standalone` — global `on_demand_tls { ask
  http://synapse-api:8080/v1/internal/tls_ask }` (covers any on-demand
  site); `:443` catch-all already forwards to `synapse-api:8080`.
  → ensure the wildcard append point also gets the `.site` block; global
  `ask` already covers it (tls_ask Phase 4 makes it answer 200).
- `installer/install/preflight.sh:228` — `check_base_domain` synthetic
  probe `probe-<rand>.<base>`.
  → **add** a `probe-<rand>.site.<base>` probe (warn-only, same shape).
- `installer/templates/env.tmpl` — `SYNAPSE_BASE_DOMAIN`. → docs note
  about the 2nd wildcard DNS record.

## 5. Slices (one commit each; gofmt/vet/test green before moving on)

| Phase | Scope | Key files | Green gate |
|---|---|---|---|
| **1** | Pure URL logic + model const | `deploymenturl/url.go`, `models/models.go`, `url_test.go` | `go test` (unit, per-branch) |
| **2** | Container `CONVEX_SITE_ORIGIN` + 3211 ExposedPort | `docker/provisioner.go`, `provisioner/worker.go`, `api/deployments.go`, FakeDocker tests | `go test` asserts env |
| **3** | Proxy routes `<name>.site.<base>` → 3211 | `proxy/proxy.go`, `proxy/*_test.go` | proxy tests: cloud=3210, site=3211 |
| **4** | tls_ask approves site subdomain | `api/tls_ask.go`, `tls_ask` tests | 200/404/403 cases |
| **5** | API `siteUrl` + CLI + dashboard + `role=site` + migration 000022 | `api/deployments.go`, `api/domains.go`, migration, `cli/lib/env-file.js`, `dashboard/.../page.tsx` | `go test` + `npm run build` + eslint + Playwright |
| **6** | Caddy `*.site` wildcard + preflight probe | `installer/templates/caddy.*`, `installer/install/preflight.sh`, `env.tmpl` | bats (new validators) + shellcheck |
| **7** | Docs: `CONVEX_SITE_ORIGIN.md` (institutional memory) + ARCHITECTURE + RUNBOOK + in-dashboard (en+pt-BR) + CLAUDE.md + RELEASE_NOTES | `docs/`, `dashboard/app/docs/`, `CLAUDE.md`, `.env.example` | build |
| **8** | Staging-VPS smoke + `SITE_ORIGIN_CUTOVER.md` | `synapse-vps`, `docs/SITE_ORIGIN_CUTOVER.md` | `<name>.site.<base>/api/auth/*` ≠ 404; cloud = 200 |

**Two reachability paths, two critical chains:**

- **Custom-domain site (unblocks amagejumpy):** Phase 3 (proxy
  `role='site'`→3211) + Phase 5 (`validateRole`+migration+`siteUrl`) +
  Phase 2 (`CONVEX_SITE_ORIGIN`). Caddy `:443` catch-all + `tls_ask`
  branch B already exist — **no Phase 6 needed for this path.**
- **Wildcard site (Cloud parity):** Phase 3 (`matchSiteSubdomain`→3211) +
  Phase 4 (`tls_ask` site branch) + Phase 6 (Caddy `*.site` block).

Phase 2's `CONVEX_SITE_ORIGIN` matters for Better Auth specifically (it
derives callback/cookie origins from the site URL), so it is *not*
cosmetic even though 3211 already answers. Phase 1 underpins both.

## 6. Risks / couplings flagged

1. **tls_ask ordering** — `<name>.site.<base>` is a multi-label subdomain
   of `<base>`; the current branch A 403s multi-label (`tls_ask.go:62`).
   The site branch MUST run before that check or valid site hosts get
   refused. (Caught here, handled in Phase 4.)
2. **Migration on prod** — Phase 5 adds an additive CHECK-constraint
   migration (000022) for `role='site'`. Additive + embedded, runs on
   startup via golang-migrate. Low risk but it *is* a schema change —
   called out so Phase 8 deploy ordering accounts for it.
3. **Existing deployments freeze `CONVEX_SITE_ORIGIN` at create-time.**
   Deployments provisioned before this change carry
   `CONVEX_SITE_ORIGIN = cloud URL`. They need a recreate/restart to pick
   up the new value. → cutover runbook item (Ian).
4. **Adopted deployments** — operator-supplied URL; `Site()` returns ""
   (or derives from `DeploymentURL`) and the operator sets the site host
   manually. Documented, not auto-magic.
5. **Host-port mode (`--no-tls`, no base domain)** — needs a 2nd
   published host port for 3211; left as a documented TODO so base mode
   ships unblocked.

## 7. What stays in Ian's hands (cutover, Phase 8 deliverable)

- Create the `*.site.<BASE_DOMAIN>` wildcard A record → VPS IP.
- Deploy the new Synapse version to prod (`setup.sh --upgrade`).
- Recreate/restart existing deployments once to bake the new
  `CONVEX_SITE_ORIGIN`.
- Verify real app login (Better Auth) end-to-end.
- Deploy order + rollback steps (in `docs/SITE_ORIGIN_CUTOVER.md`).
