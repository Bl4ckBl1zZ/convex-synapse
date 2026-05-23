# Arquitetura

Synapse e um **control plane**, nao um runtime. Ele roda em um host unico (uma VPS, um Docker daemon) e orquestra N containers de **data plane** — cada um e um Convex backend open-source de verdade. Dashboard, CLI e apps Convex falam com o Synapse do mesmo jeito que falariam com o Big Brain do Convex Cloud, so que cada byte de dado e cada centavo de compute fica em hardware que voce controla.

## A separacao control plane / data plane

```
                                  ┌──────────────────────────────────┐
   Browser do operador ────────▶  │           Host Synapse           │
   `npx convex deploy` ────────▶  │                                  │
                                  │  ┌────────────┐  ┌────────────┐  │
                                  │  │  Caddy     │  │ Dashboard  │  │
                                  │  │ (opcional) │  │ (Next.js)  │  │
                                  │  └─────┬──────┘  └─────┬──────┘  │
                                  │        ▼               ▼         │
                                  │  ┌──────────────────────────┐    │
                                  │  │   synapse-api (Go)       │◀──┐│
                                  │  │   chi router + pgx       │   ││
                                  │  └──────┬───────────────────┘   ││
                                  │         │ docker.sock           ││
                                  │         ▼                       ││
                                  │  ┌────────────────────────┐     ││
                                  │  │ Postgres (synapse-db)  │◀────┘│
                                  │  │ so metadata            │      │
                                  │  └────────────────────────┘      │
                                  │                                  │
                                  │  ┌─── synapse-network ────────┐  │
                                  │  │  convex-<nome-a>           │  │ ← data plane
                                  │  │  convex-<nome-b>           │  │   (provisionado
                                  │  │  convex-<nome-c>           │  │    sob demanda)
                                  │  └────────────────────────────┘  │
                                  └──────────────────────────────────┘
```

Duas propriedades importantes saem disso:

- **Uma VPS = N deployments.** Um unico install do Synapse hospeda quantos Convex backends a RAM e o disco do host aguentarem. Cada deployment e um container irmao na bridge `synapse-network`.
- **Synapse nunca toca nos seus dados.** Ele e dono dos metadados (times, projetos, env vars, quem pode fazer o que) e orquestra o Docker. Os paineis de dados/funcoes/logs do dashboard falam direto com o deployment, assinados por uma admin key que o Synapse so guarda.

## O que sobe

Cada instalacao sobe isso via `docker compose up -d --build`:

| Container | Imagem | Porta (host) | Papel |
|---|---|---|---|
| `synapse-postgres` | `postgres:16-alpine` | 5432 | DB de metadados do control plane |
| `synapse-api` | `synapse:local` (build de `synapse/`) | 8080 | Servidor HTTP Go: API + reverse proxy |
| `synapse-dashboard` | `synapse-dashboard:local` (build de `dashboard/`) | 6790 | Dashboard Next.js |
| `synapse-convex-dashboard` | `ghcr.io/get-convex/convex-dashboard@sha256:…` | — | UI upstream do Convex (data/funcoes/logs) |
| `synapse-convex-dashboard-proxy` | `caddy:2-alpine` | — | Tira headers anti-iframe da UI upstream |
| `synapse-caddy` | `caddy:2-alpine` | 80, 443, 6791 | Termina TLS (so com o profile `caddy` ativo) |
| `synapse-backend-pg`, `synapse-minio` | postgres + minio | 5433, 9000, 9001 | Backing store pra deployments HA (so com `--profile ha`) |

Mais, pra cada deployment provisionado, um ou mais containers do Convex backend:

| Container | Imagem | Rede |
|---|---|---|
| `convex-<nome>` (single-replica) ou `convex-<nome>-<index>` (HA) | `ghcr.io/get-convex/convex-backend@sha256:…` (fixada) | `synapse-network` |

Todo container gerenciado pelo Synapse carrega a label Docker `synapse.managed=true`. Esse e o jeito canonico de encontra-los:

```bash
docker ps --filter label=synapse.managed=true
```

## Como uma request chega num deployment

O `synapse-api` monta um reverse proxy (`synapse/internal/proxy/proxy.go`) que suporta tres modos de routing simultaneos:

1. **Por path** — `/d/<nome>/<resto>` sempre roteia pro deployment chamado `<nome>`. Esse e o contrato da v0.2 e funciona em toda instalacao com `SYNAPSE_PROXY_ENABLED=true`.
2. **Wildcard via Host header** — quando `SYNAPSE_BASE_DOMAIN` esta setado (via `--base-domain=<host>`), uma request com `Host` no formato `<sub>.<base>` roteia pro deployment chamado `<sub>`. A `matchHostSubdomain` faz match case-insensitive de sufixo e tira o sufixo.
3. **Dominio custom** — quando nenhuma das duas anteriores casa, o proxy busca o `Host` em `deployment_domains`. Rows ativas amarram um hostname a um deployment + role (`api` → backend, `dashboard` → o sidecar da UI do Convex).

O Caddy termina TLS e encaminha pro `synapse-api`. O caminho de uma request tipica:

```
Browser ──▶ https://bold-fox.synapse.example.com/api/query
        ──▶ Caddy (TLS, cert sob demanda via /v1/internal/tls_ask)
        ──▶ synapse-api: bate no wildcard, busca "bold-fox"
        ──▶ resolver: le deployment_replicas, escolhe endereco
        ──▶ httputil.ReverseProxy ──▶ convex-bold-fox:3210
```

O resolver cacheia nome → lista de replicas por 30 segundos, com `Invalidate(name)` chamado depois de escritas pra que deletes propaguem na hora dentro do nodo.

## Onde mora o estado

| Tipo de estado | Onde mora | Backed por |
|---|---|---|
| Users, times, projetos, env vars, metadata de deployment, audit, jobs de provisionamento | `synapse-postgres` | Volume `synapse-pgdata` |
| Dados SQLite por deployment (modo default) | Volume Docker do proprio deployment | `synapse-data-<nome>` (single-replica) ou `synapse-data-<nome>-<index>` (HA) |
| Dados de deployment HA (modo Postgres + S3) | Um database por deployment no Postgres configurado + buckets no S3 configurado | `backend-postgres` + `minio` quando voce usa o profile `ha` embarcado |
| Certificados e config do Caddy | Volumes do proprio Caddy | `synapse-caddy-data`, `synapse-caddy-config` |
| Segredos criptografados (URL de backend HA, chaves S3, tokens Cloudflare) | Rows em `deployment_storage`, AES-256-GCM | Envelope key `SYNAPSE_STORAGE_KEY` (v0.5+) |

Data plane e control plane tem ciclos de vida separados. `docker compose down -v` limpa o DB de metadados mas deixa os volumes por deployment intactos — operadores precisam de `docker volume rm synapse-data-*` pra realmente apagar dados de deployment.

## Seguranca multi-nodo dentro de um nodo

Synapse foi feito pra que multiplos processos contra o mesmo Postgres + Docker daemon nao pisem um no outro. Mesmo installs de um nodo so pagam a taxa (barata) pro mesmo caminho de codigo funcionar sob HA mais pra frente.

- **Race de alocacao de recurso** (porta, nome de deployment, slug) embrulha SELECT-then-INSERT em `db.WithRetryOnUniqueViolation`. A constraint UNIQUE pega a race; o helper retenta com um candidato novo.
- **Sweeps periodicos** (health worker, sweep de orfaos, DNS verifier) embrulham cada tick em `db.WithTryAdvisoryLock(ctx, pool, key, fn)`. Single-node sempre adquire; multi-node coordena pra que exatamente um nodo rode o trabalho por tick. As chaves de lock ficam em `synapse/internal/db/advisorylock.go` como constantes — nunca reaproveitadas pra trabalho distinto.
- **Trabalho async longo** (provisionamento de deployment, upgrade pra HA) entra como rows em `provisioning_jobs`. O `provisioner.Worker` roda N goroutines paralelas puxando via `SELECT FOR UPDATE SKIP LOCKED`, entao handlers retornam 201 na hora e qualquer nodo pode pegar o trabalho — inclusive depois de um crash.

O principio e consistente: nada de `go algoAsync()` direto de um handler.

## O modelo HA

HA no Synapse e **active-passive, por deployment** — nao active-active. A limitacao vem do proprio Convex backend (`crates/postgres/src/lib.rs` no repo upstream): cada Postgres backing segura um lease de single-writer, entao so uma replica pode ser o writer ativo de cada vez.

O que isso te da na pratica:

- Um deployment com HA habilitado roda **duas replicas de backend** no mesmo host Synapse. As duas compartilham um database Postgres e um bucket S3 (credenciais criptografadas moram em `deployment_storage`, seladas pelo envelope `SYNAPSE_STORAGE_KEY`).
- Um `HealthProbe` em `proxy/proxy.go` bate em `/api/check_admin_key` em cada replica de tempos em tempos e atualiza `last_seen_active_at` em sucesso.
- O proxy resolve replicas em ordem de preferencia (mais-recentemente-saudavel primeiro, desempate por `replica_index`). Deployments single-replica vao por um fast path; deployments HA bufferam o body em memoria (cap de 1 MB) e **retentam transparente contra a proxima replica** em erros de conexao.
- Failover e papel do proxy, nao do backend. O lease da replica morta acaba expirando; a sobrevivente vira a writer; clientes so veem 502 quando toda replica esta inalcancavel.

Active-active entre replicas nao e possivel sem mudancas no design de lease do backend upstream.

## "Gerenciado pelo Synapse"

A definicao canonica e: um container ou volume Docker criado pelo provisioner do Synapse (`synapse/internal/docker/`). Containers provisionados sempre:

- Ficam na bridge `synapse-network`.
- Carregam a label `synapse.managed=true` (setada em `client.go` e `provisioner.go`).
- Usam o esquema de nomes `convex-<nome-deployment>` (replica unica) ou `convex-<nome-deployment>-<index>` (HA).
- Tem dados em `synapse-data-<nome-deployment>` (unica) ou `synapse-data-<nome-deployment>-<index>` (HA).

Essa label e o que o `--uninstall`, o `--backup` e os snippets de limpeza do Quickstart filtram. Todo o resto na maquina (seus apps, seus outros containers, o proprio Caddy, ate o Postgres que segura os metadados) **nao** e considerado gerenciado pelo Synapse e nunca e tocado pelos comandos de lifecycle.
