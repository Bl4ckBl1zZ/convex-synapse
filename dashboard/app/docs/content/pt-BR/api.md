# Referência da API Synapse

O Synapse implementa um subset da [Management API v1](https://github.com/get-convex/convex-backend/blob/main/npm-packages/dashboard/dashboard-management-openapi.json) do Convex Cloud + extensões self-hosted.

## Visão geral

| | |
|---|---|
| Base URL | `http://localhost:8080` em dev compose; `https://<seu-host>` em produção |
| Formato | JSON sobre HTTP — `application/json` |
| Header de auth | `Authorization: Bearer <token>` onde `<token>` é JWT de `/v1/auth/login` ou PAT opaco `syn_*` |
| Versionamento | Endpoints públicos sob `/v1/...`. Semver vale para paths, verbos, chaves top-level, strings `code`, hierarquia de roles, escopos, contrato 404 |

### Envelope de erro

Todo body 4xx/5xx vem de `writeError`:

```json
{
  "code": "snake_case_token",
  "message": "Dica legível"
}
```

`code` é estável entre releases.

### Escopos de PAT

| Escopo (X) | Pode agir em team Y? | Pode agir em project Y? | Pode agir em deployment Y? |
|---|---|---|---|
| `user` | sim | sim | sim |
| `team` | só quando X == Y | só quando team de Y == X | só via project em X |
| `project`, `app` | não | só quando X == Y | só deployments em X |
| `deployment` | não | não | só quando X == Y |

Mismatch → `403 forbidden_token_scope`. Enforcement nos helpers `load*ForRequest` — veja `internal/api/scope.go`.

### Paginação

- **Cursor em header** (`GET /v1/teams`, `list_projects`, `list_members`, `list_deployments`): array JSON puro, `?limit=N` (default 100, máx 500) + `?cursor=<id>`, header `X-Next-Cursor: <id>`.
- **Cursor no body** (`/list_personal_access_tokens`, `*/access_tokens`, `/audit_log`, `/activity`): `{items, nextCursor}`, mesmo query.

Cursor ruim → `400 invalid_cursor`. Limit ruim → `400 invalid_limit`.

## Auth

| Método + Path | Auth | Descrição |
|---|---|---|
| `POST /v1/auth/register` | nenhuma | Cria user. Response: `{accessToken, refreshToken, tokenType:"Bearer", expiresIn, user}`. Primeiro user → `isInstanceAdmin=true`. Erros: `400 invalid_email`, `400 weak_password`, `409 email_taken` |
| `POST /v1/auth/login` | nenhuma | Troca email+senha por par de tokens. Erros: `401 invalid_credentials` |
| `POST /v1/auth/refresh` | refresh token | Emite access token novo. Erros: `401 invalid_refresh`, `401 user_not_found` |

Sem logout — JWTs são stateless; PATs revogados via `POST /v1/delete_personal_access_token`.

## Perfil

Endpoints em `/v1/me/*` e top-level `/v1/*`. Alias `/v1/profile/*` também roteia aqui.

| Método + Path | Auth | Descrição |
|---|---|---|
| `GET /v1/me` (alias `/v1/profile`) | JWT ou PAT | Retorna user autenticado |
| `PUT /v1/update_profile_name` (alias `/v1/me/update_profile_name`) | JWT ou PAT | `{name}` |
| `POST /v1/delete_account` (alias `/v1/me/delete_account`) | JWT ou PAT | Erros: `409 last_admin`, `409 team_creator` |
| `GET /v1/member_data` (alias `/v1/me/member_data`) | JWT ou PAT | Bundle `{teams, projects, deployments, optInsToAccept}` |
| `GET /v1/optins` | JWT ou PAT | Sempre `{optInsToAccept: []}` |

## Teams

`{ref}` aceita UUID ou slug.

| Método + Path | Auth | Descrição |
|---|---|---|
| `GET /v1/teams` | JWT ou PAT (`user`/`team`) | Lista teams (cursor em header) |
| `POST /v1/teams/create_team` | JWT ou PAT (`user`) | `{name, defaultRegion?}`. Caller vira admin |
| `GET /v1/teams/{ref}` | membro | Retorna o team |
| `POST /v1/teams/{ref}` | admin | `{name?, slug?, defaultRegion?}` — update |
| `POST /v1/teams/{ref}/delete` | admin | Recusado com deployments (`409 team_has_deployments`) |
| `GET /v1/teams/{ref}/list_projects` | membro | Cursor em header |
| `GET /v1/teams/{ref}/list_members` | membro | Cursor em header |
| `GET /v1/teams/{ref}/list_deployments` | membro | Cursor em header |
| `POST /v1/teams/{ref}/create_project` | membro | `{projectName}` |
| `POST /v1/teams/{ref}/update_member_role` | admin | `{memberId, role}`. Erros: `404 member_not_found`, `409 last_admin` |
| `POST /v1/teams/{ref}/remove_member` | admin (ou si) | `{memberId}`. Erros: `409 last_admin` |
| `POST /v1/teams/{ref}/invite_team_member` | admin | `{email, role}` → `{inviteId, email, role, inviteToken}` |
| `GET /v1/teams/{ref}/invites` | admin | Lista pendentes |
| `POST /v1/teams/{ref}/invites/{inviteID}/cancel` | admin | Delete pending |
| `GET /v1/teams/{ref}/audit_log` | admin | Cursor no body. Default 50, máx 200 |
| `POST /v1/teams/{ref}/access_tokens` | admin | `{name, expiresAt?}` → 201 `{token, accessToken}`. Plaintext UMA vez |
| `GET /v1/teams/{ref}/access_tokens` | membro | Lista tokens do caller |
| `POST /v1/team_invites/accept` | JWT ou PAT | `{token}` → `{teamId, teamSlug, teamName, role}` |

## Projects

`{id}` é UUID. Roles são *project-effective* (override de project_members vence team_members).

| Método + Path | Auth | Descrição |
|---|---|---|
| `GET /v1/projects/{id}` | viewer+ | Retorna o project |
| `PUT /v1/projects/{id}` | project admin | `{name?, slug?}`. Slug unique por team. Erros: `400 invalid_slug`, `409 slug_taken` |
| `POST /v1/projects/{id}/delete` | project admin | CASCADE deleta env vars, project members, deploy keys, deployments |
| `POST /v1/projects/{id}/transfer` | admin src E dest | `{destinationTeamId}`. Erros: `404 team_not_found`, `403 forbidden`, `409 slug_taken` |
| `GET /v1/projects/{id}/list_deployments` | viewer+ | Cursor em header |
| `GET /v1/projects/{id}/deployment` | viewer+ | `?reference=`, `?defaultProd=true`, `?defaultDev=true`, ou newest |
| `GET /v1/projects/{id}/list_default_environment_variables` | viewer+ | `{configs: [{name, value, deploymentTypes}]}` |
| `POST /v1/projects/{id}/update_default_environment_variables` | member+ | `{changes: [{op, name, value?, deploymentTypes?}]}` |
| `POST /v1/projects/{id}/sync_env_to_deployments` | member+ | Recria deployments rodando. ~15s downtime cada. `{total, recreated, skipped, errors?, notice?}` |
| `GET /v1/projects/{id}/list_members` | viewer+ | Mesclada. Campo `source: "project"\|"team"` |
| `POST /v1/projects/{id}/add_member` | project admin | `{userId, role}`. Target precisa estar no team. Erros: `400 not_team_member`, `400 invalid_role` |
| `POST /v1/projects/{id}/update_member_role` | project admin | `{memberId, role}` |
| `POST /v1/projects/{id}/remove_member` | project admin (ou si) | `{memberId}`. Erros: `404 no_override` |
| `POST /v1/projects/{id}/access_tokens` | project admin | Emite PAT project-scoped |
| `GET /v1/projects/{id}/access_tokens` | viewer+ | Lista |
| `POST /v1/projects/{id}/app_access_tokens` | project admin | Emite PAT app-scoped (CI/preview) |
| `GET /v1/projects/{id}/app_access_tokens` | viewer+ | Lista |
| `GET /v1/projects/{id}/topology` | viewer+ | Snapshot regions/host (v1.9.6+) |
| `GET /v1/projects/{id}/activity` | viewer+ | Cursor no body (v1.10.0+) |
| `GET /v1/projects/{id}/dns_credentials` | viewer+ | Credenciais DNS project-scoped (v1.6.4+) |
| `POST /v1/projects/{id}/dns_credentials/cloudflare` | project admin | Adiciona credencial CF |
| `DELETE /v1/projects/{id}/dns_credentials/{id}` | project admin | Remove |
| `POST /v1/projects/{id}/create_deployment` | member+ | Veja Deployments |
| `POST /v1/projects/{id}/adopt_deployment` | project admin | Veja Deployments |

## Deployments

`{name}` é o nome do deployment (ex.: `happy-cat-1234`).

| Método + Path | Auth | Descrição |
|---|---|---|
| `POST /v1/projects/{id}/create_deployment` | project member+ | `{type, reference?, isDefault?, ha?, haOverrides?}`. Type dev/prod/preview/custom (default dev). 201 com `status:"provisioning"`. Erros: `400 invalid_type`, `400 ha_disabled`, `400 ha_misconfigured`, `403 forbidden`, `404 project_not_found` |
| `POST /v1/projects/{id}/adopt_deployment` | project admin | `{deploymentUrl, adminKey, deploymentType?, name?, isDefault?, reference?}`. Probe `/version` + `/api/check_admin_key`. Erros: `400 missing_url`, `400 missing_admin_key`, `400 invalid_url`, `400 invalid_admin_key`, `409 name_taken`, `502 probe_failed` |
| `GET /v1/deployments/{name}` | viewer+ | Retorna o deployment |
| `POST /v1/deployments/{name}/delete` | project admin | Derruba container + volume, marca deleted |
| `GET /v1/deployments/{name}/auth` | viewer+ | `{deploymentName, deploymentUrl, adminKey, deploymentType}` pro embed |
| `GET /v1/deployments/{name}/cli_credentials` | viewer+ | `{deploymentName, convexUrl, adminKey, envSnippet, exportSnippet}` pro `npx convex` |
| `GET /v1/deployments/{name}/backend_version` | viewer+ | Probe ao vivo `{version, fetchedAt, fromCache, lastDeployAt, error?}` |
| `POST /v1/deployments/{name}/upgrade_to_ha` | project admin | `{haOverrides?}`. 202 `{deploymentName, status:"queued", jobId}`. Erros: `400 ha_disabled`, `400 cannot_upgrade_adopted`, `409 already_ha`, `409 deployment_not_running`, `409 upgrade_already_in_progress` |
| `POST /v1/deployments/{name}/reissue_admin_key` | project admin | Re-emite admin_key do instance_secret atual (sem rotação). Erros: `400 cannot_reissue_adopted`, `409 missing_instance_secret` |
| `POST /v1/deployments/{name}/deploy_keys` | project admin | `{name}` (≤64 chars). 201 com chave completa (mostrada UMA vez). Erros: `400 missing_name`, `400 name_too_long`, `409 name_in_use`, `409 deploy_keys_unsupported_for_adopted`, `409 deploy_keys_unsupported_for_ha`, `409 deployment_not_running` |
| `GET /v1/deployments/{name}/deploy_keys` | viewer+ | Lista ativas (só metadata) |
| `POST /v1/deployments/{name}/deploy_keys/{id}/revoke` | project admin | Rotaciona INSTANCE_SECRET; revoga TODAS as ativas. 204 |
| `POST /v1/deployments/{name}/access_tokens` | project admin | Emite PAT deployment-scoped |
| `GET /v1/deployments/{name}/access_tokens` | viewer+ | Lista |
| `GET /v1/deployments/{name}/domains` | viewer+ | Lista custom domains |
| `POST /v1/deployments/{name}/domains` | member+ | `{domain, role:"api"\|"dashboard"}`. Inline DNS preflight. 201 com `domainResponse` |
| `DELETE /v1/deployments/{name}/domains/{domainID}` | member+ | 204 |
| `POST /v1/deployments/{name}/domains/{domainID}/verify` | member+ | Re-roda preflight |
| `POST /v1/deployments/{name}/domains/{domainID}/auto_configure` | member+ | `{credentialId?}` — UPSERT A record via credencial salva |

## Audit log

`GET /v1/teams/{ref}/audit_log` — só admin. Members → `403 forbidden`. Paginação keyset em `(created_at DESC, id DESC)`. Sem endpoint de export, sem retention configurável. Operadores que querem retenção longa snapshotam `audit_events` direto no Postgres.

## Instance admin

Sob `/v1/admin/*`; cada rota gatada por `requireInstanceAdmin` (`users.is_instance_admin=true`).

| Método + Path | Descrição |
|---|---|
| `GET /v1/admin/version_check` | Probe GitHub /releases/latest, cache 15min |
| `POST /v1/admin/version_check/refresh` | Estoura cache (floor 30s) |
| `POST /v1/admin/upgrade` | `{ref?}`. 202 `{started:true, ref}`. Erros: `503 updater_unreachable`/`not_configured`/`token_missing`, `502 updater_unreachable`, `409 upgrade_in_progress`, `400 invalid_ref`, `400 invalid_json` |
| `GET /v1/admin/upgrade/status` | Read-through do `/status` do daemon |
| `GET /v1/admin/host_domain` | `{mode, domain?, baseDomain?, publicUrl?, publicIp?, acmeEmail?, fallbackUrls}` |
| `POST /v1/admin/host_domain` | `{domain?, baseDomain?, plainHttp?, acmeEmail?, autoConfigureDns?}`. 202 `{jobId, statusUrl, state, dnsAuto?}` (v1.4+) |
| `GET /v1/admin/host_domain/status/{jobID}` | Polling do job de reconfigure |
| `GET /v1/admin/dns_credentials` | Lista credenciais DNS instance-wide (só metadata) |
| `POST /v1/admin/dns_credentials/cloudflare` | `{token, label}` — verifica listando zones, cifra via `SYNAPSE_STORAGE_KEY`. Erros: `503 dns_credentials_unavailable`, `400 invalid_token` |
| `DELETE /v1/admin/dns_credentials/{id}` | 204 |

## Install status

`GET /v1/install_status` — **público, sem auth**. Response: `{firstRun, version}`. `firstRun` true se e só se `users` está vazia. Erros: `503 db_unavailable`.

## Internal

`/v1/internal/*` — públicos + sem auth por design (Caddy, Convex Dashboard iframado, form de novo domain). NÃO cobertos pelo semver `/v1`.

| Método + Path | Descrição |
|---|---|
| `GET /v1/internal/tls_ask?domain=<host>` | Gate TLS on-demand do Caddy. 200 = OK; 404 = refuse |
| `GET /v1/internal/list_deployments_for_dashboard?token=<syn_*>` | Feed cross-origin pro dashboard iframado. Token precisa ser `project` ou `app` |
| `GET /v1/internal/dns_provider?domain=<host>` | `{provider, nameservers, error?}` — sempre 200 |
| `GET /v1/cli_latest_version` | Última versão de `@iann29/synapse` no npm (cache 15min) |
| `POST /v1/cli_latest_version/refresh` | Estoura cache (floor 30s) |

## Reverse proxy

Ativo quando `SYNAPSE_PROXY_ENABLED=true`. Dois modos de roteamento:

- **Por path**: `/d/{deploymentName}/*` encaminha pra `http://convex-<name>:3210/...`
- **Por Host header**: `<sub>.<BaseDomain>` (wildcard, v1.0+) e `<custom-domain>` arbitrário (per-deployment, v1.1+) batem contra cache resolver `name → address-list`

Sem auth na camada proxy — deployments aplicam auth de admin key sozinhos.

## Não suportado em self-hosted

Middleware roda ANTES do auth e curto-circuita paths cloud-only com `404 not_supported_in_self_hosted`. **55 entradas totais**: 1 exato (`/v1/validate_referral_code`) + 5 famílias de prefixo (`/v1/cloud_backups`, `/v1/discord`, `/v1/profile_emails`, `/v1/vercel`, `/v1/workos`) + 49 padrões parametrizados cobrindo billing (18), SSO/WorkOS (8), OAuth apps (5), usage/spending (4), cloud backups (6), routes WorkOS-flavoured de deployment (5), + outros. Veja [Self-hosted vs Cloud](/docs/pt-BR/self-hosted-vs-cloud) pro catálogo completo.

## Erros

| Code | Status típico | Significado |
|---|---|---|
| `bad_request` | 400 | JSON malformado, campos desconhecidos |
| `missing_*` | 400 | Campo obrigatório omitido |
| `invalid_*` | 400 | Campo presente mas malformado |
| `weak_password` | 400 | Senha < 8 chars |
| `bad_op` | 400 | op de env var precisa ser `set` ou `delete` |
| `not_team_member` | 400 | Alvo do `add_member` não está no team |
| `ha_disabled` | 400 | `ha:true` mas `SYNAPSE_HA_ENABLED=false` |
| `ha_misconfigured` | 400 | HA on mas config incompleta |
| `cannot_upgrade_adopted` / `cannot_reissue_adopted` | 400 | Adopted são gerenciados externamente |
| `unauthorized` / `unauthenticated` | 401 | Bearer faltando/inválido |
| `invalid_credentials` | 401 | Login mismatch |
| `invalid_refresh` | 401 | Refresh ruim/expirado |
| `missing_token` | 401 | Internal exigia `?token=` |
| `forbidden` | 403 | Role insuficiente |
| `forbidden_token_scope` | 403 | PAT em outro recurso |
| `wrong_scope` | 403 | Dashboard token com escopo errado |
| `*_not_found` | 404 | Veja valores |
| `no_override` | 404 | `remove_member` sem linha em project_members |
| `not_supported_in_self_hosted` | 404 | Veja catálogo |
| `email_taken` | 409 | Colisão no register |
| `slug_taken` | 409 | Colisão de slug |
| `name_taken` | 409 | Colisão adopt_deployment |
| `name_in_use` | 409 | Colisão deploy key |
| `already_ha` | 409 | Deployment já HA |
| `deployment_not_running` | 409 | Operação exige `status='running'` |
| `deploy_keys_unsupported_for_adopted` / `_for_ha` | 409 | Exigem Synapse-managed, single-replica |
| `upgrade_already_in_progress` / `upgrade_in_progress` | 409 | Já rodando |
| `team_has_deployments` | 409 | `delete_team` bloqueado |
| `team_creator` | 409 | `delete_account` em `teams.creator_user_id` |
| `last_admin` | 409 | Orfanaria o team |
| `missing_instance_secret` | 409 | Adopted/old com `instance_secret` vazio |
| `domain_already_registered` | 409 | Domain em uso |
| `probe_failed` | 502 | Adopt probe não alcançou URL |
| `db_unavailable` | 503 | Postgres fora do ar no `install_status` |
| `updater_unreachable` / `not_configured` / `token_missing` | 503 | Daemon updater não cabeado |
| `internal` | 500 | Bug do server |

## Semver

Estável: endpoints `/v1/...`, formas de body, chaves top-level, status codes de sucesso, tabela `code` de erro, hierarquia de roles, escopos, contrato 404 do `not_supported_in_self_hosted`.

**NÃO** cobertos: textos exatos de `message`, formato JSONB de `metadata`, rotas `/v1/internal/*`, migrations, flags do `setup.sh`.
