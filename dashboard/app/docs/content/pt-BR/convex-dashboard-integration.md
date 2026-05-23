# O Convex Dashboard, embedado

O Convex Dashboard (data tables, editor de funções, painel de logs, schedules, files, history, schema view, settings) **não é forkado** pelo Synapse. A gente roda a imagem oficial upstream e faz iframe dela dentro do Synapse Dashboard, já autenticada contra o deployment certo.

## Por que isso funciona

Todo deployment do Synapse roda o **mesmo container do Convex backend** que o Convex Cloud — `ghcr.io/get-convex/convex-backend`. A imagem upstream do Convex Dashboard, `ghcr.io/get-convex/convex-dashboard`, foi feita pra falar com esse backend usando uma admin key. Ela não sabe e não se importa se o backend foi provisionado pelo "Big Brain" do Cloud ou pelo Synapse.

A integração se reduz a: colocar a imagem do dashboard upstream na frente do operador, entregar a admin key + URL do deployment, sair do caminho.

## A rota `/embed/<name>`

O Synapse Dashboard traz uma casca fina em `/embed/<name>` (source: `dashboard/app/embed/[name]/page.tsx`). Ela:

1. Busca o registro do deployment via `GET /v1/deployments/<name>` (pra projectId, type, status).
2. Busca credenciais via `GET /v1/deployments/<name>/auth` (adminKey, deploymentUrl).
3. Renderiza header fino (40px) com breadcrumbs + **deployment picker pill** + escape hatch "Refresh credentials".
4. Renderiza `<iframe>` apontando pra `NEXT_PUBLIC_CONVEX_DASHBOARD_URL` (default `http://localhost:6791`; produção `https://<host>:6791`).
5. Escuta o handshake `postMessage` do upstream.

Operadores chegam aqui pelo botão "Open dashboard" em qualquer linha de deployment.

## O handshake `postMessage`

O dashboard upstream roda inteiramente no client. No mount ele faz `postMessage` pra janela pai:

```js
parent.postMessage({ type: "dashboard-credentials-request" }, "*")
```

A página `/embed/<name>` responde:

```js
iframe.contentWindow.postMessage({
  type: "dashboard-credentials",
  adminKey: auth.adminKey,
  deploymentUrl: auth.deploymentUrl,
  deploymentName: auth.deploymentName,
}, CONVEX_DASHBOARD_ORIGIN)
```

A resposta usa o origin exato do iframe como `targetOrigin` — um `NEXT_PUBLIC_CONVEX_DASHBOARD_URL` mal configurado não vaza credenciais. O upstream cacheia as credenciais no localStorage dele.

O operador cai na UI de data / functions / logs **já autenticado**. Sem etapa de "cole sua admin key".

## O sidecar Caddy — `convex-dashboard-proxy`

A imagem upstream serve com headers de segurança default que bloqueiam iframe:

- `X-Frame-Options: SAMEORIGIN`
- `Content-Security-Policy: frame-ancestors 'self'`

O Synapse roda um sidecar Caddy (`convex-dashboard-proxy`) cujo único trabalho é tirar esses dois headers de toda resposta. Sem o sidecar o iframe carrega mas renderiza branco.

O Caddy também coloca a porta `<host>:6791` atrás do mesmo cert TLS do resto da instalação.

## O escape hatch "Refresh credentials"

Se o dashboard upstream mostra "deployment URL or admin key is invalid" (tipicamente depois de rotação de key em outra aba), o operador clica em **Refresh credentials**. Por baixo:

1. `POST /v1/deployments/<name>/reissue_admin_key` minta nova admin key — sem rotação de container, deploy keys existentes continuam.
2. `authNonce` incrementa no state.
3. A `key` do iframe inclui `authNonce`, forçando React a unmount + remount.
4. O mount novo dispara novo handshake.

## O banner de URL inalcançável

Quando o URL cai pro formato `<host>:<porta-dinâmica>` (sem wildcard, sem custom domain), o Caddy não coloca TLS naquela porta — o handshake falharia em silêncio com "admin key invalid".

Em vez de deixar o operador caçar erro falso de auth, `/embed/<name>` troca o iframe por um banner âmbar nomeando a causa real e listando as duas correções (wildcard subdomain ou custom domain por deployment).

## O deployment picker no header

Source: `dashboard/components/DeploymentPicker.tsx`. Pílula verde acima do iframe pra trocar entre deployments do mesmo projeto sem sair do embed.

**Visual.** Pílula com cor por tipo: Production → verde, Development → azul, Preview → laranja, Custom → neutro. Dot menor de status (running / provisioning / failed / stopped) ao lado.

**Dropdown.** Clica (ou aperta `/`) pra abrir menu de 320px. Seções agrupadas por tipo: Production → Development → Preview → Custom. Dentro de cada, default-flagged primeiro, depois mais novo. Cada item mostra nome (monoespaçado), dot de status, badge "default", hint `visited Nm ago`.

**Atalhos** (com mais de um deployment):

- **Ctrl+Alt+1** → primeiro deployment de Production
- **Ctrl+Alt+2** → primeiro deployment de Development
- **`/`** → abre o dropdown

No menu aberto: **↑ / ↓**, **Enter**, **Escape**.

**Busca.** Quando há 6+ deployments, dropdown ganha filter input. Casa por nome OU tipo OU reference, case-insensitive.

**Como a troca acontece.** Navegação da página pai, não swap dentro do iframe:

```ts
router.push(`/embed/${encodeURIComponent(newName)}`)
```

A `key` do iframe inclui o nome, então React faz unmount + remount. Trade-off vs swap de credenciais dentro do iframe: ~1s de reload por troca em vez de instantâneo. Aceitamos pra não forkar a imagem upstream.

## Endpoint reservado pra Strategy B

Pra um futuro "picker dentro do iframe" (Strategy B), o Synapse já expõe:

```
GET /v1/internal/list_deployments_for_dashboard?token=<PAT-curto>
→ 200 { deployments: [{ name, url, adminKey }, …] }
```

Source: `synapse/internal/api/dashboard_proxy.go`. Não fomos por esse caminho ainda — o overlay picker (Strategy E) é bom o bastante. Endpoint shipped, auditado, reservado.

## Por que paridade de features sai automática

O dashboard upstream cuida de data tables, editor de funções, painel de logs, schedules, files, history, schema view, settings — tudo falando direto com o backend usando a admin key que o Synapse entregou. **O Synapse contribui zero código de feature pra qualquer dessas páginas.** Upstream ship feature nova → a gente pega só bumpando a tag — sem fork, sem rebase tax.

O Synapse é dono do *control plane* (teams / projects / ciclo de vida multi-deployment); o Convex Dashboard upstream é dono do *data plane* (tudo dentro de um deployment). O iframe + handshake postMessage é a costura.
