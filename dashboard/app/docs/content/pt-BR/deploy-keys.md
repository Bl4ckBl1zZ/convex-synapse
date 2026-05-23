# Deploy keys

Admin keys nomeadas por deployment, pra integrações de CI (Vercel, GitHub Actions, Claudin, etc). Cada key tem nome, prefixo e trilha de auditoria próprios, então uma credencial vazada da Vercel não te obriga a rotacionar tudo o resto. Espelha a superfície **Personal Deployment Settings → Deploy Keys** do Convex Cloud.

Disponível desde **v1.0.3** (migration `000009_deployment_deploy_keys`).

> **Não confunda deploy keys com access tokens.** Vivem em tabelas diferentes pra propósitos diferentes:
>
> - **`deploy_keys`** — credencial admin por deployment. Formato `<deployment>|<hex>`. Verificada pelo backend Convex via assinatura contra o `INSTANCE_SECRET`. Usada por scripts de CI rodando `npx convex deploy`.
> - **`access_tokens`** — token de sessão por user / team / project / app / deployment. String opaca do Synapse verificada pelo próprio Synapse. Usada pelo dashboard, pela CLI `synapse` e por casos humanos de PAT.

## O modelo GitHub-PAT

Quando você cria uma deploy key, a **admin key completa** aparece na resposta **exatamente uma vez**. O Synapse armazena só `admin_key_hash` (SHA-256) + `admin_key_prefix` (primeiros 8 chars hex). Perdeu o valor? Revoga e cria nova.

## Superfície da API

| Método | Path | O que faz |
|---|---|---|
| `POST` | `/v1/deployments/{name}/deploy_keys` | Cria nova; retorna `adminKey` + `envSnippet` + `exportSnippet` |
| `GET`  | `/v1/deployments/{name}/deploy_keys` | Lista ativas (só metadata) |
| `POST` | `/v1/deployments/{name}/deploy_keys/{id}/revoke` | Revoga (atenção abaixo) |

Body do create: `{name: string}` (≤64 chars, único entre ativas). Gates: `canAdminProject`.

```bash
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"name":"vercel"}' \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/deploy_keys
```

Erros: `deploy_keys_unsupported_for_adopted`, `deploy_keys_unsupported_for_ha`, `deployment_not_running`, `name_in_use`, `missing_name`, `name_too_long`.

## Semântica do revoke — importante

Revogar uma deploy key é **mais pesado do que o dashboard faz parecer**. O backend Convex autentica admin keys via assinatura contra `INSTANCE_SECRET`, sem estado por-key. Pra invalidar de fato uma key vazada, o secret precisa mudar.

O endpoint de revoke, atomicamente em uma transação:
1. `SELECT … FOR UPDATE` no deployment + linha da key
2. Gera novo `INSTANCE_SECRET` + nova admin key
3. `Docker.Recreate` recria o container com o secret novo
4. Marca **todas as deploy keys ativas** desse deployment como revogadas

Espera ~15s de downtime pelo recreate. A admin key do Convex Dashboard embedado também rotaciona e o embed faz re-mint sozinho.

Pra invalidar UMA key sem rotacionar tudo: não tem caminho cirúrgico. Suas opções são (a) revoke (mata todas), (b) deletar + recriar o deployment.

## Schema (`migration 000009`)

```sql
ALTER TABLE deploy_keys
    DROP CONSTRAINT deploy_keys_token_hash_key;
ALTER TABLE deploy_keys
    RENAME COLUMN token_hash TO admin_key_hash;
ALTER TABLE deploy_keys
    ADD COLUMN admin_key_prefix TEXT NOT NULL DEFAULT '',
    ADD COLUMN revoked_at       TIMESTAMPTZ;
CREATE UNIQUE INDEX deploy_keys_active_name
    ON deploy_keys (deployment_id, name)
    WHERE revoked_at IS NULL;
```

O partial unique `WHERE revoked_at IS NULL` permite **reusar nomes** depois de revoke.

## Audit log

Toda criação e revoke escreve `createDeployKey` / `revokeDeployKey` em `audit_events` com metadata incluindo deployment id+name, key name e prefixo (nunca o valor).

## Uso em CI

```bash
# .env.production (Vercel)
CONVEX_SELF_HOSTED_URL='https://api.cliente.com'
CONVEX_SELF_HOSTED_ADMIN_KEY='brave-dolphin-1060|01234567...'
```

```yaml
# GitHub Actions
- name: Deploy
  run: |
    export CONVEX_SELF_HOSTED_URL='https://api.cliente.com'
    export CONVEX_SELF_HOSTED_ADMIN_KEY='brave-dolphin-1060|01234567...'
    npx convex deploy
```
