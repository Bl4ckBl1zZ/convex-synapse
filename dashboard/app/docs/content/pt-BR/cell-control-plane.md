# Cell Control Plane

O Cell Control Plane transforma o Synapse de um painel por-deployment num mapa da sua frota inteira: em quais **máquinas** você roda, como os deployments são **agrupados**, o que você **quer** rodando, o que está **de fato** rodando, e onde os dois **divergem** (drift).

A regra de ouro é **observar → comparar → planejar, nunca aplicar**. O Cell Control Plane diagnostica e propõe; ele nunca muda um host por conta própria. O agent que observa suas máquinas é read-only, não existe botão "Apply" em lugar nenhum, o reconcile é dry-run apenas, e qualquer requisição que peça pro servidor aplicar é rejeitada com `400`.

> **Por que "nunca aplica"?** Agir em infraestrutura automaticamente é onde control planes ficam perigosos. O Synapse para de propósito no plano: ele te diz exatamente o que divergiu e o que *faria*, e deixa o fazer com você.

## Vocabulário

| Termo | O que é |
|---|---|
| **Host** | Uma máquina (uma VPS) que pode rodar deployments. A caixa que roda o próprio Synapse é o **self-host**. |
| **Agent** | Um programinha **observe-only** que você roda num host. Ele reporta quais containers existem (`docker ps -a` read-only) + um heartbeat. Nunca cria, reinicia nem remove nada. |
| **Cell** | Uma unidade operacional de um projeto que agrupa deployments. Tipos: `core`, `runtime`, `integration`, `preview`, `enterprise-app`. Uma Cell **não** é um cliente e **não** é um deployment. |
| **Placement** | O registro de *onde* um deployment roda — qual host, qual cell, e o status desejado. |
| **Cell Link** | Um **contrato** serviço-a-serviço entre duas cells (quem pode chamar quem, quais comandos/eventos são permitidos). Registra a relação; não transporta tráfego. |
| **Desired state** | O que o control plane *quer*: este deployment deveria estar rodando, neste host. |
| **Observed state** | O que o agent *viu*: este container existe, neste estado, com estes labels. |
| **Drift** | A diferença entre desejado e observado, classificada (`in_sync`, `missing`, `drifted`, …). |

## O modelo

```
Projeto
  └─ Cell (core-prod-…)        ← unidade operacional (agrupa deployments)
       └─ Placement            ← deployment X roda no host Y, desejado: running
            └─ Deployment      ← um container Convex backend real

Host (uma VPS)                 ← observado por um agent (read-only)
```

O Synapse gerencia **infraestrutura** — placement, rotas, saúde, drift. Ele **não** gerencia o auth de usuário final, RBAC ou runtime do *seu* app. Uma Cell é um conceito do Synapse pra organizar deployments, não um tenant do seu app.

## O que você pode fazer

- **Registrar hosts** e observá-los com o agent → ver liveness e o que está de fato rodando em cada caixa.
- **Agrupar deployments em cells** e ver a **topologia** (Host → Cell → Deployment), com avisos pra qualquer coisa não-saudável ou sem placement.
- **Sincronizar o desired state** a partir das placements, **recalcular o drift**, e rodar um **reconcile dry-run** pra ver o plano — pelo dashboard ou pela CLI `synapse`.
- Registrar contratos serviço-a-serviço com **cell links** + **service tokens**.

## Segurança, num lugar só

- O **agent é observe-only**: `docker version` / `docker ps -a` read-only, nada mais. Ele é gated por `SYNAPSE_AGENT_APPLY`, que é `false` por padrão e não é implementado.
- Todo plano de drift carrega `applyAllowed=false`; o dashboard **não tem botão Apply**; a CLI **não tem comando apply** (`synapse reconcile dry-run --apply` dá erro).
- **Nenhum segredo** trafega em labels, desired state ou observed state — sem env vars, admin keys, connection strings ou tokens.

## Continue lendo

- [Hosts & agents](/docs/pt-BR/hosts-and-agents) — registrar um host, rodar o agent observe-only.
- [Cells, links & topologia](/docs/pt-BR/cells-links-topology) — agrupar deployments, ligar contratos, ler o mapa.
- [State & drift](/docs/pt-BR/state-and-drift) — desejado vs observado e o planejador dry-run.
- A [Referência da CLI](/docs/pt-BR/cli) cobre os comandos `hosts` / `cells` / `cell-links` / `topology` / `drift` / `reconcile` / `operations`.
