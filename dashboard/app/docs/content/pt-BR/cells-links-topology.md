# Cells, links & topologia

Uma **cell** é uma unidade operacional de um projeto que agrupa deployments. As cells, as **placements** que colocam deployments nelas, os **cell links** que ligam contratos entre elas, e a view de **topologia** que desenha tudo isso são a camada de organização do [Cell Control Plane](/docs/pt-BR/cell-control-plane).

## Cells

Uma cell tem um **kind** que descreve o papel dela:

| Kind | Uso típico |
|---|---|
| `core` | A cell primária de um projeto (ex. `core-prod-…`, `core-dev-…`). |
| `runtime` | Uma cell de runtime/workload. |
| `integration` | Serviços voltados a integração. |
| `preview` | Ambientes efêmeros / de preview. |
| `enterprise-app` | Uma cell dedicada ao app de um cliente enterprise. |

Quando você habilita cells, o Synapse roda um **backfill idempotente** que cria uma cell `core` pra cada deployment existente, então um upgrade não deixa sua frota sem categoria. A partir daí você cria e arruma as cells você mesmo.

```bash
synapse cells list --project <project-id>
synapse cells create --project <project-id> --name core-prod-br-1 --kind core
```

### Placements: colocar um deployment numa cell

Uma **placement** registra que um deployment roda numa cell, num host, com um status desejado. Anexar um deployment a uma cell cria a placement:

```bash
synapse cells attach-deployment --cell <cell-id> --deployment <name>
synapse cells attach-host       --cell <cell-id> --host <host-id-ou-name>
```

`drain` marca uma cell como draining (intenção do operador) — é um sinal, não uma ação; nada é movido ou parado.

### Deletar um deployment limpa a cell dele

Quando você deleta um deployment, o Synapse limpa o rastro dele no Cell Control Plane — o desired state é aposentado, a placement e o vínculo cell-resource são removidos, e o ponteiro de primary-deployment da cell é limpo — então o deployment deletado para de aparecer sob a cell. A **cell em si é mantida** (uma cell vazia é inofensiva e pode ser reusada). Pra remover uma cell vazia, faça drain / remova explicitamente.

## Cell links & service tokens

Um **cell link** é um **contrato** entre duas cells do mesmo projeto: registra que a cell *source* pode falar com a cell *target* por um protocolo, com uma allow-list de comandos/eventos. É metadado — **não transporta payload nenhum**.

```bash
synapse cell-links create --project <id> --source <cell> --target <cell> --protocol <p>
synapse cell-links list   --project <id>
```

Restrições que mantêm os links honestos:

- **Só intra-projeto** — não dá pra linkar cells entre projetos, e uma cell não pode linkar consigo mesma.
- **Um link ativo** por `(source, target, protocolo)`.
- O link consegue resolver um **endpoint** a partir do roteamento existente (um domínio custom `api` ativo → a URL do deployment → `null` se nenhum). Nenhum roteamento novo é criado.

### Service tokens

Um link cujo `authMode` é `service_token` pode gerar **service tokens** (prefixo `syn_svc_`) — credenciais que um serviço apresenta pra **descobrir** o próprio link:

- Scope padrão `discovery:read`; discovery exige ele.
- O token em texto puro é mostrado **uma vez** na criação; só um hash é guardado. Revogue a qualquer momento.
- O endpoint público de discovery retorna **só o link do próprio token** (não os links irmãos), e rejeita tokens revogados ou expirados.

Links com `authMode` `mtls` ou `none` não geram tokens.

## Topologia

A view de **topologia** monta o mapa ao vivo de um projeto — Host → Cell → Deployment — a partir de placements, rotas e status de host reais:

```bash
synapse topology show --project <project-id>
```

Ela retorna hosts (com liveness), cells (com seus deployments + URLs resolvidas), arestas de link, cells sem placement, deployments não-atribuídos, e uma lista de **avisos read-only** — ex.:

- uma cell sem primary deployment,
- um deployment não atribuído a nenhuma cell,
- um host offline/stale que ainda tem cells ativas,
- um link sem endpoint resolvível ou sem token.

Avisos são diagnósticos: dizem o que olhar, nunca mudam nada. Quando ainda não existem cells, a topologia faz fallback pra uma view sintética de host único, pra página ainda renderizar.
