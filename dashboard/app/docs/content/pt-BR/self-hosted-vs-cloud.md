# Self-hosted vs Convex Cloud — o que o Synapse intencionalmente não traz

O Synapse reimplementa **100% do subconjunto da OpenAPI que faz sentido pra uma caixa self-hosted**, não 100% dos paths que o Convex Cloud expõe. Aproximadamente 60 dos ~113 paths cloud foram cortados de propósito. Esta página é o catálogo canônico do *quê* foi cortado e *por quê*.

A lista de corte mora em `synapse/internal/api/not_supported.go`. Tudo que dá match é curto-circuitado pelo `NotSupportedMiddleware` (antes do `chi` sequer ver, antes do auth rodar) e retorna:

```json
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "code": "not_supported_in_self_hosted",
  "message": "This endpoint exists in Convex Cloud but is intentionally not implemented in Synapse self-hosted. See docs/ARCHITECTURE.md \"Out of scope\" for the rationale."
}
```

O `code` estruturado é estável entre releases. Use programaticamente pra distinguir "digitei o URL errado" (`404 not_found`) de "isso nunca vai existir no self-hosted" (`404 not_supported_in_self_hosted`).

## Por que 404 e não 501

`501 Not Implemented` é lido como *"a gente planeja entregar"*, o que faz callers (dashboards, suítes de teste da spec cloud) ficarem tentando pra sempre. `404 not_supported_in_self_hosted` diz *"não existe recurso aqui, nunca vai existir"* e deixa a ferramenta seguir em frente.

O middleware roda **antes** do gate de auth — então uma sonda sem login já descobre que o endpoint não vem, sem precisar logar primeiro.

## Como o matcher funciona

Três camadas, em ordem:

1. **Paths exatos** — cortes pontuais. (1 entrada)
2. **Famílias por prefixo** — todo path sob esse prefixo é cortado. (5 prefixos)
3. **Padrões parametrizados** — `/v1/<resource>/<id>/<verb>` com wildcard no segmento do meio. Match com `path.Match` do Go — `*` casa um único segmento. (49 padrões)

Total: **1 exato + 5 famílias por prefixo + 49 padrões parametrizados**.

## Lista de corte por categoria

### Billing — Orb / Stripe (20 endpoints parametrizados)

O Convex Cloud usa Orb em cima do Stripe pra billing por consumo. Nada disso existe no self-hosted porque o operador paga o VPS direto.

```
/v1/teams/*/apply_referral_code
/v1/teams/*/cancel_orb_subscription
/v1/teams/*/change_subscription_plan
/v1/teams/*/create_setup_intent
/v1/teams/*/create_subscription
/v1/teams/*/get_current_spend
/v1/teams/*/get_discounted_plan/*
/v1/teams/*/get_discounted_plan/*/*
/v1/teams/*/get_entitlements
/v1/teams/*/get_orb_subscription
/v1/teams/*/get_spending_limits
/v1/teams/*/has_failed_payment
/v1/teams/*/list_active_plans
/v1/teams/*/list_invoices
/v1/teams/*/referral_state
/v1/teams/*/set_spending_limit
/v1/teams/*/unschedule_cancel_orb_subscription
/v1/teams/*/update_billing_address
/v1/teams/*/update_billing_contact
/v1/teams/*/update_payment_method
```

### SSO via WorkOS (8 endpoints parametrizados)

WorkOS é o complemento de SSO enterprise que o Convex Cloud vende. OIDC está no roadmap do Synapse, mas as rotas específicas de WorkOS nunca vão existir. JWT email+senha é o modelo atual de auth.

```
/v1/teams/*/disable_sso
/v1/teams/*/enable_sso
/v1/teams/*/generate_sso_configuration_link
/v1/teams/*/get_sso
/v1/teams/*/update_sso
/v1/teams/*/workos_integration
/v1/teams/*/workos_invitation_eligible_emails
/v1/teams/*/workos_team_health
```

Mais toda a família de prefixo `/v1/workos/*` pros handlers de webhook + callback do WorkOS.

### OAuth apps (6 endpoints parametrizados)

O Convex Cloud vende "OAuth apps" como produto — terceiros registrando apps que pedem consentimento pra entrar numa conta Convex. Fora do escopo do control plane self-hosted.

```
/v1/teams/*/oauth_apps
/v1/teams/*/oauth_apps/check
/v1/teams/*/oauth_apps/register
/v1/teams/*/oauth_apps/*/delete
/v1/teams/*/oauth_apps/*/regenerate_secret
/v1/teams/*/oauth_apps/*/update
```

### Uso / metering (4 endpoints parametrizados)

Superfícies de metering Cloud-only. Operadores self-hosted leem as próprias métricas do docker / VPS.

```
/v1/teams/*/usage/current_billing_period
/v1/teams/*/usage/query
/v1/teams/*/usage/team_usage_state
/v1/teams/*/usage/get_token_info
```

### Backups gerenciados pelo Cloud (6 endpoints parametrizados)

O Cloud agenda e guarda backups por você. Equivalente self-hosted: `setup.sh --backup` (local ou `--to-s3=s3://…`).

```
/v1/deployments/*/configure_periodic_backup
/v1/deployments/*/disable_periodic_backup
/v1/deployments/*/get_periodic_backup_config
/v1/deployments/*/list_cloud_backups
/v1/deployments/*/request_cloud_backup
/v1/deployments/*/restore_from_cloud_backup
```

Mais toda a família de prefixo `/v1/cloud_backups/*`.

### Rotas de deployment / projeto com sabor WorkOS (5 endpoints parametrizados)

Essas amarram um deployment ou projeto a um ambiente gerenciado pelo WorkOS. Mesma justificativa do corte de WorkOS acima.

```
/v1/deployments/*/has_associated_workos_team
/v1/deployments/*/workos_environment
/v1/deployments/*/workos_environment_health
/v1/projects/*/workos_environments
/v1/projects/*/workos_environments/*
```

### Referrals (1 endpoint exato)

O único endpoint de referral fora de team. Programa de indicação só faz sentido pra Cloud pago.

```
/v1/validate_referral_code
```

### Famílias por prefixo

| Prefixo | Por que foi cortado |
|---|---|
| `/v1/cloud_backups` | Substituído por `setup.sh --backup [--to-s3=…]` |
| `/v1/discord` | Webhook / integração Discord, Cloud-only |
| `/v1/profile_emails` | Gestão de emails (secundários verificados, etc) Cloud-only — no Synapse cada conta tem um único email de login |
| `/v1/vercel` | Integração Vercel Cloud-only |
| `/v1/workos` | SSO enterprise via WorkOS — OIDC é a substituição planejada |

## O que ESTÁ implementado — placar de compatibilidade

De `docs/ROADMAP.md`:

| Recurso | Cobertura |
|---|---|
| Auth | custom (sem WorkOS — OIDC trackado separadamente) |
| Profile (`/me`) | get / update_profile_name / delete_account / member_data / optins |
| Teams | get / update / delete / list_projects / list_members / list_deployments / invites / accept / update_member_role / remove_member |
| Projects | get / update (nome+slug) / delete / transfer / env vars / list_deployments / **list/add/update_role/remove members (RBAC v1.0+)** |
| Deployments | get / create / adopt / delete / auth / cli_credentials / deploy_keys / custom domains (v1.0); rota de validação do `upgrade_to_ha` é reservada e retorna 501 até o worker de export/import de snapshot chegar |
| Personal access tokens | escopos user / team / project / app / deployment + middleware de auth ciente do escopo |
| Team invites | list / cancel / accept (custom: fluxo de URL com token opaco) |
| Audit log | leitura team-scoped; admin only |
| Reverse proxy | `/d/{name}/*` + subdomínios via Host header (custom domains v1.0) |
| Compatibilidade CLI | endpoint `cli_credentials` + admin keys assinadas |
| Cloud backups | equivalente self-hosted: `setup.sh --backup [--to-s3=...]` |
| Billing / SSO / Discord / Vercel / OAuth apps / referrals | cortado de propósito — `404 not_supported_in_self_hosted` |

O ROADMAP afirma "100% do subconjunto relevante pra self-hosted" desde a v1.0; o marco de cobertura da OpenAPI está marcado como DONE lá.

## "Talvez nunca" — pedaços maiores que não vão voltar

- Paridade completa de billing Stripe/Orb (irrelevante pra self-hosted)
- Equivalente de LaunchDarkly (use config estática + env vars)
- Paths específicos de WorkOS (use OIDC)
- Integrações Discord / Vercel / etc (fora de escopo)

## Nota sobre OIDC no roadmap

SSO via OIDC está no roadmap — listado explicitamente como `OAuth / SSO via OIDC` em "Deferred / out of scope this milestone" no ROADMAP.md, com a nota *"Synapse stays email+password JWT until then; enterprise SSO is the next big request once RBAC lands"*. RBAC já chegou (v1.0+). OIDC é o próximo grande pedaço de auth. A lista de corte de WorkOS acima é permanente independente disso — OIDC vai ser um modelo paralelo de auth, não um substituto pras rotas de WorkOS.

## O que fazer quando bater num `not_supported_in_self_hosted`

- Se você é um dashboard ou uma CLI: ramifica pelo campo `code`. Mostra uma mensagem "feature só disponível no Convex Cloud" no lugar de um erro genérico.
- Se você é um script: para de tentar de novo. O endpoint não vai começar a funcionar.
- Se você é um operador que esperava que funcionasse: dá uma olhada aqui primeiro. Se o corte te surpreendeu, abre uma issue — mas a régua é "isso é genuinamente útil pra um operador self-hosted", não "o Cloud tem".
