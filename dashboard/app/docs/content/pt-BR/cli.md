# Referência do Synapse CLI

Versão: `@iann29/synapse@1.9.2`. Requer Node >= 18.17. Use `synapse --help` pro catálogo automático e `synapse <cmd> --help` pro corpo de cada comando.

Todo comando escreve resultado estruturado em **stdout**, status/progresso em **stderr** e aceita `--json` em qualquer posição.

## Sessão

### `synapse login <url>`

Autentica numa instância Synapse e persiste sessão em `~/.synapse/config.json` (modo `0600`, dir pai `0700`).

URL precisa ser `http://` ou `https://`. Em TTYs, senha lida em modo raw com echo suprimido. Em não-TTY, lê `email\npassword\n` do stdin.

**Formato salvo:**

```json
{
  "baseUrl":      "https://synapse.example.com",
  "accessToken":  "...",
  "refreshToken": "...",
  "tokenType":    "Bearer",
  "user":         { "id": "...", "email": "...", "name": "..." }
}
```

**Refresh silencioso.** Qualquer `synapse <cmd>` posterior envolve o cliente em Proxy: um `401` dispara exatamente um `POST /v1/auth/refresh` e refaz a chamada.

**UTF-8 no Windows.** Antes do raw mode, CLI chama `ensureUtf8Console()`. Depois, checa `U+FFFD` e recusa com mensagem apontando `chcp 65001`.

```bash
synapse login https://synapse.acme.com
printf 'admin@example.com\nhunter2\n' | synapse login https://synapse.acme.com   # CI
```

### `synapse logout`

Apaga `~/.synapse/config.json`. Sem chamada ao backend.

### `synapse whoami`

Chama `GET /v1/me/`. Devolve email + URL da instância.

## Vínculo do projeto

### `synapse select`

Caminha `team → project → dev deployment → prod deployment` como state machine.

- Auto-seleciona quando só há uma opção
- `b`/`back`/`0` volta um nível
- 3 respostas inválidas abortam
- **dev obrigatório** — sem dev → throws
- **prod opcional** — null aceito, imprime warning com URL do dashboard

Escreve `.synapse/project.json` (só refs, pode commitar) + `.env.local` (`NEXT_PUBLIC_CONVEX_URL/SITE_URL` + `CONVEX_SELF_HOSTED_URL/ADMIN_KEY` + linha comentada `CONVEX_DEPLOYMENT=dev:<name>`).

`DEBUG_SYNAPSE=1` despeja listas cruas no stderr — diagnostica menus faltando entradas.

### `synapse credentials <deployment> [--format env|shell|json]`

Bate em `/v1/deployments/{name}/cli_credentials`. Default `env`.

| Flag | Efeito |
|---|---|
| `--format env` (default) | Cola em `.env.local` |
| `--format shell` | `export NAME=value` — `eval "$(synapse credentials … --format shell)"` |
| `--format json` | Resposta completa |

## Dia a dia

### `synapse dev [...convex-args]`

Açúcar pra `synapse convex --target dev dev [...args]`. Repassa args pro `npx convex dev`. `--once` é flag do Convex upstream.

### `synapse deploy [--yes] [...convex-args]`

Açúcar pra `synapse convex --target prod deploy [...args]` com confirmação.

| Flag | Comportamento |
|---|---|
| `--yes` / `-y` | Pula y/N. **Obrigatório em CI** |

Recusa não-TTY: `synapse deploy needs confirmation. Pass --yes...`. Sem prod: `No prod deployment saved for this project. Run synapse select again.`

### `synapse convex [--target dev|prod] [...args]`

Escape hatch — delega pra `npx convex <args>` com credenciais Synapse no env do filho. Target inferido do primeiro positional: `deploy` ⇒ `prod`, outros ⇒ `dev`.

Antes de spawnar: resolve nome do deployment, verifica session URL bate com project URL, busca credenciais frescas, deleta `CONVEX_DEPLOYMENT` do env, pré-anuncia warning benigno do `NEXT_PUBLIC_CONVEX_SITE_URL`.

```bash
synapse convex --help                      # help do Convex
synapse convex run messages:list           # query contra dev
synapse convex --target prod env list      # listar env vars prod
synapse convex import data.snapshot.gz     # restaurar em dev
```

## Visibilidade

### `synapse version [--json]`

Reporta `cli`, `backend`, `node`, `platform`. Probe do backend bate no endpoint **público** `GET /v1/install_status`.

### `synapse status [--project=<id>] [--json]`

Espelha página do project no dashboard. Colunas: **NAME** · **TYPE** · **STATUS** · **FORM** · **URL**.

Chip da coluna FORM:

| Chip | Render | Significado |
|---|---|---|
| `custom` | verde | Custom domain (acessível pelo browser) |
| `wildcard` | verde | Usa `SYNAPSE_BASE_DOMAIN` |
| `path` | dim | `/d/<name>/*` proxy. Browser OK; CLI quebra |
| `no-domain` | **vermelho** | host:port — não acessível pelo browser |

### `synapse doctor [--fix] [--yes] [--verbose] [--json]`

**19 checks** em 5 categorias: `local-env` (2) → `project` (7) → `backend` (3) → `deployments` (2) → `local-https-dev` (5).

Status: `ok`, `warn`, `issue`, `skipped`. Exit: `0` limpo, `1` só warnings, `2` issues.

`autoFix`: `never`, `auto` (com `--fix`), `prompt` (com `--fix --yes`). Categoria `local-https-dev` é pulada em silêncio sem script `dev:https` ou cert.

Tip footer: `<N> issue(s) are auto-fixable — run synapse doctor --fix.` ou variante combinada.

### `synapse open [target] [--json]`

Targets: (nenhum/`dashboard`) → `<baseUrl>/teams/<team-slug>/<project-id>`; `docs` → `https://docs.convex.dev`; `deployment <name>` → `<baseUrl>/embed/<name>`; `url` → `<baseUrl>`.

Pré-flight probe só pra `dashboard`. Cross-platform: `open` (macOS), `start` (Windows shell), `xdg-open` (Linux).

### `synapse list <teams|projects|deployments> [--project=<id>] [--team=<slug>] [--json]`

Despejo read-only. `list teams` sempre lista os times do operador. `list projects` precisa `--team=<slug|id>` ou time vinculado. `list deployments` precisa `--project=<id>` ou projeto vinculado.

## Deployments

### `synapse deployment create [--type=...] [--ha] [--default] [--project=<id>] [--yes] [--json]`

Provisiona container Convex real. **Backend gera o nome** (`<animal>-<adjective>-NNNN`) — sem positional aceito.

| Flag | Efeito |
|---|---|
| `--type=dev\|prod\|preview\|custom` | Default `dev` |
| `--ha` | 2 réplicas + Postgres + S3; requer `SYNAPSE_HA_ENABLED` |
| `--default` | Marca como default do project |
| `--project=<id>` | Project não-vinculado |
| `--yes` | Pula confirmação prod |
| `--json` | Machine-readable |

**Segurança prod.** Criar `prod` prompta `Create a NEW PROD deployment under <project>? [y/N]`. Em `--json` recusa sem `--yes`.

### `synapse deployment delete <name> [--yes] [--confirm=<name>] [--json]`

Chama `POST /v1/deployments/{name}/delete`. Container destruído, volume zerado, irreversível.

CLI busca o tipo primeiro:

| Tipo | Necessário |
|---|---|
| `prod` | Typed-confirm: operador digita o nome do deployment. `--confirm=<name>` é o equivalente não-TTY. **`--yes` NÃO bypassa.** |
| `dev`/`preview`/`custom` | y/N prompt ou `--yes` |

### `synapse deployment rotate-key <name> [--yes] [--confirm=<name>] [--write] [--json]`

Chama `POST /v1/deployments/{name}/reissue_admin_key`. Re-emite admin key do `INSTANCE_SECRET` atual. **NÃO rotaciona `INSTANCE_SECRET`** — deploy keys existentes continuam.

| Flag | Efeito |
|---|---|
| `--write` | Reescreve `.env.local` se este for o dev vinculado |

Adopted: `Cannot rotate key for "<name>" — it's an adopted (external) deployment.`

### `synapse deployment status <name> [--watch[=<seconds>]] [--json]`

Snapshot. `--watch` polling cada 2s até terminal (`running`/`failed`/`errored`/`deleted`/`stopped`). `--watch=<n>` sobrescreve intervalo. Incompatível com `--json`.

## Env vars

Todos os subcomandos `env` operam em **project-default** env vars. Mudança afeta deployments criados **depois**, a menos que sync rode.

### `synapse env list [--for=<dev|prod|preview>] [--project=<id>] [--mask] [--json]`

**Default mostra valores** — `--mask` censura. Colunas: `NAME`, `VALUE`, `DEPLOYMENT_TYPES`.

### `synapse env set NAME=value [NAME2=value2 ...] [--for=dev,prod] [--project=<id>] [--json]`

**Vários positionals = single transactional update.** Split no **primeiro `=`** (então `FOO=a=b` define FOO como `a=b`). Nomes casam `/^[A-Z_][A-Z0-9_]*$/`.

**Flag é `--for=`, NÃO `--types=`.**

### `synapse env unset NAME [NAME2 ...] [--project=<id>] [--json]`

Batch delete idempotente. Nome desconhecido = silencioso.

### `synapse env pull [--out=<path>] [--for=<type>] [--project=<id>] [--json]`

**`--out=<path>` é flag, NÃO positional.** Default = stdout. Write usa modo `0600`.

### `synapse env push [--from=<path>] [--for=<types>] [--project=<id>] [--dry-run] [--yes] [--json]`

**`--from=<path>` é flag, NÃO positional.** Default `.env`.

**SEM flag `--prune`.** `env push` só seta — nunca deleta. Use `env unset NAME`.

**Deny list** (recusado antes de qualquer chamada ao backend):

- `CONVEX_SELF_HOSTED_URL`
- `CONVEX_SELF_HOSTED_ADMIN_KEY`
- `CONVEX_DEPLOYMENT`
- `NEXT_PUBLIC_CONVEX_URL`
- `NEXT_PUBLIC_CONVEX_SITE_URL`

## Local HTTPS dev

Transforma `dev.myproject.com` em URL HTTPS dev real pro Next.js, via mkcert + hosts file + script `dev:https` no `package.json`.

### `synapse https setup <domain> [--force] [--yes] [--dry-run] [--skip-hosts] [--skip-script] [--verbose] [--json]`

Cinco fases: **SCAN → PLAN → PREVIEW → EXECUTE → VERIFY**. Toca mkcert (`-install` se preciso), `~/.config/dev-certs/<domain>/<domain>.pem` + key (modo `0600`), hosts file (sudo), `package.json` (script `dev:https`).

### `synapse https doctor <domain> [--json]`

Espelho read-only do SCAN+PLAN.

### `synapse https status [domain] [--json]`

Sem domain: lista certs em `~/.config/dev-certs/`. Com domain: diagnóstico profundo.

### `synapse https remove <domain> [--keep-certs] [--keep-script] [--keep-hosts] [--yes] [--json]`

Undo simétrico. Idempotente.

### `synapse https migrate [--cwd | --root=<path>] [--keep-old] [--dry-run] [--yes] [--json]`

Move pares legados `dev.*.pem` pra `~/.config/dev-certs/<domain>/`, reescreve `package.json`.

## Skills de agentes AI

### `synapse skills install [--force] [--force-links] [--all-harnesses] [--json]`

First-time + idempotente. Grava stamp em `.synapse/skills/.bundled` com sha256 por skill pra 3-way diff.

### `synapse skills update [--force] [--force-links] [--json]`

Mesmo código do install; verbo distinto pra intenção + header do render. Preserva customizações.

### `synapse skills list [--json]`

Classificação 4 estados: `ok` / `pristine` (seguro update) / `customised` (preservado em update) / `missing`.

### `synapse skills remove [--purge] [--json]`

`--purge` também deleta `.synapse/skills/`. Recusa tocar em não-symlinks.

### `synapse skills link [--force] [--all-harnesses] [--json]`

Re-cria symlinks de harness só. Sem SKILL.md writes. Comum após clone novo.

## Exit codes

| Code | Significado |
|---|---|
| `0` | Sucesso |
| `1` | Falha geral, só warnings |
| `2` | `synapse doctor` issues |

## Flags comuns

| Flag | Onde | Comportamento |
|---|---|---|
| `--json` | todo comando | Removida do argv; resultado em uma linha no stdout |
| `--help` / `-h` | todo comando | Help renderer per-command |
| `--yes` / `-y` | comandos com confirmação | Pula prompt. **Obrigatório em CI** |
| `--project=<id>` | comandos de recurso | Project não-vinculado |
| `--team=<slug\|id>` | `list projects` | Sobrescreve time vinculado |

## Localizações de arquivos de estado

| Path | Modo | Propósito |
|---|---|---|
| `~/.synapse/config.json` | `0600` (dir `0700`) | Bundle de sessão. Override com `SYNAPSE_CLI_CONFIG=<path>` |
| `.synapse/project.json` | `0600` | Só refs — pode commitar |
| `.env.local` | `0600` | NUNCA commite — tem admin key |
| `.synapse/skills/<name>/SKILL.md` | regular | Fonte de verdade da skill |
| `.synapse/skills/.bundled` | regular | `{ version, written_at, skills, hashes }` |
| `.claude/skills/synapse-*` | symlink | Symlink relativo → `.synapse/skills/synapse-*` (Windows: junction) |
| `.agents/skills/synapse-*` | symlink | Mesma forma |
| `~/.config/dev-certs/<domain>/<domain>.pem` | regular / `0600` | Par mkcert por domain |

**Env vars:**

| Var | Efeito |
|---|---|
| `SYNAPSE_CLI_CONFIG` | Sobrescreve path do config |
| `DEBUG_SYNAPSE=1` | `synapse select` despeja listas cruas no stderr |
| `CONVEX_DEPLOYMENT` | Se setada no shell, `select` avisa e `doctor` levanta warn |

## Comandos que NÃO existem

| Chute | Use no lugar |
|---|---|
| `synapse logs` | `docker logs synapse-<deployment-name>` ou `synapse open deployment <name>` |
| `synapse team` / `synapse teams` (verbos) | Dashboard em `<baseUrl>/teams`; `synapse list teams` só lê |
| `synapse project` (verbos) | Dashboard em `<baseUrl>/teams/<team>/<project>/settings`; `synapse list projects` só lê |
| `synapse domain` | Dashboard em `<baseUrl>/admin/host-domain` (wildcard) ou per-deployment (custom) |
| `synapse env get NAME` | `synapse env list --json | jq '.configs[] | select(.name=="X")'` |
| `synapse deployment list` | `synapse list deployments` ou `synapse status` |
| `synapse env push --prune` | Não existe. Use `synapse env unset NAME` |
| `synapse deployment create --name=...` / `--reference=...` | Backend gera o nome; sem flag override |
| `synapse cli upgrade` | `npm i -g @iann29/synapse` — atualize pelo seu package manager |

Pra qualquer outra coisa, cai no `synapse convex <subcommand>` (escape hatch) ou bata na API direto.
