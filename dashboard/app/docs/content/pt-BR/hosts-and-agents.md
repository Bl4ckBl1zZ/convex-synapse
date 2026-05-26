# Hosts & agents

Um **host** é uma máquina que pode rodar deployments — quase sempre uma VPS. A caixa que roda o próprio Synapse é registrada automaticamente como o **self-host**. Todo outro host é algo que você registra e, opcionalmente, observa com o **agent**.

Veja [Cell Control Plane](/docs/pt-BR/cell-control-plane) pro panorama geral; esta página é o passo-a-passo de hosts e do agent observe-only.

## Registrando um host

No painel **Hosts** (ou `synapse hosts create`), registre um host com nome e região. O registro é **só metadados** — não toca em máquina nenhuma. Você ganha uma linha de host pra anexar cells e observar.

```bash
synapse hosts create --name vps-br-1 --region br
synapse hosts list
```

A gestão de hosts (criar, drain, adoption tokens, revogar/rotacionar agent) é **instance-admin** apenas.

## O agent

O `synapse-agent` é um programa Go de binário único que você roda **no host que quer observar**. Ele é **observe-only**:

- Lê `docker version` e `docker ps -a` (um scan de containers read-only). Só isso.
- **Nunca** cria, inicia, reinicia ou remove containers, volumes, ou qualquer coisa.
- Reporta um **heartbeat** + os containers observados + um resumo de saúde `containerScan`.
- É gated por `SYNAPSE_AGENT_APPLY` — padrão `false`, e apply **não é implementado**.

### O que ele reporta (e o que nunca reporta)

| Reporta | Nunca reporta |
|---|---|
| id, nome, imagem, estado, status, portas do container | Variáveis de ambiente |
| labels `synapse.*` (managed, deployment_id, project_id, cell_id) | Command / entrypoint |
| Fatos do host (CPU, RAM, disco), disponibilidade do docker | Mounts, conteúdo de volumes |
| `containerScan` (attempted / succeeded / complete) | Logs, segredos, admin keys, connection strings |

Os labels são filtrados pro namespace `synapse.*` tanto no agent quanto no servidor, então nada sensível é guardado como observed state.

### Instalar & join

1. Pegue o binário dos assets do GitHub Release (`synapse-agent-linux-amd64` / `-arm64`) e coloque no host, ex. `/usr/local/bin/synapse-agent`.
2. Gere um **adoption token de uso único** pro host (painel **Hosts → Adoption token**, ou `synapse hosts adoption-token`). Ele imprime um comando de join pronto pra colar.
3. Faça o join — isso registra o agent e escreve um config `0600` (o token nunca é impresso de novo):

```bash
synapse-agent join --control-url https://seu-host --token <adoption-token> \
  --config /etc/synapse-agent/config.json
```

4. Rode. `--once` faz um único heartbeat (útil pra testar); sem ele, o agent manda heartbeat num intervalo (padrão a cada 15s):

```bash
synapse-agent run --config /etc/synapse-agent/config.json          # loop em foreground
synapse-agent run --once --config /etc/synapse-agent/config.json    # um heartbeat, sai
```

### Rodar como serviço

Pra observação contínua, instale o unit do systemd (em `installer/templates/synapse-agent.service`):

```ini
[Service]
ExecStart=/usr/local/bin/synapse-agent run --config /etc/synapse-agent/config.json
Restart=always
NoNewPrivileges=true
```

```bash
systemctl enable --now synapse-agent
```

Sem um agent rodando continuamente, o observed state de um host fica velho e ele lê como `stale` e depois `offline` — o que é honesto, não um erro (veja liveness abaixo).

## Liveness: online / stale / offline

O **effectiveStatus** de um host é computado a partir do último heartbeat:

| Status | Significado |
|---|---|
| `online` | Heartbeat nos últimos 60s. |
| `stale` | Heartbeat mais velho que 60s mas dentro de 5 minutos. |
| `offline` | Sem heartbeat por mais de 5 minutos (ou nunca). |
| `draining` | Operador marcou como draining — tem precedência sobre os acima. |

**O self-host é especial.** A máquina que roda o Synapse está viva por definição — ela está te servindo o dashboard agora mesmo — então ela sempre lê `online`, independente de ter um agent rodando nela, a menos que você a coloque em draining.

> **Liveness não é o mesmo que o painel estar acessível.** "Online" significa *um agent está reportando* (ou é o self-host). Um host não-self sem agent vai ler `offline` mesmo que a caixa esteja perfeitamente saudável — o Synapse só não consegue vê-la sem o agent.

## Liveness vs. confiança (por que um host stale nunca inventa drift)

Liveness (acima) e **confiança** (dá pra acreditar nos containers observados?) são separados. O drift só confia na observação de um host quando ele está online **e** o scan de containers do agent teve sucesso e foi completo. Se um host está stale, offline, ou o scan falhou, o drift reporta os recursos lá como `host_unreachable` — nunca um `missing` enganoso. É por isso que desligar o agent é seguro: você perde frescor, não correção. Veja [State & drift](/docs/pt-BR/state-and-drift).

## Revogar / rotacionar acesso do agent

Se um host é descomissionado ou um token vaza, revogue ou rotacione o agent pelo painel (Host **Details**) ou pela CLI:

```bash
synapse hosts agents --host <host-id>     # lista agents de um host
# revogar / rotacionar pelo painel, ou pelos endpoints host_agents
```

Revogar um token de agent faz o próximo heartbeat dele virar `401`; o host então envelhece pra `offline`.
