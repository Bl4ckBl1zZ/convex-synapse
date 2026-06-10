# Deployment-down alerts

When a deployment transitions to `stopped` or `failed`, Synapse notifies somebody instead of just flipping a badge: **email to the owning team's admins** and/or a **webhook** (Slack, Discord, or any endpoint that accepts a JSON POST). On Cloud this is Convex's own ops team paging themselves — self-hosted, it's yours.

Available since **v1.26** (migration `000032_alert_settings`).

---

## When an alert fires (and when it doesn't)

The health worker sweeps every 30 s, comparing what the database believes with what Docker reports. An alert fires on the **deployment-level transition** to `stopped`/`failed` — exactly **once per down event**, never once per sweep. No flood while the deployment stays down; no alert when it comes back up.

It deliberately stays silent when:

- **Auto-restart already fixed it.** With `SYNAPSE_HEALTH_AUTO_RESTART=true`, a container blip the worker recovers in the same sweep never produces a deployment-level transition — nobody gets paged for a problem that no longer exists. If the restart *fails*, the deployment goes `failed` and the alert fires.
- The deployment is **adopted** (external — Synapse doesn't manage its lifecycle) or already `deleted`.

After you fix the issue and hit **Restart**, the deployment goes back to `running` — and a *future* crash fires a *fresh* alert. The crash → alert → restart → crash → alert loop works the way you'd expect.

## The two channels

### Email → team admins

Sent to every user with the **admin role on the team** that owns the deployment (members are not paged). Rides the same Resend configuration as invite emails — **Admin → Email** (or the `.env` fallback). No email configured = no email alerts; the toggle does nothing until a sender exists.

The email names the deployment, project, team and transition, links to the project page, and notes it can be turned off in **Admin → Alerts**.

### Webhook → Slack / Discord / anything

One URL, three audiences — the payload carries a pre-rendered one-liner under **both** `text` (Slack incoming-webhook format) **and** `content` (Discord webhook format), plus structured fields for custom receivers:

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

Paste a Slack incoming-webhook URL or a Discord channel webhook URL as-is — no adapter needed.

## Configuration & precedence

**Admin → Alerts** (instance-admin only), or the API at `/v1/admin/alert_settings`:

| State | Email alerts | Webhook |
|---|---|---|
| Nothing configured (fresh install) | **on** (whenever email is configured) | from `SYNAPSE_ALERT_WEBHOOK_URL` in `.env`, if set |
| Dashboard row saved | whatever you set | whatever you set — **the row wins entirely**, including an empty webhook silencing the `.env` fallback |

Changes apply on the next sweep — no restart. Two secrecy details:

- The webhook URL is **never echoed back** (Slack/Discord paths embed a secret) — GET returns only a masked hint like `https://hooks.slack.com/…`.
- Saving with `webhookUrl` **absent** keeps the stored webhook; explicitly empty clears it. So toggling email never accidentally wipes your webhook.

```bash
# point alerts at a Discord channel + keep email on
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"emailEnabled":true,"webhookUrl":"https://discord.com/api/webhooks/…"}' \
  https://synapsepanel.com/v1/admin/alert_settings
```

Notifications are **best-effort by contract**: a hung receiver or a Resend outage is logged and dropped — it can never stall the health sweep or flap your deployments.

## Testing it for real

1. Make sure email is configured (**Admin → Email**) and/or paste a webhook in **Admin → Alerts**.
2. Pick a deployment you can afford to blip and kill its container on the host: `docker kill convex-<name>`.
3. Within ~30 s: the dashboard flips the row to `stopped`, the email lands in the team admins' inboxes (check spam the first time), the webhook message appears.
4. Hit **Restart** on the row — container back, status `running`, done.

## Troubleshooting

- **No email arrived** → is a sender configured (Admin → Email shows *Configured*)? Is your account actually a team **admin** on the deployment's team? Check spam. Then `docker logs synapse-api | grep "alert:"` — send failures are logged (keys redacted).
- **No webhook** → `alert: webhook post failed` in the same logs names the deployment and the error (timeout, DNS, non-2xx) without leaking the URL.
- **Alert fired but auto-restart was supposed to handle it** → auto-restart only re-starts *exited* containers; a removed container is promoted to `failed` and alerts. That's intentional.
