# Times e projetos

O modelo de permissão do Synapse tem duas camadas: **times** no topo, **projetos** dentro de times. Eventos de auditoria, convites, deployments e env vars vivem em algum lugar dessa hierarquia.

## Times

Um time é o agrupamento mais alto. Todo projeto pertence a exatamente um time; todo deployment pertence a um projeto e herda o time transitivamente. Associação ao time é o limite de segurança.

Os times de um usuário dirigem:

- a lista em `/teams` / `GET /v1/teams`
- o escopo do audit log — todo evento é registrado contra o time (`audit_events.team_id`)
- a superfície de PAT com escopo de time (`/v1/teams/{ref}/access_tokens`)
- as rotas de convite + associação abaixo

### Criando um time

Só pelo dashboard — `/teams` mostra um botão "Create team" que chama `POST /v1/teams/create_team` com `{ name }`. Slug auto-alocado via `slugify(name)` → candidato base → sufixos numéricos até 8, depois aleatórios (`acme-corp-a3f7`). A race do SELECT-EXISTS + INSERT é fechada por `db.WithRetryOnUniqueViolation(ctx, 10, ...)`.

### Regras de slug

`teams.slug` é `citext` e único globalmente. Slugs via `update_team` precisam casar `^[a-z0-9-]+$`. Conflitos viram `409 slug_taken`.

### Papéis de membros

`team_members.role` aceita dois valores:

- `admin` — convidar/remover membros, mudar papéis, criar e gerenciar tokens de time, transferir projetos, deletar o time
- `member` — criar projetos, criar deployments, editar env vars; não mexe na lista de membros

O OpenAPI do Cloud também usa `developer` — `normaliseRole` aceita como alias de `member`. Não tem `viewer` no nível de time (é papel só de projeto).

Rebaixar/remover o **último admin** é recusado com `409 last_admin`, protegido por `SELECT COUNT(*) FROM team_members WHERE team_id = $1 AND role = 'admin'` na mesma transação.

### Convidando membros

Só admin. `POST /v1/teams/{ref}/invite_team_member` com `{ email, role }`:

1. Gera token opaco estilo `syn_*` via `auth.GenerateToken`.
2. Insere linha em `team_invites` (UPSERT em `(team_id, email)` — re-convidar rotaciona o token).
3. Devolve `{ inviteId, email, role, inviteToken }`.

Convites pendentes: `GET /v1/teams/{ref}/invites` (só admin — token é privilegiado). Cancelamento: `POST /v1/teams/{ref}/invites/{inviteID}/cancel`.

### Aceitando um convite

O destinatário acessa `/accept-invite?token=<token>`. Não logado → vai pra `/login?returnTo=/accept-invite?token=...`.

O dashboard chama `POST /v1/team_invites/accept { token }`. Fluxo numa transação:

1. `SELECT ... FOR UPDATE` na linha do convite onde `accepted_at IS NULL` — inválido/consumido → `404 invite_not_found`.
2. `INSERT INTO team_members ... ON CONFLICT (team_id, user_id) DO NOTHING` — re-aceitar de outra sessão é no-op.
3. `UPDATE team_invites SET accepted_at = now()` — consome o convite.

**Uso único** — `accepted_at IS NULL` no SELECT garante que a próxima chamada falha com `404`.

## Projetos

Um projeto vive dentro de um time. É dono dos deployments (dev, prod, preview) e das env vars padrão semeadas em novos deployments na criação.

### Criando um projeto

`POST /v1/teams/{ref}/create_project { projectName }`. Alocação de slug espelha a de times mas unicidade é **por time** — `UNIQUE(team_id, slug)`. Mesmo slug `blog` pode existir em dois times.

### O time `Default` e o projeto `demo`

Instalações novas terminam em estado de zero usuários — `phase_verify` trunca `users` depois do self-test. O primeiro operador se registra pelo wizard em `/setup`:

1. Loading
2. Admin (cria primeiro usuário via `/v1/auth/register` — vira instance admin)
3. Demo (cria time `Default` + projeto `demo` — ambos pelas rotas normais)
4. Provisioning (dispara deployment dev pro operador cair numa página populada)

`Default` e `demo` não têm nada de especial. O wizard existe pra poupar o primeiro operador de encarar dashboard vazio.

### RBAC project-level (v1.0+)

Por padrão, um projeto herda o papel que membros têm no time. O overlay RBAC v1.0 deixa admin de projeto **sobrescrever** isso por usuário: um membro do time pode ser rebaixado a viewer de projeto, ou um membro do time pode ser elevado a admin de projeto sem mexer no papel do time.

A camada de override é `project_members` (migration `000008_project_members`). Quando existe linha pra `(project_id, user_id)`, ela ganha; ausência cai pro `team_members.role`. Resolução em `effectiveProjectRole`:

```go
func effectiveProjectRole(ctx, db, projectID, teamID, userID) (string, error) {
    // 1. override em project_members (se houver)
    // 2. fallback em team_members
}
```

`loadProjectForRequest` e `loadDeploymentForRequest` passam pelo helper.

Os três papéis de projeto:

- `admin` — controle total: renomear, slug, transferir, deletar, gerenciar membros + tokens
- `member` — criar deployments, editar env vars, rodar `sync_env_to_deployments`
- `viewer` — acesso só-leitura

Gates: `canAdminProject(role)` e `canEditProject(role)`.

### Rotas de membership do projeto

Todas em `/v1/projects/{id}/`:

- `GET /list_members` — lista mesclada, com campo `source: "project"|"team"`
- `POST /add_member { userId, role }` — UPSERT do override. Só admin de projeto. **O alvo precisa já ser membro do time do projeto.**
- `POST /update_member_role { memberId, role }` — UPSERT
- `POST /remove_member { memberId }` — deleta só o override. Depois, o usuário cai pro papel de time. Auto-remoção permitida. `404 no_override` se nunca teve override

### Transferência de projeto

`POST /v1/projects/{id}/transfer { destinationTeamId }`. Caller precisa ser **admin tanto da origem quanto do destino**.

- Destino fora de alcance → `403 forbidden`
- Mesmo time → `204 No Content` no-op
- Slug ocupado no destino → `409 slug_taken`

A transferência é um único `UPDATE projects SET team_id = $1`. Deployments, env vars e audit pendem de `project_id`, não `team_id` — sem escrita extra. Tokens project-escopados continuam funcionando. Audit em **ambos** os times com `direction: "out"`/`"in"`.

### Deleção de projeto

`POST /v1/projects/{id}/delete` — só admin, **irreversível**. Numa transação:

1. `UPDATE deployments SET status = 'deleted' WHERE project_id = $1` — health worker para de tentar reconciliar
2. `DELETE FROM projects WHERE id = $1` — CASCADE remove env vars, project members, deploy keys, deployments

O provisioner derruba containers async. Depois que a linha some, dados, env vars, backends dev/prod/preview e tokens project-escopados somem junto.
