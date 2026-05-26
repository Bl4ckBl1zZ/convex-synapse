# State & drift

Este é o coração do [Cell Control Plane](/docs/pt-BR/cell-control-plane): comparar o que você **quer** rodando com o que está **de fato** rodando, classificar a diferença, e produzir um **plano** — sem nunca aplicá-lo.

## Desejado vs. observado

| | De onde vem | O que diz |
|---|---|---|
| **Desired state** | Sincronizado das placements (`synapse desired sync`) | "Deployment X deveria estar `running` no host Y." Versionado; aposentado quando muda. |
| **Observed state** | Reportado pelo [agent](/docs/pt-BR/hosts-and-agents) | "Container Z existe no host Y, estado `running`, com estes labels `synapse.*`." |

Desejado e observado são correlacionados pelo label **`synapse.deployment_id`** (o UUID do deployment) no mesmo host — não pelo nome. Containers provisionados carregam `synapse.deployment_id` + `synapse.project_id`; containers antigos de antes desse esquema são casados por um fallback de nome (e marcados pra você atualizar o label). **Nenhum dos lados carrega segredo** — só campos seguros de identidade + estado.

## Status de drift

Recalcular o drift classifica cada par desejado/observado:

| Status | Significado | Ação recomendada |
|---|---|---|
| `in_sync` | Desejado e observado batem. | nenhuma |
| `missing` | Desejado quer rodando, mas nenhum container observado (num host **confiável**). | investigar / criar |
| `drifted` | Container existe mas o estado diverge (ex. desejado running, observado exited). | restart / investigar |
| `unmanaged` | Um container managed existe sem desired state correspondente. | investigar (nunca remove sozinho) |
| `orphaned` | Um desired state ativo aponta pra um deployment que foi deletado. | limpar o desired velho |
| `host_unreachable` | O host não pode ser confiado (offline / stale / docker down / scan incompleto). | investigar o host |
| `ignored` | Explicitamente ignorado. | — |

### O trust gate (sem "missing" falso)

O drift só declara algo `missing` quando o host é genuinamente **confiável**: online, com um scan de containers fresco e completo. Se o host está offline/stale, o docker está down, ou o scan foi incompleto, o recurso é reportado como `host_unreachable` — um agent stale nunca consegue fazer um deployment rodando parecer missing. (Liveness e confiança são separados; veja [Hosts & agents](/docs/pt-BR/hosts-and-agents).)

## O planejador dry-run

Pelo painel **State & Drift** ou pela CLI, o loop é:

```bash
synapse desired sync       --project <id>   # desired state a partir das placements
synapse drift recompute    --project <id>   # classifica a diferença (escreve um report)
synapse drift latest       --project <id>   # lê o report mais recente
synapse reconcile dry-run  --project <id>   # transforma o drift em passos *planejados*
```

Todo passo do plano é `planned`, `no_op` ou `skipped` — **nunca executado**. Cada um carrega `willApply=false`, e a operação como um todo carrega `applyAllowed=false`. O painel mostra isso como **DRY-RUN ONLY** com a nota "Nothing was applied to hosts."

> **Não existe apply.** O painel não tem botão Apply, a CLI não tem comando apply (`synapse reconcile dry-run --apply` dá erro "apply is not implemented"), e uma requisição que manda `apply:true` pro servidor é rejeitada com `400 apply_not_supported`. O reconcile diagnostica e recomenda; você age.

## Operation runs

Todo sync, recompute e dry-run é gravado como uma **operation run** (tipo `compute_drift`, `sync_desired_from_placements`, …) com o input, resultado e passos — visível no painel **Operations** (marcado **READ-ONLY**) ou via `synapse operations list`. Não existe tipo de operação que aplica mudanças; o histórico é uma trilha de diagnóstico, não um log de mudanças.

```bash
synapse operations list --project <id>
```

## Lendo o painel

- **Drift summary** conta cada status; um report limpo é `in_sync` com todo o resto em 0.
- **Drift items** mostram o veredito por-recurso + um `diff` redigido (segredos são removidos de todo JSON renderizado).
- As notas destacam os casos importantes: `host_unreachable` → "observation cannot be trusted"; um match por label legado → "recomenda atualizar o label do deployment"; um scan degradado → "container scan failed or incomplete".

É um snapshot, computado quando você recalcula — não um feed ao vivo. Com o agent rodando continuamente, o lado **observado** fica fresco; o **report de drift** ainda atualiza quando você (ou uma execução agendada) recalcula.
