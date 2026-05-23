# Auto-update pelo dashboard

O Synapse consegue se atualizar in-place pelo dashboard sem o operador precisar dar SSH. Esta página explica como isso funciona ponta a ponta.

## O que o operador vê

O componente `UpdateBanner` (`dashboard/components/UpdateBanner.tsx`) faz polling de `GET /v1/admin/version_check` uma vez por hora. Quando a API responde `updateAvailable: true`, um banner amber aparece no topo de `/teams/<ref>` com "Synapse vX.Y.Z is available — you're on vA.B.C".

Duas ações: **Review & upgrade** abre o dialog; **Dismiss** persiste a versão nova em `localStorage["synapse-update-dismissed"]`.

Permissões: quando `/version_check` devolve 401 ou 403, o banner não renderiza nada.

## Honestidade tier-1: quem é "admin"?

A checagem é `users.is_instance_admin = true` (middleware `requireInstanceAdmin` em `synapse/internal/api/admin.go`). O primeiro usuário registrado depois do install é promovido auto; admins de team não herdam instance-admin. Promover outros é update SQL manual em `users.is_instance_admin`.

## Version check: fetch cacheado do GitHub

`GET /v1/admin/version_check` devolve:

```json
{
  "current": "1.10.0",
  "latest": "1.10.1",
  "updateAvailable": true,
  "releaseUrl": "https://github.com/Iann29/convex-synapse/releases/tag/v1.10.1",
  "releaseNotes": "...",
  "publishedAt": "2026-05-21T...",
  "fetchedAt": "2026-05-22T...",
  "cacheExpiresAt": "2026-05-22T...",
  "fromCache": false
}
```

O backend faz fetch de `https://api.github.com/repos/Iann29/convex-synapse/releases/latest` uma vez a cada 15 minutos. Dashboard polling de hora em hora + rate limit GitHub sem auth (60 req/hora) → instância única bem abaixo do teto.

`POST /v1/admin/version_check/refresh` invalida o cache (rate-limited a uma invalidação por 30s). Pre-releases e drafts ignorados. Comparação semver via `golang.org/x/mod/semver`.

## A atualização em si

Quando o operador clica **Continue → Upgrade now**, dashboard manda POST pra `/v1/admin/upgrade`. A API:

1. Probe `/healthz` no daemon (timeout 2s). Inacessível → `503 updater_unreachable`.
2. Forwarda body (`{"ref": "..."}`) ao daemon em `POST <UpdaterURL>/upgrade` com `Authorization: Bearer <UpdaterToken>`.
3. Re-empacota erros do daemon (`{"error": "..."}`) em `{"code", "message"}`. Comuns: `upgrade_in_progress` (409), `invalid_ref` (400), `invalid_json` (400).
4. Registra audit `upgradeStarted` com `metadata.ref` + `metadata.currentVersion`.

O dialog entra em polling e bate em `/v1/admin/upgrade/status` a cada 2.5s. Enquanto upgrade está `running`, daemon recarrega o tail do log no request — dashboard vê streaming sem server push.

### Reload no restart do synapse-api

O container synapse-api é recriado durante upgrade — nesse ponto polls de `/status` falham. Depois de **3 falhas consecutivas**, dialog vira `rebooting` e mostra "Synapse API is restarting; the page will reload automatically (~90s)". `setTimeout` chama `window.location.reload()` em 90s.

`sessionStorage["synapse-upgrade-in-progress"]` é setado quando o operador confirma; reload da página detecta o marker e retoma polling. Markers velhos (>30 min) auto-limpos.

Estados finais: `success` → "✓ Synapse upgraded" verde com botão de reload; `failed` → banner vermelho apontando `./setup.sh --doctor`.

## Arquitetura: o daemon synapse-updater

A peça que orquestra o upgrade vive **fora** do docker compose, num daemon Python 3 pequeno:

- **Binário:** `/usr/local/bin/synapse-updater` (instalado por `phase_install_updater` em `installer/install/updater.sh`)
- **Unit:** `/etc/systemd/system/synapse-updater.service`
- **Source:** `installer/updater/synapse-updater`

### Por que fora do docker compose

`setup.sh --upgrade` roda `docker compose up -d --build`, que recriaria o próprio updater se ele estivesse no compose — matando o processo que orquestra. Vivendo no host como systemd unit, o updater sobrevive ao rebuild que ele dispara.

### Por que TCP localhost + bearer token (não unix socket)

Antes da v1.5.1 o daemon escutava em `/run/synapse/updater.sock` com bind-mount. Dois problemas: `/run` é tmpfs (limpado no boot, quebrava bind-mount); bind-mounts pinam ao inode (não sobrevivem a restart do daemon).

O design TCP-localhost+bearer-token contorna o ciclo de vida de bind-mount inteiro. API Synapse fala via `host.docker.internal:8089`. A unit bind `0.0.0.0` (NÃO `127.0.0.1`) — `host.docker.internal` dentro do container resolve pro IP da bridge docker (tipicamente `172.17.0.1`).

O firewall do cloud provider PRECISA bloquear porta 8089 da internet pública. Bearer token é defesa em profundidade.

### Endpoints

Todos exigem `Authorization: Bearer <SYNAPSE_UPDATER_TOKEN>`:

| Método | Path | Propósito |
|---|---|---|
| GET | `/healthz` | `{"ok": true}` |
| GET | `/version` | Lê `$INSTALL_DIR/VERSION`, cai pra `git describe`, depois `unknown` |
| GET | `/status` | Último estado conhecido. Enquanto running, recarrega tail no request |
| POST | `/upgrade` | `{"ref": "v1.2.0"}` (opcional). 202 inicia; 409 se já rodando |
| POST | `/reconfigure_host_domain` | `{"jobId", "domain"?, "baseDomain"?, "plainHttp"?, "acmeEmail"?}` |

### Arquivos de estado

```
/var/lib/synapse-updater/status.json              último estado conhecido
/var/lib/synapse-updater/upgrade.lock             enquanto upgrade roda
/var/lib/synapse-updater/reconfigure.lock         enquanto reconfigure roda
/var/log/synapse-updater/<UTC>.log                log completo do último upgrade
/var/log/synapse-updater/reconfigure-<UTC>.log    log completo do último reconfigure
```

Os locks são fonte de verdade pro gate single-flight.

### Flag `SYNAPSE_UPDATER_NO_RESTART=1`

Quando daemon forka `setup.sh --upgrade`, seta `SYNAPSE_UPDATER_NO_RESTART=1` no env do filho. `phase_install_updater` checa e **pula** `systemctl restart synapse-updater` — senão o daemon se mata no meio.

Binário em disco é atualizado mesmo assim; operador roda `systemctl restart synapse-updater` à mão depois do upgrade pra carregar mudanças.

### Rodando como root

`User=root` na unit. Notavelmente **sem** `ProtectHome=true` — daemon forka `setup.sh` que forka `docker compose up --build` que chama `docker buildx` que cria `/root/.docker/`. Com `ProtectHome=true` o `/root` fica read-only e buildx falha.

O que ESTÁ ligado: `PrivateTmp=true`, `ProtectKernelTunables=true`, `ProtectKernelModules=true`, `ProtectControlGroups=true`, `RestrictSUIDSGID=true`, `SystemCallArchitectures=native`.

## Trilha de auditoria

Todo upgrade pelo dashboard grava `upgradeStarted` em `audit_events`:

```json
{
  "action": "upgradeStarted",
  "target_type": "synapse",
  "actor_id": "<user-uuid>",
  "metadata": {
    "ref": "v1.10.1",
    "currentVersion": "1.10.0"
  }
}
```

`upgradeStarted` captura "o operador apertou o botão". O exit code real do setup.sh fica no `status.json` do daemon e no arquivo de log por run — não há linha `upgradeSucceeded` separada.
