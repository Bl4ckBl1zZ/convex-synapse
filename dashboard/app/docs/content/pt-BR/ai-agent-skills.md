# Skills para agentes de IA (`synapse skills`)

Pacote de conhecimento sobre Synapse, versionado junto com o projeto, que entra direto no catálogo de skills do seu agente de IA (Claude Code, Anthropic Agent SDK, etc). Lançado na CLI **v1.9.x**.

## O que é

A CLI do Synapse traz uma biblioteca pequena de "skills" em Markdown que qualquer agente de IA compatível pode carregar sob demanda. Elas ensinam o agente como o Synapse difere do Convex Cloud, qual subcomando `synapse` usar, quais warnings são benignos e onde cada arquivo de estado mora.

Quando um agente dentro do seu repo decide fazer deploy, debugar ou setar uma env var, ele precisa escolher o comando certo de primeira — `synapse deploy`, não `npx convex deploy`.

## As seis skills do pacote

| Skill | Carrega quando… | Conteúdo |
|---|---|---|
| `synapse-overview` | Primeira vez que o agente lê o projeto; "o que é synapse" | Modelo mental, diff Cloud vs Synapse, onde mora estado, qual skill carregar a seguir |
| `synapse-deploy` | "deploy", "subir pra prod", "publicar", "release" | `synapse dev` / `synapse deploy`, confirmação y/N, warning benigno do `NEXT_PUBLIC_CONVEX_SITE_URL`, gates pré-deploy |
| `synapse-debug` | "quebrado", "401", "preso", "Email or password is incorrect", "deploy travou" | `synapse doctor` primeiro; correções pro `project.json` velho, bug de code page no PowerShell, banner de wildcard subdomain |
| `synapse-env` | "setar env var", "STRIPE_KEY", "OPENAI_API_KEY", "rotacionar credenciais" | `synapse env list/set/unset/pull/push`, escopo `--for=`, blocklist de chaves reservadas, "Apply to existing deployments" |
| `synapse-multi-deployment` | "preview deploy", "staging", "trocar pra prod" | Modelo dev/prod/preview, `synapse select`, `synapse deployment create`, pattern de preview deploy em CI |
| `synapse-cli-reference` | Sempre que o agente vai rodar `synapse <cmd>` | Catálogo enxuto, uma linha por comando, flags, exit codes, paths de estado |

## Modelo de instalação

```
.synapse/skills/                       ← commitar
├── .bundled
├── synapse-overview/SKILL.md
├── synapse-deploy/SKILL.md
└── …

.claude/skills/synapse-*               ← symlink → ../../.synapse/skills/synapse-*   (gitignore)
.agents/skills/synapse-*               ← symlink (mesmo alvo)                         (gitignore)
```

Symlinks são **relativos** no Unix pro repo continuar portável; Windows usa **junctions** de diretório.

## Detecção de harness

| Harness | Marcador (qualquer um) | Diretório de symlink |
|---|---|---|
| `claude` | `.claude/` existe, ou `CLAUDE.md` na raiz | `.claude/skills/synapse-*` |
| `agents` | `.agents/` existe, ou `AGENTS.md` na raiz | `.agents/skills/synapse-*` |

`--all-harnesses` cria symlink em toda harness conhecida.

## Classificação em 4 estados

`.synapse/skills/.bundled` guarda o hash SHA-256 de cada skill que escrevemos. Em todo `update` / `list`:

| Estado | Significado | O que `update` faz |
|---|---|---|
| `missing` | Não existe `SKILL.md` local pra esse nome | Cria do pacote |
| `ok` | Local == bundled atual | Não mexe |
| `pristine` | Local != bundled mas == hash do stamp. Operador não editou; bundled mudou | Sobrescreve com segurança |
| `customised` | Diverge de bundled E do stamp | **Preserva** o local. `--force` sobrescreve |

## Os cinco verbos

```bash
synapse skills install              # setup inicial
synapse skills update               # puxa novo conteúdo, preserva customizações
synapse skills list                 # status report
synapse skills remove               # apaga symlinks (mantém .synapse/skills/)
synapse skills link                 # só re-cria symlinks
```

Flags comuns: `--force`, `--force-links`, `--all-harnesses`, `--purge`, `--json`.

## Check `ai-skills-installed` do doctor

`synapse doctor` inclui o check. **Pulado em silêncio** sem marcador de harness. **`ok`** quando `.synapse/skills/` existe. **`warn`** quando há harness detectada mas skills não instaladas — auto-corrigível com `synapse doctor --fix --yes`.

## Customizar uma skill

Edita o `SKILL.md` em `.synapse/skills/<name>/` direto. O próximo `update` classifica como `customised` e pula. Pra aceitar mudanças do upstream e perder suas edições, passe `--force`.

## Adicionar sua própria skill

A CLI **só gerencia pastas começando com `synapse-`**. Solte qualquer outra pasta em `.synapse/skills/`:

```
.synapse/skills/
├── synapse-overview/SKILL.md      ← gerenciada pela CLI
├── conv-do-meu-time/SKILL.md      ← sua, intocada
```

A CLI não tenta fazer symlink dela — você cria à mão.

## Por que isso existe

LLMs estão confidentemente errados sobre Convex self-hosted. Foram treinados em anos de documentação `npx convex …` e zero ano de Synapse. Com as skills, o mesmo prompt "deploy pra prod" dispara `synapse-deploy`, que lembra ao agente que `synapse deploy` é o wrapper, que pede y/N, e que o warning sobre `NEXT_PUBLIC_CONVEX_SITE_URL` é só decorativo.
