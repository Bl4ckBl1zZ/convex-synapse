# Audit log + activity feed

O Synapse persiste toda operação mutante numa única tabela `audit_events`. Duas views expõem esses dados: o **audit log** do time (só admin, tabela forense completa) e o **activity feed** do projeto (member+, narrativa estilo timeline).

## Modelo de dados

`audit_events` (migration `000001_init.up.sql`):

```sql
CREATE TABLE audit_events (
    id          bigserial PRIMARY KEY,
    team_id     uuid REFERENCES teams(id) ON DELETE CASCADE,
    actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    action      text NOT NULL,
    target_type text,
    target_id   uuid,
    metadata    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_team_idx ON audit_events (team_id, created_at DESC);
```

Propriedades:

- **Leitura team-scoped.** Toda query de listagem filtra por `team_id`. Eventos cross-team (profile, upgrades de instância, DNS credentials) ficam com `team_id IS NULL`.
- **Actor preservado em delete do usuário.** `ON DELETE SET NULL` em `actor_id` significa que o trail de um user deletado mantém a ação mas perde o nome.
- **Writes best-effort.** `audit.Record` (em `synapse/internal/audit/audit.go`) loga warn em falha de insert e retorna — nunca quebra a request do usuário.
- **Sem retention/pruning.** Sem job auto-purge, sem TTL. Linhas vivem pra sempre (ou até o time ser `CASCADE`'d). Operadores que querem política rodam `DELETE FROM audit_events WHERE created_at < ...`.

## Ações registradas

De `synapse/internal/audit/audit.go`:

**Auth:** `login`

**Teams:** `createTeam`, `updateTeam`, `deleteTeam`, `inviteTeamMember`, `cancelInvite`, `acceptInvite`, `updateMemberRole`, `removeMember`

**RBAC project-level** (v1.0+): `addProjectMember`, `updateProjectMemberRole`, `removeProjectMember`

**Profile:** `updateProfileName`, `deleteAccount`

**Projects:** `createProject`, `deleteProject`, `renameProject`, `updateProject`, `transferProject`, `updateProjectEnvVars`, `syncEnvToDeployments`

**Deployments:** `createDeployment`, `deleteDeployment`, `adoptDeployment`, `upgradeToHA`, `reissueAdminKey`

**PATs:** `createPersonalAccessToken`, `deletePersonalAccessToken`

**Deploy keys:** `createDeployKey`, `revokeDeployKey`

**Custom domains** (v1.1+): `domain.added`, `domain.removed`, `domain.verified`, `domain.auto_configured`

**Credenciais DNS** (v1.5+): `dns_credential.added`, `dns_credential.removed`, `project_dns_credential.added`, `project_dns_credential.removed`

**Upgrades de instância** (v1.1.0+): `upgradeStarted`

**Reconfigure de host-domain** (v1.4+): `host_domain.change_initiated`

Target types: `team`, `project`, `deployment`, `invite`, `accessToken`, `user`, `deployKey`, `domain`, `synapse` (instance-level), `dnsCredential`.

## Audit log do time (só admin)

Endpoint: `GET /v1/teams/{teamRef}/audit_log?limit=50&cursor=<id>`.

Handler: `listAuditLog` em `synapse/internal/api/audit_log.go`. Só admin — `role != models.RoleAdmin` devolve `403 forbidden`. Members NÃO recebem visibilidade parcial.

Paginação: keyset em `(created_at DESC, id DESC)`. Limit default 50, máx 200.

Dashboard renderiza em `/teams/<ref>/audit` via componente compartilhado `AuditLogView` (`dashboard/components/AuditLogView.tsx`), polling a cada 30 segundos.

### Filtros e busca

Filtros client-side (a API devolve lista flat, todo filtro acontece no browser):

- Chips de range: 24h / 7 dias / 30 dias / All time
- Dropdown de actor
- Buckets de verbo: Create/Add, Delete/Remove, Update/Rename, Members & Tokens, Domains & DNS, Settings
- Dropdown de target type
- Busca free-text

Eventos agrupam por dia com header sticky. Cada linha expande pra mostrar metadata JSON.

### Export

Dois formatos, ambos filtrados pela view atual:

- **CSV** — `id, createTime, action, actorEmail, actorName, targetType, targetId, targetName, metadata`. CSV-escape para vírgula/aspas/newline.
- **JSON** — array de eventos normalizados.

Nome: `synapse-team-audit-<YYYY-MM-DD>.csv` (ou `.json`). Download 100% client-side via `Blob` + `URL.createObjectURL`.

## Activity feed do projeto (member+)

Endpoint: `GET /v1/projects/{id}/activity?limit=30&cursor=<id>`.

Handler: `ActivityHandler.ServeHTTP` em `synapse/internal/api/activity.go`. Permissão casa com o gate de leitura: viewer / member / admin.

### Query de escopo

```sql
WHERE e.team_id = $1
  AND (
    (e.target_type = 'project' AND e.target_id = $2)
    OR (e.target_type = 'deployment' AND d.project_id = $2)
    OR (e.target_type = 'domain' AND dd_dep.project_id = $2)
  )
```

Cobre ações diretas no project, ações de deployments do project, e ações de domain pros deployments. Eventos account-level, DNS credentials e instance-level (`synapse`) são propositalmente excluídos.

### Resolução server-side do `targetName`

A query joina `projects` / `deployments` / `deployment_domains` pra popular `target_name`, então o client renderiza "brave-dolphin-1060 created" sem fetch extra:

```sql
COALESCE(p.name, d.name, dd.domain, '') AS target_name
```

### A view de timeline

Componente: `ActivityFeed` (`dashboard/components/ActivityFeed.tsx`), montado na home do project abaixo do Topology. Polling 20 segundos.

O que diferencia da tabela de audit:

- **Timestamps relativos** — "2h ago" em vez de ISO completo
- **Burst grouping** — mesmo actor + mesma action + mesmo target type + dentro de 5 minutos colapsa em entrada expansível
- **Verb mapping narrativo** — `visualFor()` mapeia strings de ação pra `{verb, tone, icon}`
- **Esconde quando vazio** — project recém-criado não renderiza timeline vazia. Falhas de permissão (401/403) escondem em silêncio

O mesmo `AuditLogView` também renderiza activity de project em `/teams/<ref>/<project>/settings/audit` com `source.kind = "project"` — mesmo renderer, fonte diferente, permissão member-visible.

## Honestidade tier-1

- **Sem chain tamper-evident.** `audit_events` é append-only por insert, mas privilégios Postgres `UPDATE`/`DELETE` deixam o `postgres` reescrever histórico.
- **Sem alerta em tempo real.** Sem hook "me mande email quando deploy key for revogada". O dado tá lá se quiser ligar seu próprio log shipper.
- **Audit log é só admin na rota de team.** Um member que quer eventos project-scoped usa `/teams/<ref>/<project>/settings/audit` (member-visible).
