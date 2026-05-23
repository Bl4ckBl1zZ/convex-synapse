# Environment variables

## Env vars padrão do projeto

O Synapse gerencia **environment variables padrão por projeto** — um conjunto de pares `KEY=value` no escopo de um projeto. Elas ficam na tabela Postgres `project_env_vars` (adicionada na migration `000001_init`) com uma linha por par `(project_id, name)`, e são a superfície principal pra "deixar esses segredos disponíveis pro Convex backend em runtime".

Schema resumido:

| Coluna             | Tipo          | Notas                                                                       |
|--------------------|---------------|-----------------------------------------------------------------------------|
| `project_id`       | UUID          | FK pra `projects(id)`. ON DELETE CASCADE.                                   |
| `name`             | TEXT          | O CLI valida `[A-Z_][A-Z0-9_]*` antes de mandar.                            |
| `value`            | TEXT          | Texto livre; não é criptografado em repouso em `project_env_vars`.          |
| `deployment_types` | TEXT[]        | Subconjunto de `{dev, prod, preview}` — veja abaixo. Default são os três.   |
| `updated_at`       | TIMESTAMPTZ   | Atualizado em cada set / overwrite.                                          |

`UNIQUE (project_id, name)` evita duplicatas — o mesmo nome no mesmo projeto significa que você quer sobrescrever.

## Como chegam no container

Env vars são **injetadas no container do deployment na hora de provisionar**. O worker do provisionador lê em `loadRuntimeEnvVars`:

```sql
SELECT name, value
  FROM project_env_vars
 WHERE project_id = $1
   AND $2 = ANY(deployment_types)
 ORDER BY name ASC
```

…onde `$2` é o tipo do novo deployment (ex.: `dev`). As linhas que casarem são mescladas com as env vars de sistema (`INSTANCE_NAME`, `INSTANCE_SECRET`, S3/Postgres pra HA, `CORS_ALLOWED_ORIGINS` pra custom domains, etc.) e passadas pro `docker run` como flags `-e`.

Consequência importante: **mudar uma env var depois NÃO mexe em deployments que já estão rodando**. Deployments novos pegam o valor atualizado automaticamente; os antigos continuam com o valor de quando foram criados até você empurrar a mudança via "Apply to existing deployments" (ver abaixo).

## Escopo por tipo de deployment

Cada env var tem um array `deployment_types`. O Synapse usa pra decidir qual subconjunto dos deployments do projeto recebe a var no momento do provisionamento:

| `deployment_types`         | Alcança                                          | Uso típico                                                        |
|----------------------------|--------------------------------------------------|-------------------------------------------------------------------|
| `{dev, prod, preview}`     | Todo deployment do projeto (default)             | Infra compartilhada (Sentry DSN, posthog key).                    |
| `{prod}`                   | Só deployments `prod`                            | Segredos só de produção (chaves reais de Stripe, e-mail API).     |
| `{dev}`                    | Só deployments `dev`                             | Endpoints de sandbox, credenciais falsas.                          |
| `{preview}`                | Só deployments `preview`                         | Tokens de CI por branch.                                          |
| `{dev, preview}`           | Dev + preview (tudo que não é `prod`)            | Fixtures de teste.                                                |

Deployments do tipo `custom` hoje não são selecionáveis pelo array `deployment_types` — eles recebem toda env var que tenha pelo menos um tipo setado. O painel de add no dashboard deixa você marcar qualquer combinação de `DEV / PROD / PREVIEW` (default são os três).

## Painel do dashboard

`dashboard/components/EnvVarsPanel.tsx` é a UI que o operador vê. Por ela dá pra:

- **Adicionar** uma var nova (nome, valor, em quais tipos de deployment aplica). Submetido como `op:"set"` no `update_default_environment_variables`.
- **Mostrar / esconder** o valor por linha. O default é mascarado (pontinhos, mesmo comprimento do valor limitado entre 8 e 24 caracteres) pra que alguém olhando por cima do ombro ou um screen-share não vaze segredo só porque a página do projeto está aberta. Clica em "Reveal" pra ver o texto.
- **Deletar** uma var (`op:"delete"`).
- **Aplicar nos deployments existentes** — recria os deployments rodando do projeto pra eles pegarem os valores atuais. Adotados, parados e os que não estão rodando são pulados e contados em `skipped`.

O painel mostra badges coloridos pra `deployment_types` que não são o default (cyan `DEV`, amber `PROD`, violet `PREVIEW`). Var que mira nos três tipos não renderiza badge — é o default e o caso visualmente mais limpo.

## Operações CRUD

A forma na API segue o spec do Convex Cloud:

### `GET /v1/projects/{id}/list_default_environment_variables`

Retorna `{ "configs": [{ "name", "value", "deploymentTypes" }] }` ordenado por nome. Permissão: qualquer membro do projeto.

### `POST /v1/projects/{id}/update_default_environment_variables`

Body: `{ "changes": [{ "op", "name", "value?", "deploymentTypes?" }] }`.

`op` é `"set"` ou `"delete"`. O lote inteiro roda em **uma transação Postgres** — ou aplica tudo, ou nada. `set` usa `INSERT ... ON CONFLICT DO UPDATE`, então chamar duas vezes seguidas é idempotente. `delete` é um `DELETE WHERE project_id AND name` — no-op silencioso se a linha não existir.

O endpoint valida que `name` não é vazio mas **não** revalida o formato `[A-Z_][A-Z0-9_]*` — esse é o trabalho do CLI antes da request sair. O form do dashboard é permissivo com case pela mesma razão.

Permissão: `canEditProject` (admin ou member do projeto). Viewer leva 403.

### `POST /v1/projects/{id}/sync_env_to_deployments`

Recria todos os deployments do projeto que estão rodando e são gerenciados pelo Synapse pra eles pegarem os valores atuais das env vars. Retorna `{ total, recreated, skipped, errors?, notice? }`.

| Estado do deployment                          | Resultado    | Por quê                                                          |
|-----------------------------------------------|--------------|------------------------------------------------------------------|
| Não-HA, status=running, com host port         | `recreated`  | Container faz hard-restart (~15 s de downtime cada).             |
| HA, status=running                            | `recreated`  | Uma réplica por vez é trocada; o deployment continua acessível.  |
| Adotado                                       | `skipped`    | O Synapse não controla o container.                              |
| `status != running`                           | `skipped`    | Vai pegar os valores novos no próximo provision.                |
| Single-replica sem `host_port`                | `skipped`    | Defensivo — linha pela metade.                                   |

A iteração é sequencial, não paralela, pra um recreate que travou não pendurar todos os deployments do projeto ao mesmo tempo.

## Mascarando valores no CLI

`synapse env list` mostra os valores **em claro por default**. Passa `--mask` pra cada valor virar `*` repetido pelo comprimento do valor:

```
synapse env list                     # texto puro (uso normal no terminal)
synapse env list --mask              # seguro pra screencast / pair programming
synapse env list --json --mask       # JSON com a mesma máscara
synapse env list --for=prod --mask   # só vars que miram PROD, mascaradas
```

A máscara preserva o comprimento de propósito: um blob de tamanho fixo vazaria o comprimento pra quem está olhando. Se quiser zero vazamento, redireciona pra arquivo com `umask 077` antes.

## Nomes proibidos (CLI `env push`)

`synapse env push` se recusa a empurrar nomes específicos que pertencem ao `.env.local` da máquina do operador, e NÃO à superfície project-default que é injetada em todo container. A deny list está em `cli/lib/commands/env-push.js`:

| Nome                              | Por que é proibido                                                              |
|-----------------------------------|---------------------------------------------------------------------------------|
| `CONVEX_SELF_HOSTED_URL`          | Config de cliente por deployment — gerenciado por `synapse select`, não pelo projeto. |
| `CONVEX_SELF_HOSTED_ADMIN_KEY`    | Segredo por deployment — nunca pode entrar no surface server-side do projeto.   |
| `CONVEX_DEPLOYMENT`               | Ponteiro por desenvolvedor pra qual deployment está ativo localmente.            |
| `NEXT_PUBLIC_CONVEX_URL`          | Config de frontend — gerenciado por `synapse select`.                            |
| `NEXT_PUBLIC_CONVEX_SITE_URL`     | Config de frontend — gerenciado por `synapse select`.                            |

O CLI mostra **todas** as violações num único erro pra você arrumar o arquivo de uma vez. A checagem roda **antes** de qualquer chamada ao backend, então um push proibido nunca modifica nada.

O dashboard não bloqueia esses nomes na UI. Empurrar pelo dashboard funciona mecanicamente mas vai contra a mesma intenção — não bota essas chaves nos defaults do projeto.

## Formato do arquivo `.env` (pull / push)

Tanto `synapse env pull` quanto `synapse env push` usam o formato dotenv padrão. Mesmo parser; valores fazem round-trip limpo.

O que `synapse env pull` emite:

```
# Synapse-managed project-default env vars
# Generated by `synapse env pull` — do not edit by hand;
# re-run the command after changes upstream.
API_KEY="abc123"
SENTRY_DSN="https://...@sentry.io/..."
STRIPE_SECRET_KEY="sk_live_..."
```

O quoting segue as mesmas regras do `.env.local` (aspas duplas pra qualquer valor com espaço, `=`, `#` ou caractere especial; backslash escapa aspas / quebras de linha embutidas). Com `--out=<path>` o arquivo é escrito com modo `0600`.

O que `synapse env push` aceita:

- Um `NAME=value` por linha.
- Valores entre aspas (simples ou duplas) são desaspados.
- Comentários (`#` na coluna 0 ou depois de espaço) e linhas em branco são ignorados.
- `export ` no começo é tolerado e removido.

Round-trip é garantido: `synapse env pull --out=.env && synapse env push --from=.env --dry-run` reporta zero mudanças.

### Flags do push

| Flag             | Efeito                                                                                            |
|------------------|---------------------------------------------------------------------------------------------------|
| `--from=<path>`  | Arquivo a ler (default `.env`).                                                                   |
| `--for=<types>`  | Subconjunto separado por vírgula de `dev,prod,preview` — carimba `deploymentTypes` em cada var.   |
| `--project=<id>` | Sobrescreve o projeto linkado.                                                                    |
| `--dry-run`      | Imprime o diff e sai; sem chamada ao backend. Recomendado no primeiro push.                       |
| `--yes`          | Pula o prompt de confirmação `y/N` (obrigatório quando usar com `--json` pra CI).                 |
| `--json`         | Saída legível pra máquina.                                                                        |

`synapse env push` é uma operação **só de set**: insere ou sobrescreve todo nome do arquivo, mas **nunca** remove vars que o projeto tem e o arquivo não tem. Pra deletar uma var, usa `synapse env unset <name>` ou o painel do dashboard diretamente.
