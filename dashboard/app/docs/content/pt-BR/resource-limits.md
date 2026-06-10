# Limites de CPU/RAM por deployment

Tetos opcionais de CPU e memória por deployment, aplicados pelo Docker — a resposta self-hosted às deployment classes do Cloud. Num VPS compartilhado é a diferença entre "o hot loop de um tenant derruba todo mundo" e "o hot loop de um tenant estrangula só aquele tenant".

Disponível desde a **v1.26** (migration `000034_deployment_resources`).

---

## O que são os limites

| Campo | Faixa | Vira no Docker |
|---|---|---|
| `cpus` | 0.1 – 64, frações valem (`0.5` = meio core) | `NanoCPUs` (`--cpus`) |
| `memoryMb` | 128 – 1 048 576 | `Memory` (limite duro, em bytes) |

Os dois são opcionais e independentes. **Ausente = ilimitado** — exatamente o comportamento pré-v1.26, e o que todo deployment existente mantém depois do upgrade. Valores fora da faixa são rejeitados com `400 invalid_resources`.

Quando um container com teto de memória estoura o limite, o kernel mata ele (OOM kill) — e aí o health worker vira pra `stopped` (disparando um [alerta de queda](/docs/pt-BR/deployment-alerts) se configurado) ou auto-reinicia. Teto de CPU só estrangula; nada é morto.

## Definindo limites na criação

O dialog de **Criar deployment** tem dois campos opcionais (Limite de CPU / Limite de memória). Pela API:

```bash
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"type":"prod","cpus":1,"memoryMb":1024}' \
  https://synapsepanel.com/v1/projects/<project-id>/create_deployment
```

Deployments limitados mostram um badge no card — `1 CPU · 1024 MB`. Os valores voltam como `cpus`/`memoryMb` em todo GET/list de deployment.

## Redimensionando um deployment rodando

O Docker fixa o `HostConfig` na criação do container — um restart simples mantém os tetos antigos. Por isso o **Redimensionar** (botão no card expandido, members+) **recria o container** com os limites novos:

- O volume de dados é mantido — sem perda de dados.
- Espere uma indisponibilidade breve (segundos) enquanto o container é trocado.
- O corpo é o **estado desejado completo**: deixe um campo em branco pra ilimitado. Limpar os dois remove o badge e destampa o container.

```bash
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"cpus":2,"memoryMb":2048}' \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/update_resources
```

Auditado como `updateDeploymentResources`.

## Garantias que valem saber

- **Limites sobrevivem a todo recreate.** Rebakes de domínio customizado, rebuilds de CORS e resizes recarregam os limites persistidos do banco — nenhum caminho de código consegue destampar um container em silêncio.
- **Restarts são seguros** — `docker restart` mantém o HostConfig existente, então o botão Reiniciar nunca muda limites.
- **Criações HA** aplicam os limites nas **duas** réplicas.
- Verifique contra o daemon quando quiser: `docker inspect -f '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' convex-<nome>` (0 0 = ilimitado; `5e8` = 0.5 CPU).

## Limitações (v1)

Códigos de erro estáveis no `update_resources`:

- `409 cannot_resize_adopted` — backend externo, sem container gerenciado pelo Synapse.
- `409 ha_resize_not_supported` — redimensionar um HA vivo precisa de recreate rolante por réplica (no radar); defina os limites na criação.
- `409 remote_resize_not_supported` — o recreate só despacha pro daemon Docker local por enquanto.
- `409 deployment_not_running` — o caminho de recreate precisa de um container vivo.

## Escolhendo valores sensatos

O backend Convex é um processo Rust único; pra apps pequenos/médios `0.5–1 CPU` e `512–1024 MB` é um piso confortável. Abaixo de `0.25 CPU` / `256 MB` os cold starts e os pushes ficam visivelmente lentos — o piso da faixa (`0.1` / `128`) existe pra experimentos, não produção. Na dúvida, comece sem teto, observe o `docker stats`, e aí limite com folga.
