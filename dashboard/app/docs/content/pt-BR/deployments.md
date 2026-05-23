# Deployments

## O que é um deployment

Um deployment no Synapse é **um Convex backend rodando** que o Synapse provisionou (ou adotou) pra você. Do ponto de vista do operador, um deployment é uma trinca:

- um **nome** globalmente único (ex.: `quiet-cat-1234`),
- uma **URL** única que os clientes usam,
- uma **admin key** única que autentica escritas nessa URL.

Por baixo dos panos, um deployment não-HA é um container Docker (`convex-<name>`) mais um volume de dados (`synapse-data-<name>`). Um deployment HA são dois containers (`convex-<name>-0`, `convex-<name>-1`) compartilhando um banco Postgres dedicado e um prefixo de bucket S3 em vez do SQLite local. De qualquer jeito, o dashboard, o CLI e o código da sua aplicação só conversam com o deployment pelo nome e pela URL.

## Tipos de deployment

Na hora de criar, você escolhe um tipo. O tipo é metadado: ele decide quais env vars padrão do projeto vão pro container, é usado nas buscas por `is_default` e é o valor que as ferramentas do `convex` mostram no status.

| Tipo      | Caso de uso                                                      | Semântica do `is_default`                                       |
|-----------|------------------------------------------------------------------|-----------------------------------------------------------------|
| `dev`     | Instância de máquina de dev, baixo risco, fácil de zerar         | No máximo um `dev` por projeto vira default                     |
| `prod`    | Produção, o deployment que o cliente final acessa                | No máximo um `prod` por projeto vira default                    |
| `preview` | Instância efêmera por branch pra previews de CI / PR             | Vários previews coexistem; o default é só informacional         |
| `custom`  | Qualquer coisa fora do padrão (staging, teste de carga)          | Default é só informacional                                      |

Tipos inválidos são rejeitados com HTTP 400 `invalid_type` antes do provisionamento começar.

## Geração de nome

O Synapse gera o nome do deployment automaticamente no formato `<adjetivo>-<animal>-<NNNN>` (ex.: `bright-otter-4710`, `snappy-axolotl-2031`). Sufixo de 4 dígitos, ASCII minúsculo, com hífens — seguro pra usar como nome de container Docker, slug de URL e como `INSTANCE_NAME` que o backend Convex lê no boot.

- Adjetivos: 34 palavras curtas e amigáveis (`quiet`, `bright`, `lush`, …).
- Animais: 36 bichos (`cat`, `otter`, `axolotl`, `capybara`, …).
- Sufixo: número aleatório de 4 dígitos no intervalo `1000-9999`.

O espaço total é folgado pra quantidade de deployments que uma instância de Synapse sozinha aguenta. Colisões são pegas pela constraint `UNIQUE` na coluna `deployments.name` e o handler tenta de novo até 25 vezes antes de retornar `500`.

Não dá pra renomear um deployment depois que ele existe. Se você adotar um backend externo pode escolher o nome; senão, o nome auto-gerado é o que vale.

## Ciclo de vida

```
            ┌──────────────┐    Docker provisiona o container
provision → │ provisioning │ ── + healthcheck passa ─────────► running
            └──────────────┘                                     │
                  │                                              │
                  │ Docker / healthcheck falha                   ▼
                  ▼                                       ┌───────────┐
              ┌────────┐                                  │  stopped  │
              │ failed │                                  └─────┬─────┘
              └────────┘                                        │
                                                                ▼
                                                          ┌──────────┐
                                                          │ deleted  │  (terminal)
                                                          └──────────┘
```

Os valores de status vêm de `models.Deployment.Status` e ficam persistidos na linha `deployments`:

| Status         | Significado                                                                                                                                                          |
|----------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `provisioning` | A linha foi inserida; um job `provision` está em `provisioning_jobs` esperando worker. O container ainda não existe.                                                 |
| `running`      | Container está de pé e o healthcheck por admin-key respondeu 2xx. O deployment está servindo tráfego.                                                                |
| `stopped`      | O container existe mas não está rodando. Acontece por `docker stop` manual ou por uma tentativa de restart que falhou.                                              |
| `failed`       | O job de provisão rodou e o Docker (ou o healthcheck) retornou erro. A linha é mantida pra você ver o motivo; nenhum container está rodando.                        |
| `deleted`      | Terminal. Container + volume foram removidos. A linha é mantida pro histórico de auditoria mas some de todos os endpoints de listagem.                              |

O worker do provisionador reconcilia `deployment_replicas.status` com o estado real do container e propaga o pior estado entre as réplicas pra linha do deployment.

## Tempo de provisionamento

Pra um deployment não-HA gerenciado pelo Synapse, o caminho quente (imagem já em cache, sem fiação de Postgres+S3) leva por volta de um segundo entre `POST /create_deployment` e `status=running`. Caminhos frios (primeiro deployment de todos — a imagem `ghcr.io/get-convex/convex-backend` está sendo baixada) podem demorar um ou dois minutos numa conexão lenta; o timeout do job de provisão é **5 minutos**, depois disso uma chamada do Docker que travou vira `failed` e a linha se recupera.

Deployments HA demoram mais porque duas réplicas são provisionadas em paralelo contra Postgres + S3 e cada uma precisa passar no mesmo healthcheck.

## Modelo HA

HA é opt-in por deployment e só fica disponível quando `SYNAPSE_HA_ENABLED=true` está setado na sua instância de Synapse. O modelo é **réplicas ativo-passivo por deployment**, não sharding ativo-ativo:

- Sobem `replica_count = 2` containers, indexados como `0` e `1`.
- Os dois apontam pro **mesmo** banco Postgres dedicado (`convex_<name>`) e pro **mesmo** prefixo de bucket S3 dedicado (`<prefix>-<name>-{files,modules,search,exports,snapshots}`). As credenciais de storage são criptografadas em repouso com `SYNAPSE_STORAGE_KEY` e ficam na tabela `deployment_storage`.
- Só uma réplica segura o lease de writer único do Convex em qualquer momento. A outra é hot-standby pronta pra assumir.
- O proxy retorna uma lista de endereços multi-réplica e faz failover em erro de conexão.

Você pode subir um deployment single-replica existente pra HA in-place com `POST /v1/deployments/{name}/upgrade_to_ha`. O worker mantém o container antigo servindo enquanto provisiona as duas réplicas HA, exporta um snapshot do container velho, importa no par novo e troca as linhas do banco atomicamente. Deployments adotados não podem ser upgradeados — converte do lado da origem e readota.

## A flag `--default`

Quando você cria um deployment com `--default` (ou `isDefault: true` na API), o boolean `is_default` da linha é setado. A flag avisa o dashboard e o CLI qual deployment escolher quando você não nomeia um explicitamente:

- `GET /v1/projects/{id}/deployment?defaultProd=true` retorna o deployment `prod` com `is_default=true`.
- `GET /v1/projects/{id}/deployment?defaultDev=true` retorna o `dev`.
- O botão "abrir default" no card do projeto no dashboard usa a mesma query.

O padrão comum é marcar um `dev` e um `prod` como default por projeto. Nada te impede de marcar vários — o resolvedor só pega o mais recente. A flag não afeta o provisionamento, só as buscas.

## Adopt — adotar deployment existente

Se você já roda um Convex backend fora do Synapse (em outro stack Docker, no Fly, em bare metal), pode registrar ele no catálogo do Synapse via `POST /v1/projects/{id}/adopt_deployment`. Você passa:

| Campo            | Obrigatório | Notas                                                                                |
|------------------|-------------|--------------------------------------------------------------------------------------|
| `deploymentUrl`  | sim         | `http://...` ou `https://...`. Barra no fim é removida.                              |
| `adminKey`       | sim         | A admin key que o backend rodando já confia.                                          |
| `deploymentType` | não         | Um de `dev`/`prod`/`preview`/`custom` (padrão `dev`).                                |
| `name`           | não         | Se omitir, o Synapse gera. Se passar, precisa ser globalmente único.                 |
| `isDefault`      | não         | Mesma semântica do create.                                                            |
| `reference`      | não         | Label livre (ex.: branch git, ID de preview da Vercel).                              |

Antes de gravar a linha, o Synapse sonda a URL com `GET /version` (alcance) e `GET /api/check_admin_key` (auth). Qualquer um dos dois falhando vira `400 invalid_url`, `400 invalid_admin_key` ou `502 probe_failed`. Em caso de sucesso, a linha é inserida com `adopted=true`, `status=running` e `instance_secret=''`.

Deployments adotados são **read-only do ponto de vista do ciclo de vida do Synapse**: o delete só desregistra a linha (o container de verdade continua rodando até você parar), e `upgrade_to_ha` / `reissue_admin_key` são recusados com `cannot_*_adopted`. O Synapse não toca no container, nem no volume, nem nas credenciais.

## Reemitir a admin key

`POST /v1/deployments/{name}/reissue_admin_key` regera a admin key guardada do deployment a partir do `instance_secret` atual. Use isso quando a key guardada saiu de sincronia com o container rodando — sintoma: o Convex Dashboard embutido mostra "deployment URL or admin key is invalid" mesmo o deployment estando de pé.

| Propriedade               | Comportamento                                                                                                       |
|---------------------------|---------------------------------------------------------------------------------------------------------------------|
| Rotaciona `instance_secret` | **Não.** O segredo não é mexido.                                                                                  |
| Invalida deploy keys      | **Não.** Toda deploy key existente continua funcionando porque foram assinadas pelo mesmo `INSTANCE_SECRET`.        |
| Recria o container        | **Não.** O backend aceita qualquer key assinada pelo segredo atual.                                                  |
| Recusado para             | Deployments adotados, deployments com `instance_secret` vazio.                                                       |
| Permissão                 | Admin de projeto.                                                                                                   |

Revogar uma **deploy key** é diferente — esse caminho rotaciona o `INSTANCE_SECRET`, recria o container e invalida todas as deploy keys ativas do deployment. Veja a doc de deploy keys pra esse fluxo.

## Deleção

`POST /v1/deployments/{name}/delete` é **irreversível**:

1. Pra deployments gerenciados pelo Synapse: o Docker para + remove o container; o volume de dados (`synapse-data-<name>` ou os equivalentes por réplica) também é removido. Dados do SQLite somem. Os buckets Postgres + S3 do HA também são dropados.
2. Pra deployments adotados: a linha é só marcada `deleted`. O Synapse nunca tocou no container; ele continua rodando.
3. Em qualquer caso a linha `deployments` vai pra `status=deleted` e some de todos os endpoints de listagem. A linha em si fica pro audit log poder referenciar.
4. Se a linha ainda estava `provisioning` na hora do delete, o Synapse marca como `deleted` sem chamar o Docker; o worker de provisão em andamento percebe a mudança de status quando o `Provision` retorna e desmonta o que tinha construído.

Permissão: admin de projeto.

## Formas de URL

A URL que o Synapse retorna pros clientes depende de como sua instalação está configurada. A matriz de decisão (primeira que casar ganha) está em `publicDeploymentURL`:

| Configuração                                  | URL retornada                           | Quando se aplica                                                                |
|-----------------------------------------------|-----------------------------------------|---------------------------------------------------------------------------------|
| Deployment adotado                            | A URL que você passou no adopt          | Sempre ganha pra linhas adotadas                                                |
| Custom domain ativo com role `api`            | `https://<custom_domain>`               | Você registrou um custom domain via `POST /v1/deployments/{name}/domains`       |
| `SYNAPSE_BASE_DOMAIN=<host>` setado           | `https://<name>.<host>`                 | Modo subdomínio wildcard (precisa de DNS `*.<host>` + on-demand TLS no Caddy)  |
| `SYNAPSE_PUBLIC_URL` + proxy habilitado       | `<PublicURL>/d/<name>`                  | Modo path-proxy (funciona sem DNS wildcard, é o default do `setup.sh`)         |
| `SYNAPSE_PUBLIC_URL` setado, proxy desabilitado | `<PublicURL_host>:<HostPort>`         | Exposição direta de porta (firewall precisa liberar a porta dinâmica)          |
| Nada setado                                   | `http://127.0.0.1:<HostPort>` (legado)  | Dev local, sem config de URL pública. O dashboard mostra um chip vermelho "no-domain" |

O CLI recebe uma forma um pouco diferente (`cliDeploymentURL`) que nunca usa a forma de path-proxy `/d/<name>`: o CLI `npx convex` monta requisições com `new URL("/api/...", baseUrl)`, que é ancorado no host e dropa o prefixo de path. Custom domain e modo `BaseDomain` funcionam transparentemente pros dois — navegador e CLI.
