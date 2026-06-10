# Alertas de deployment caído

Quando um deployment vai pra `stopped` ou `failed`, o Synapse avisa alguém em vez de só trocar um badge: **email pros admins do time** dono do deployment e/ou um **webhook** (Slack, Discord, ou qualquer endpoint que aceite um POST JSON). No Cloud isso é a equipe de ops da própria Convex se monitorando — no self-hosted, é a sua.

Disponível desde a **v1.26** (migration `000032_alert_settings`).

---

## Quando um alerta dispara (e quando não)

O health worker varre a cada 30 s, comparando o que o banco acredita com o que o Docker reporta. Um alerta dispara na **transição do deployment** pra `stopped`/`failed` — exatamente **uma vez por queda**, nunca uma vez por varredura. Sem enxurrada enquanto o deployment continua caído; sem alerta quando ele volta.

Ele fica calado de propósito quando:

- **O auto-restart já resolveu.** Com `SYNAPSE_HEALTH_AUTO_RESTART=true`, um soluço de container que o worker recupera na mesma varredura nunca produz transição no deployment — ninguém é acordado por um problema que já não existe. Se o restart *falhar*, o deployment vai pra `failed` e o alerta dispara.
- O deployment é **adotado** (externo — o Synapse não gerencia o ciclo de vida) ou já está `deleted`.

Depois que você resolve e clica em **Reiniciar**, o deployment volta pra `running` — e um crash *futuro* dispara um alerta *novo*. O ciclo crash → alerta → restart → crash → alerta funciona como você espera.

## Os dois canais

### Email → admins do time

Vai pra todo usuário com papel de **admin no time** dono do deployment (members não são acordados). Usa a mesma configuração de Resend dos emails de convite — **Admin → Email** (ou o fallback do `.env`). Sem email configurado = sem alertas por email; o toggle não faz nada até existir um remetente.

O email nomeia deployment, projeto, time e a transição, linka pra página do projeto, e lembra que dá pra desligar em **Admin → Alerts**.

### Webhook → Slack / Discord / qualquer coisa

Uma URL, três públicos — o payload carrega a mensagem pronta **tanto** em `text` (formato de incoming webhook do Slack) **quanto** em `content` (formato de webhook do Discord), além dos campos estruturados pra receivers customizados:

```json
{
  "event": "deployment.down",
  "status": "stopped",
  "previousStatus": "running",
  "deployment": { "id": "…", "name": "brave-dolphin-1060", "type": "prod" },
  "project":    { "id": "…", "name": "Store", "slug": "store" },
  "team":       { "id": "…", "name": "Amage", "slug": "amage" },
  "dashboardUrl": "https://synapsepanel.com/teams/amage/<project-id>",
  "occurredAt": "2026-06-10T01:10:03Z",
  "text":    "⚠️ Synapse: deployment brave-dolphin-1060 (prod) in project Store is down — running → stopped",
  "content": "⚠️ Synapse: deployment brave-dolphin-1060 (prod) in project Store is down — running → stopped"
}
```

Cole a URL de um incoming webhook do Slack ou de um webhook de canal do Discord como está — sem adaptador.

## Configuração & precedência

**Admin → Alerts** (só instance-admin), ou a API em `/v1/admin/alert_settings`:

| Estado | Alertas por email | Webhook |
|---|---|---|
| Nada configurado (instalação nova) | **ligado** (sempre que email estiver configurado) | do `SYNAPSE_ALERT_WEBHOOK_URL` no `.env`, se definido |
| Linha salva pelo dashboard | o que você definiu | o que você definiu — **a linha vence por inteiro**, inclusive um webhook vazio silenciando o fallback do `.env` |

Mudanças valem na próxima varredura — sem restart. Dois detalhes de sigilo:

- A URL do webhook **nunca é devolvida** (os paths do Slack/Discord embutem um segredo) — o GET retorna só uma dica mascarada tipo `https://hooks.slack.com/…`.
- Salvar com `webhookUrl` **ausente** mantém o webhook guardado; explicitamente vazio limpa. Então mexer no toggle de email nunca apaga seu webhook sem querer.

```bash
# apontar alertas pra um canal do Discord + manter email ligado
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"emailEnabled":true,"webhookUrl":"https://discord.com/api/webhooks/…"}' \
  https://synapsepanel.com/v1/admin/alert_settings
```

As notificações são **best-effort por contrato**: um receiver travado ou uma queda do Resend é logado e descartado — nunca trava a varredura de saúde nem mexe nos seus deployments.

## Testando de verdade

1. Garanta email configurado (**Admin → Email**) e/ou cole um webhook em **Admin → Alerts**.
2. Escolha um deployment que pode dar um soluço e mate o container no host: `docker kill convex-<nome>`.
3. Em ~30 s: o dashboard vira a linha pra `stopped`, o email cai na caixa dos admins do time (olhe o spam na primeira vez), a mensagem aparece no webhook.
4. Clique em **Reiniciar** na linha — container de volta, status `running`, pronto.

## Solução de problemas

- **Email não chegou** → tem remetente configurado (Admin → Email mostra *Configurado*)? Sua conta é mesmo **admin** do time do deployment? Olhou o spam? Depois `docker logs synapse-api | grep "alert:"` — falhas de envio são logadas (chaves redigidas).
- **Webhook não chegou** → `alert: webhook post failed` nos mesmos logs nomeia o deployment e o erro (timeout, DNS, não-2xx) sem vazar a URL.
- **Alertou mas o auto-restart era pra ter resolvido** → o auto-restart só religa containers *exited*; um container removido é promovido a `failed` e alerta. É intencional.
