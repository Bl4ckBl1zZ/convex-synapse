# Solução de problemas

Sintomas específicos, o comando de diagnóstico que confirma a causa, e o fix.

## "Email or password is incorrect" no Windows PowerShell

**Sintoma.** `synapse login` no Windows devolve "Email or password is incorrect" mesmo com credenciais funcionando no dashboard. Afeta senhas com chars não-ASCII (acentos, ñ, ã, ç, ...).

**Diagnóstico.** Rode `chcp` na mesma sessão. Se devolver qualquer coisa diferente de `65001` (UTF-8), o PowerShell tá lendo teclas pelo code page legado.

**Fix.** Atualize o CLI pra v1.8.10+ que roda `chcp 65001` automaticamente no startup:

```powershell
npm install -g @iann29/synapse@latest
synapse login
```

## `synapse dev` falha com "CONVEX_DEPLOYMENT must not be set..."

**Sintoma.** `synapse dev` aborta com `CONVEX_DEPLOYMENT must not be set when calling convex dev`. O CLI seta essa env internamente; um export no environment dá shadow.

**Diagnóstico.**

```bash
grep -RIn 'CONVEX_DEPLOYMENT' ~/.bashrc ~/.zshrc ~/.profile ~/.config/fish/ 2>/dev/null
env | grep CONVEX
```

**Fix.**

```bash
unset CONVEX_DEPLOYMENT
synapse select       # re-binda
synapse dev
```

Aí apaga a linha culpada do shell rc.

## `.synapse/project.json` desatualizado

**Sintoma.** `synapse dev` / `synapse deploy` reclamam de project/deployment que não existe mais, ou foi renomeado.

**Diagnóstico.**

```bash
cat .synapse/project.json
```

Se `projectId` / `prodDeploymentName` / `devDeploymentName` não casam com o que o dashboard mostra, o pin local tá stale.

**Fix.**

```bash
synapse doctor --fix --yes
```

Re-prova o servidor, dropa pins órfãos, re-binda o que ainda existe.

## "URL not browser-reachable" / banner laranja no embed

**Sintoma.** Dashboard mostra banner laranja: "this deployment's URL is not browser-reachable" — ou o Convex Dashboard embedado em `/embed/<name>` não carrega.

**Diagnóstico.** URL tipo `https://synapse.example.com/d/brave-dolphin-1060/` funciona server-to-server mas browsers no iframe batem em Mixed Content / cross-origin. Deployment precisa de wildcard ou custom domain.

**Fix.**

**Opção A — wildcard:**

```bash
# DNS: A record wildcard  *.synapse.example.com  → <ip-do-vps>
./setup.sh --reconfigure --base-domain=synapse.example.com
```

**Opção B — custom domain por deployment:**

Dashboard → deployment → Custom domains → Add → digita `convex.seu-app.com`, configura `CNAME`/`A` no DNS, clica Verify.

## `synapse status` mostra chip vermelho `no-domain`

**Sintoma.** `synapse status` mostra chip vermelho `no-domain` na linha do deployment.

**Diagnóstico.** Mesma causa do banner laranja — URL no formato proxy legado `/d/<name>/`.

**Fix.** Mesma coisa acima — reconfigure com `--base-domain` ou adiciona custom domain.

## `synapse deploy` diz "No prod deployment saved"

**Sintoma.** `synapse deploy` falha com "No prod deployment saved for this project".

**Diagnóstico.**

```bash
cat .synapse/project.json
```

`prodDeploymentName` faltando ou `null`.

**Fix.** Cria prod deployment no dashboard, depois:

```bash
synapse select
synapse deploy
```

## `synapse open` abre página quebrada

**Sintoma.** `synapse open` abre browser em URL que 404 ou não carrega.

**Diagnóstico.** Antes da v1.8.1 o CLI montava URL errado. Confere versão: `synapse --version`.

**Fix.**

```bash
npm install -g @iann29/synapse@latest    # >= 1.8.1
synapse open
```

## Auto-update falha no meio do upgrade

**Sintoma.** Dialog do dashboard fica em `polling` e depois vira `failed`, ou a página nunca recarrega depois de `rebooting`.

**Diagnóstico.** SSH no VPS:

```bash
journalctl -u synapse-updater --no-pager -n 200
ls -lt /var/log/synapse-updater/
sudo tail -n 200 /var/log/synapse-updater/<latest>.log
sudo cat /var/lib/synapse-updater/status.json
sudo tail -n 100 /opt/synapse/upgrade.log
```

Suspeitos comuns: `compose up --build` falhou (procura `[FATAL]`), health check expirou em 180s, rollback de imagem disparado.

**Fix.**

```bash
./setup.sh --status
./setup.sh --upgrade --force
# Se ainda quebrado:
LATEST_BACKUP=$(ls -t /opt/synapse/backups/*.tar.gz | head -n1)
./setup.sh --restore="$LATEST_BACKUP"
```

Se o lock do daemon ficou órfão:

```bash
sudo rm /var/lib/synapse-updater/upgrade.lock
sudo systemctl restart synapse-updater
```

## Operador não consegue logar mas outros membros do team conseguem

**Sintoma.** Um usuário específico autentica mas `/v1/admin/version_check` devolve 403 pra ele; outros admins do mesmo team funcionam.

**Diagnóstico.** Instance-admin é flag per-usuário, separada de roles de team:

```bash
docker exec synapse-postgres psql -U synapse -d synapse -c \
  "SELECT id, email, is_instance_admin FROM users ORDER BY created_at;"
```

O primeiro usuário registrado é promovido auto; admins de team NÃO herdam.

**Fix.** Promove à mão:

```bash
docker exec synapse-postgres psql -U synapse -d synapse -c \
  "UPDATE users SET is_instance_admin = true WHERE email = 'ops@example.com';"
```

## Deployment HA travado em provisioning

**Sintoma.** Novo HA fica em "provisioning" ou "queued" sem mover.

**Diagnóstico.**

```bash
./setup.sh --logs=synapse --tail=200 | grep -E 'provisioner|advisory|HA|ha_'
docker exec synapse-postgres psql -U synapse -d synapse -c \
  "SELECT id, kind, status, last_error, attempts, created_at
     FROM provisioning_jobs
    WHERE status IN ('queued','running','failed')
    ORDER BY created_at DESC LIMIT 10;"
./setup.sh --status | grep -E 'backend-postgres|minio'
```

Suspeitos: `--enable-ha` no install mas profile `ha` inativo, `SYNAPSE_BACKEND_POSTGRES_URL`/`SYNAPSE_BACKEND_S3_*` vazios no `.env`, contenção de advisory-lock.

**Fix.**

```bash
./setup.sh --upgrade --force
```

Job específico travado:

```bash
docker exec synapse-postgres psql -U synapse -d synapse -c \
  "UPDATE provisioning_jobs SET status='failed', last_error='manual reset'
    WHERE id='<job-id>' AND status='running';"
```

## Caddy não consegue cert

**Sintoma.** URL é `https://<dep>.<base>` mas browser mostra falha TLS ou `ERR_CONNECTION_REFUSED`. Custom domain fica em "pending verification" pra sempre.

**Diagnóstico.**

```bash
# 1. DNS
dig +short '<deployment>.<base-domain>'
curl -s https://api.ipify.org

# 2. tls_ask gate
curl -i "http://localhost:8080/v1/internal/tls_ask?domain=<deployment>.<base-domain>"
# 200 = OK; 404 = hostname desconhecido; 403 = deleted

# 3. Logs do Caddy
./setup.sh --logs=caddy --tail=200 | grep -E 'on-demand|tls|certificate|<base-domain>'
```

Suspeitos: A record wildcard `*.<base>` faltando ou apontando errado; `<deployment>.<base>` não casa com nenhuma linha não-deletada; Let's Encrypt rate-limited (5 falhas por conta/hostname/hora).

**Fix.**

```bash
# Conserta DNS no provider, depois re-prova.
# Se tls_ask 404 mas deployment existe:
docker compose -f /opt/synapse/docker-compose.yml restart synapse
# Se API alcançável mas Caddy não pega cert:
docker compose -f /opt/synapse/docker-compose.yml exec caddy \
  caddy reload --config /etc/caddy/Caddyfile
```

Pra recuperar de rate-limit do Let's Encrypt, espera (mínimo 1 hora).

## HTTP actions dão 404 (login do Better Auth / webhooks falham)

Sintoma: queries e mutations funcionam, mas `/api/auth/*` (Better Auth),
webhooks ou callbacks `/engine/*` retornam **404** no navegador, mesmo
com o deployment saudável.

Causa: HTTP actions são servidas no **site proxy** do backend Convex
(porta 3211), não no listener cloud (3210). Se o seu cliente aponta o
`NEXT_PUBLIC_CONVEX_SITE_URL` pra URL cloud, essas requests de caminho
natural batem na 3210 — onde HTTP actions só existem sob `/http/` — e
dão 404.

Correção:

```bash
# 1. O card do deployment mostra a "HTTP Actions URL" real — ela tem que
#    ser o host *.site.<base> (ou um domínio customizado role='site'),
#    NÃO a URL cloud. Rode `synapse select` de novo pro .env.local pegar
#    o NEXT_PUBLIC_CONVEX_SITE_URL distinto.
synapse select

# 2. O modo base-domain precisa de um SEGUNDO registro A wildcard:
#    *.site.<BASE_DOMAIN> -> <ip-do-vps>   (ao lado de *.<BASE_DOMAIN>)

# 3. Se o CONVEX_SITE_ORIGIN estiver desatualizado dentro do container
#    (deployment criado antes do release de site-origin, OU um domínio
#    role='site' que auto-verificou num build pré-v1.12.1), RECRIE — um
#    Restart só dá bounce no mesmo container e mantém o env antigo, então
#    NÃO reassa. Recrie via: deletar + re-adicionar o domínio site (a
#    ativação reassa), ou rotacionar a deploy key (também recria). A CLI
#    v1.12.1 re-afirma o NEXT_PUBLIC_CONVEX_SITE_URL depois de cada
#    `synapse dev|deploy`, então o .env.local fica correto de qualquer
#    forma — mas o origin do Better Auth dentro do container ainda precisa
#    do rebake.
```

Contexto + o modelo completo (duas portas 3210/3211):
`docs/CONVEX_SITE_ORIGIN.md` no repo.
