# Documentação do Synapse

Synapse é um control plane open-source para Convex self-hosted. Uma VPS, um `setup.sh`, e você tem um dashboard que provisiona containers Convex de verdade, gerencia times e projetos, controla escopo de access tokens e lida com auto-update pelo dashboard.

Esta documentação cobre tudo — instalação, arquitetura, todo endpoint da API, todo comando da CLI, toda ação de lifecycle, e o porquê das decisões que não são óbvias no código.

## Por onde começar

- **Novo no Synapse?** Leia [Primeiros passos](/docs/pt-BR/getting-started) e depois [Arquitetura](/docs/pt-BR/architecture).
- **Vindo do Convex Cloud?** Dê uma olhada em [Self-hosted vs Cloud](/docs/pt-BR/self-hosted-vs-cloud) pra saber o que tem e o que não tem.
- **Operação dia-a-dia?** Marque [Guia do operador](/docs/pt-BR/operator-playbook), [Solução de problemas](/docs/pt-BR/troubleshooting), e a [Referência da CLI](/docs/pt-BR/cli).
- **Construindo contra a API?** Vá direto pra [Referência da API](/docs/pt-BR/api).
- **Usando agentes AI?** Configure [Skills para agentes de IA](/docs/pt-BR/ai-agent-skills) pra Claude Code / Anthropic Agent SDK acertarem o comando `synapse` de primeira.

## Índice

### Introdução
- [Visão geral](/docs/pt-BR) — esta página
- [Primeiros passos](/docs/pt-BR/getting-started) — instale em um comando
- [Arquitetura](/docs/pt-BR/architecture) — control plane, data plane, onde mora o estado
- [Self-hosted vs Cloud](/docs/pt-BR/self-hosted-vs-cloud) — o que foi cortado de propósito

### Identidade
- [Auth & acesso](/docs/pt-BR/auth-and-access) — registro, JWT, PATs, escopos
- [Times & projetos](/docs/pt-BR/teams-and-projects) — membership, convites, RBAC, transferência

### Recursos
- [Deployments](/docs/pt-BR/deployments) — tipos, HA, adopt, lifecycle
- [Variáveis de ambiente](/docs/pt-BR/env-vars) — defaults de projeto, escopo, sync
- [Domínios customizados](/docs/pt-BR/custom-domains) — wildcard + per-deployment, TLS on-demand
- [Deploy keys](/docs/pt-BR/deploy-keys) — admin keys nomeadas para CI
- [Integração com o Convex Dashboard](/docs/pt-BR/convex-dashboard-integration) — iframe embedado, picker de deployment

### Operações
- [Guia do operador](/docs/pt-BR/operator-playbook) — todo modo do `setup.sh`
- [Auto-update](/docs/pt-BR/auto-update) — banner do dashboard + updater daemon
- [Audit log](/docs/pt-BR/audit-log) — o que é registrado, onde ler
- [Solução de problemas](/docs/pt-BR/troubleshooting) — sintomas, diagnóstico, fix

### Referência
- [Referência da CLI](/docs/pt-BR/cli) — todo `synapse <cmd>`
- [Referência da API](/docs/pt-BR/api) — todo endpoint
- [Skills para agentes de IA](/docs/pt-BR/ai-agent-skills) — skills bundled para agentes AI
