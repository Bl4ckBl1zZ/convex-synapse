# Domínios personalizados

O Synapse expõe os deployments Convex provisionados em URLs que sua CLI, seu navegador e o dashboard embutido conseguem alcançar via HTTPS. Dois modos de roteamento convivem lado a lado, e uma terceira forma legada baseada em path continua disponível como fallback:

| Forma | Exemplo | Quando entra |
|---|---|---|
| `custom` | `https://api.cliente.com` | Existe uma linha de domínio customizado ativa para este deployment |
| `wildcard` | `https://brave-dolphin-1060.app.synapsepanel.com` | `SYNAPSE_BASE_DOMAIN` está setado e nenhum custom domain ganhou antes |
| `host` | `https://synapsepanel.com:3214` | Nenhum dos acima; `SYNAPSE_PROXY_ENABLED=false` |
| `path` | `https://synapsepanel.com/d/brave-dolphin-1060` | Nenhum dos acima; `SYNAPSE_PROXY_ENABLED=true` (padrão legado v0.2) |

A matriz de decisão mora em `synapse/internal/deploymenturl/url.go`. Tanto o botão "Copy URL" do dashboard quanto o endpoint `cliCredentials` da CLI passam pelos mesmos helpers `Computer.Public` / `Computer.CLI`, então o que o dashboard mostra e o que o `npx convex` conecta nunca divergem.

> A forma `path` funciona em navegador mas **quebra a CLI oficial do `npx convex`**: ela monta URLs de API com `new URL("/api/...", baseUrl)`, que descarta qualquer componente de path. Por isso `Computer.CLI` nunca emite a forma path — se nem domínio nem wildcard estiverem configurados, ela cai para `<host_da_PublicURL>:<HostPort>`.

---

## Modo A — Subdomínio wildcard do host

O admin da instância seta `SYNAPSE_BASE_DOMAIN=app.synapsepanel.com` (qualquer host que ele controle). Todo deployment existente e futuro fica então acessível em `https://<nome>.app.synapsepanel.com`.

### O que você precisa (uma vez, lado do operador)

1. **Registro A wildcard** no seu provedor de DNS:
   ```
   *.app  A  <IPv4-da-sua-VPS>
   ```
   Cloudflare: deixe o proxy status como **DNS only (nuvem cinza)**. Nuvem laranja termina TLS sozinho e contorna nosso gate `tls_ask`.
2. **Email de contato ACME** (`ACME_EMAIL` no `.env`) — o Let's Encrypt manda avisos de renovação aqui.
3. **Bloco Caddyfile do wildcard.** `setup.sh --base-domain=app.synapsepanel.com` anexa `installer/templates/caddy.wildcard` ao Caddyfile standalone e seta `on_demand_tls { ask http://synapse-api:8080/v1/internal/tls_ask }` no bloco global.

### UI em runtime (v1.9.0+)

O fluxo completo está exposto no dashboard em **Admin → Host domain** (`/admin/host-domain`). Numa instalação com TLS simples, a página mostra um card de sugestão; clicar em **Configure wildcard…** abre um form com preview da URL ao vivo, aplica a mudança via daemon `synapse-updater` (unix socket no host, fora do docker compose) e faz streaming do status do job pra UI. Veja `docs/HOST_DOMAIN_WILDCARD.md` pro passo a passo detalhado.

### Preflight de DNS (`setup.sh`)

`installer/install/preflight.sh::check_base_domain` consulta um subdomínio sintético aleatório, tipo `synapse-probe-7f3a.<base>`. A aleatoriedade dribla cache de DNS:

- Vazio / NXDOMAIN → warn "wildcard não resolve" (instalação continua).
- Resolve pra um IP diferente → warn "wildcard aponta pra X, este host é Y".
- Resolve pro IP público do host → verde "wildcard OK".

Falhas são warnings, não bloqueios — o operador pode corrigir DNS depois da instalação e o wildcard começa a funcionar assim que propagar.

### Gate de emissão de TLS

A diretiva `tls { on_demand }` do Caddy pergunta pro Synapse antes de emitir um certificado. O endpoint é **público, sem auth**, servido em `GET /v1/internal/tls_ask?domain=<host>` e implementado em `synapse/internal/api/tls_ask.go`:

- O host precisa ser `<sub>.<BASE>` (case-insensitive).
- `<sub>` não pode ter pontos (sub multi-label → 403).
- Um deployment chamado `<sub>` precisa existir com `status <> 'deleted'`.
- Cai pro ramo de custom domain (modo B) em qualquer miss.

Sem esse gate, qualquer um conseguiria disparar pedidos de cert do Let's Encrypt pra subdomínios arbitrários embaixo da sua base mandando TLS handshakes. Os rate limits salvariam eventualmente, mas a recusa explícita é mais limpa.

---

## Modo B — Domínio customizado por deployment

Use quando o wildcard não for desejável (você não quer uma base única pra tudo) ou quando um deployment específico precisar de uma marca diferente (`api.cliente.com` por tenant). Os dois modos coexistem; a linha de custom domain ganha do wildcard pra aquele deployment.

### Superfície da API

Todas as rotas vivem em `/v1/deployments/{name}/domains`. Os gates de auth usam os mesmos helpers `loadDeploymentForRequest` + `canEditProject` do resto da superfície de deployments — viewers não gerenciam domínios.

```bash
# Listar
curl -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/domains

# Adicionar
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"domain":"api.cliente.com","role":"api"}' \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/domains

# Verificar (re-roda checagem de DNS)
curl -X POST -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/domains/<id>/verify

# Auto-configurar via credencial Cloudflare salva (só instance admin)
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"credentialId":"<uuid>"}' \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/domains/<id>/auto_configure

# Deletar
curl -X DELETE -H "Authorization: Bearer $JWT" \
  https://synapsepanel.com/v1/deployments/brave-dolphin-1060/domains/<id>
```

### Role: `api` vs `dashboard`

A coluna `role` em `deployment_domains` seleciona pra onde o proxy encaminha (veja `proxy.go::Handler`):

- **`api`** — encaminha pro container do backend Convex do deployment. Queries, mutations e HTTP actions caem aqui. Este é o role que participa da classificação de URL (`active custom domain api` ganha do `BaseDomain` em `Computer.Public` / `Computer.CLI`).
- **`dashboard`** — encaminha pra `Resolver.DashboardAddr` (sidecar `convex-dashboard-proxy`). Permite frontear a UI do Convex Dashboard embutido no seu próprio domínio de marca.

### Schema (`migration 000012_deployment_domains`)

```sql
CREATE TABLE deployment_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    domain CITEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('api', 'dashboard')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'failed')),
    dns_verified_at TIMESTAMPTZ,
    last_dns_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (domain)
);
```

A constraint `UNIQUE (domain)` garante que um hostname só possa apontar pra um deployment em toda a instância.

### Ciclo de vida de status

- `pending` — acabou de ser registrado, esperando a primeira verificação de DNS, ou o resolver ainda não consegue ver o registro (NXDOMAIN / timeout / SERVFAIL). É um veredicto **transiente**; o loop verificador re-tenta a cada 15s.
- `active` — um registro A retornado bate com `SYNAPSE_PUBLIC_IP`. TLS e roteamento liberados.
- `failed` — o resolver retornou registros A mas **nenhum** bateu com o IP esperado. Miss determinístico (nuvem laranja, host errado, etc.). O operador precisa corrigir o registro DNS.

Se `SYNAPSE_PUBLIC_IP` não estiver setado no host, toda linha fica `pending` com `last_dns_error` carregando o prefixo exato `SYNAPSE_PUBLIC_IP not configured…`. O `CustomDomainsPanel` do dashboard faz pattern-match nesse prefixo pra mostrar um único banner amarelo, em vez de repetir o erro longo em cada linha.

### Painel do dashboard (`CustomDomainsPanel.tsx`)

Montado por deployment, embaixo de "Manage custom domains". Recursos:

- Detecção de provider ao vivo (debounce de 500ms). Quando o Cloudflare é detectado e o caller é instance admin com uma credencial CF salva cobrindo a zona, o form oferece um toggle **"Auto-configure with Cloudflare"** que faz upsert do registro A via token salvo no momento do create.
- Botão **Auto-configure DNS** por linha pra re-tentar em linhas adicionadas antes de uma credencial existir.
- **Verify** (força novo lookup de DNS) e **Remove** por linha.
- Badges de status com tempo relativo `verified Xm ago`.

### Como o proxy faz match por Host header

`proxy.go::Handler` roda três regras de dispatch em ordem, a cada request:

1. **Subdomínio wildcard** (modo A) — `matchHostSubdomain(r.Host, baseDomain)` retorna o label mais à esquerda quando `r.Host == "<sub>.<base>"`. Subdomínio vazio ou multi-label cai pra próxima regra.
2. **Custom domain** (modo B) — `Resolver.ResolveDomain` busca o Host inteiro em `deployment_domains` onde `status='active'`. Cache é por host com o mesmo TTL do cache de nome de deployment (default 30s); `InvalidateDomain` remove um host imediatamente após add/delete/verify.
3. **Fallback de path** — `/d/{name}/{rest}` é extraído da URL path. É o contrato v0.2 — todo operador com `SYNAPSE_PROXY_ENABLED=true` tem isso, independente da config de domínio.

Quando `role='dashboard'` bate, a request pula `ResolveAll` inteiro e vai direto pra `Resolver.DashboardAddr`. O failover de réplica HA só se aplica pra `role='api'`.

### Bloco Caddy pra custom domains (catch-all)

`installer/templates/caddy.standalone` termina com um catch-all `:443` que aceita qualquer host de entrada não reivindicado por um bloco mais específico, gata a emissão pelo `tls_ask` e encaminha pra `synapse-api:8080`. O proxy do Synapse então re-roteia por Host header. A regra "longest-match" do Caddy faz com que seu `{{DOMAIN}}` principal e o bloco wildcard opcional sempre ganhem pra os hosts que cobrem.

---

## Legado: roteamento por path (`/d/{name}/*`)

Sempre ativo enquanto `SYNAPSE_PROXY_ENABLED=true`. URLs como `https://synapsepanel.com/d/brave-dolphin-1060/version` reverse-proxiam pro container do backend no caminho `/version`. É o contrato v0.2 e precede tanto o modo wildcard quanto o de custom domain.

Funciona em navegador mas **não funciona com a CLI oficial do `npx convex`** — o URL builder descarta o componente de path. Se você ficar preso nessa forma, o `synapse select` vai emitir URLs em formato `host:port` em vez de path, o que significa que sua porta dinâmica de backend precisa ser publicamente alcançável. A maior parte dos defaults de firewall de VPS bloqueia isso.

A solução é habilitar o modo A ou o modo B.
