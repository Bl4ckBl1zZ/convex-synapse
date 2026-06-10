# Backups de deployment

Backups de snapshot por deployment com download, restore, agendamento diário e retenção — a resposta self-hosted à página de **Backups** do Convex Cloud (que o Cloud cobra no plano Pro). Cada backup é um **snapshot export real do Convex**: o mesmo zip que o `npx convex export` produz, tirado do backend ao vivo com a admin key dele, então contém tabelas, file storage e tudo mais que um snapshot export carrega.

Disponível desde a **v1.26** (migration `000035_deployment_backups`).

> **Existem duas camadas de backup — não confunda:**
>
> - **Backups por deployment (esta página)** — snapshot dos dados de UM deployment, gerenciado pelo dashboard, restaurável no mesmo deployment com um clique.
> - **Backup da instância** (`setup.sh --backup [--to-s3=…]`) — o control plane inteiro: Postgres de metadados, `.env`, compose e todos os volumes de deployment num tarball só. Disaster recovery da máquina em si. Veja o guia do operador.

---

## Como um backup é feito

Quando você clica em **Fazer backup agora** (ou o agendador diário dispara), o Synapse:

1. Insere uma linha em `deployment_backups` (`pending`) e enfileira um job na mesma fila durável que o provisionamento usa — um restart do control plane não perde o trabalho.
2. Um worker sobe um **container CLI descartável** (`node:22-alpine`) na rede dos deployments e roda `npx convex export` contra o backend do deployment, autenticado com a admin key dele.
3. O zip resultante cai no volume Docker compartilhado **`synapse-backups`** como `<deployment-id>/<backup-id>.zip`, a linha vira `complete` com o tamanho do arquivo, e o container transitório é removido.

O export é tirado do **backend ao vivo**, então é um snapshot consistente — não precisa parar o deployment. Falhas marcam a linha como `failed` com o texto do erro e **nunca** mexem no status do deployment em si.

## Restore — leia antes de clicar

O restore devolve o arquivo com `convex import --replace`: os **dados atuais do deployment são substituídos por inteiro** pelo snapshot. Tudo que foi gravado depois do backup se perde. Não tem desfazer — o dashboard pede confirmação, e a API exige **admin do projeto**.

O deployment continua rodando durante o restore (é um import, não um rebuild de container). Em deployments HA o import entra por uma réplica viva; o estado é compartilhado via Postgres + S3, então todas as réplicas enxergam.

Depois de um restore a linha mostra **restaurado <hora>** pra você saber qual arquivo foi aplicado por último.

## Agendamento diário + retenção

Por deployment, no painel de **Backups**:

- **Backups automáticos**: `Desligado` ou `Diário`. Um sweeper server-side (multi-node safe, com advisory lock) cria um backup por dia UTC. Uma tentativa que falhou tenta de novo depois de 1 hora, em vez de martelar a cada tick.
- **Manter os últimos `N`** (1–90): backups completos além do limite são removidos automaticamente — primeiro o arquivo do disco, depois a linha.

Backups criados pelo agendador aparecem como **(agendado)** na lista (sem usuário solicitante).

## O painel no dashboard

Cada card de deployment (expandido) tem um painel de **Backups**:

| Ação | Quem | Notas |
|---|---|---|
| Fazer backup agora | members+ | um backup em andamento por deployment (`409 backup_in_progress`) |
| Baixar | members+ | baixa o zip; mesmo nível de confiança da admin key que members já recebem nas credenciais da CLI |
| Restaurar | **só admins** | destrutivo, com confirmação; marca `restaurado` ao terminar |
| Excluir | só admins | remove arquivo + linha; linhas em andamento são protegidas |
| Agendamento / retenção | só admins | vale a partir do próximo tick do sweeper (≤10 min) |

## Superfície da API

Tudo sob `/v1/deployments/{name}`:

```bash
# pedir um backup (202 — consulte a lista até status=complete)
curl -X POST -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backups

# listar (mais novos primeiro)
curl -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backups

# baixar o zip
curl -OJ -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backups/<id>/download

# restaurar (destrutivo — convex import --replace)
curl -X POST -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backups/<id>/restore

# excluir
curl -X POST -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backups/<id>/delete

# agendamento diário + retenção
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"schedule":"daily","retention":7}' \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/backup_settings
```

Ações de audit: `requestBackup`, `restoreBackup`, `deleteBackup`, `updateBackupSettings`.

## Limitações (v1)

Cada recusa tem um código de erro estável:

- **Deployments adotados** (`409 cannot_backup_adopted`) — o Synapse não gerencia o backend externo; rode `npx convex export` direto nele.
- **Deployments em host remoto** (`409 remote_backup_not_supported`) — o container CLI roda no host do control plane e ainda não alcança a rede de um deployment remoto.
- **O deployment precisa estar rodando** (`409 deployment_not_running`) — o snapshot é exportado do backend ao vivo.
- Os arquivos vivem no volume `synapse-backups` do host do control plane — **não** são copiados pra fora. Pra cópia off-site, baixe os zips ou inclua o volume na sua rotina de backup da instância.

## Solução de problemas

- **Backup preso em `pending`/`running` por mais de uma hora** → o sweeper expira pra `failed`. Veja `docker logs synapse-api` pro erro do export (admin keys são redigidas).
- **`failed` com "archive missing after export"** → o container CLI exportou mas o arquivo não chegou no volume; cheque espaço em disco e se `synapse-backups` está montado em `/backups` no `synapse-api`.
- **Download responde `archive_missing`** → o zip foi removido pela retenção ou o volume foi trocado; a linha está obsoleta — exclua.
- **Primeiro backup demorado** → o container descartável baixa a CLI `convex` do npm a cada execução; espere ~30–60 s com cache frio.
