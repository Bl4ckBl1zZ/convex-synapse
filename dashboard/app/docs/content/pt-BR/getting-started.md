# Primeiros passos

Synapse e um control plane open-source para Convex self-hosted. Ele reimplementa a parte publica da API de gerenciamento "Big Brain" do Convex Cloud — times, projetos, deployments, variaveis de ambiente, audit log, login da CLI — em cima de uma infraestrutura sua. Uma VPS, um `setup.sh`, e voce tem um dashboard que provisiona containers Convex de verdade em poucos segundos.

Esta pagina e a unica que voce precisa ler pra subir uma instalacao funcional.

## Pre-requisitos

Synapse roda em uma unica VPS Linux. O pre-flight do instalador (`installer/install/preflight.sh`) checa o seguinte e aborta se algum requisito obrigatorio estiver faltando:

| Requisito | Minimo | Observacoes |
|---|---|---|
| SO | Debian / Ubuntu / Fedora / RHEL | Arch, Alpine, openSUSE rodam com aviso amarelo |
| Arquitetura | `amd64` ou `arm64` | A imagem do Convex backend so e publicada pra essas |
| Docker | 20.10+ | O instalador se oferece pra rodar `curl -fsSL https://get.docker.com \| sh` |
| Docker Compose | plugin v2 | O `docker-compose` v1 legado nao e suportado |
| RAM | 2 GB | 1–2 GB e warning; abaixo de 1 GB falha |
| Disco | 10 GB livres em `/` | Ajustavel via `SYNAPSE_DISK_GB_MIN` |
| Sudo / root | Obrigatorio | Pra subir containers e (opcionalmente) editar Caddyfile do host |
| Saida pra internet | `ghcr.io` alcancavel | A imagem do backend tem ~150 MB e mora la |
| Portas | 80, 443 (com `--domain`); 8080 (API), 6790 (dashboard), 6791 (UI do Convex) sem TLS | Tudo configuravel via env var |

Dominio registrado e **opcional** — da pra instalar sem TLS via `--no-tls` e acessar o dashboard em `http://<ip-publico>:6790`. Pra qualquer coisa proxima de producao, aponte um hostname real pra maquina antes.

## One-liner hospedado (modo wizard)

Rode isso em uma VPS limpa. Sem flags, o instalador entra num walkthrough interativo de 4 etapas (`installer/install/wizard.sh`) cobrindo dominio + TLS, modo de deployment, diretorio de instalacao e dependencias faltando.

```bash
curl -sSf https://raw.githubusercontent.com/Iann29/convex-synapse/main/setup.sh | bash
```

O wizard le de `/dev/tty` pra funcionar sob `curl | bash` (onde o stdin e o proprio script, nao o seu teclado). Menus numerados — nada de seta, roda em qualquer shell.

Se faltar Docker, o wizard oferece instalar via `get.docker.com` antes do pre-flight rodar.

## One-liner hospedado (nao-interativo, com flags)

Pula o wizard passando qualquer flag de modo. Argumentos vao depois de `bash -s --`:

```bash
# VPS unica com TLS via Caddy + Let's Encrypt
curl -sSf https://raw.githubusercontent.com/Iann29/convex-synapse/main/setup.sh \
  | bash -s -- --domain=synapse.example.com

# So local / lab, sem TLS
curl -sSf https://raw.githubusercontent.com/Iann29/convex-synapse/main/setup.sh \
  | bash -s -- --no-tls --skip-dns-check --non-interactive
```

Sob `curl | bash`, o script percebe que a pasta `installer/` nao esta ao lado dele e se auto-clona em `/tmp/convex-synapse-bootstrap-<pid>` (ou `~/.synapse-bootstrap-<pid>` se `/tmp` nao for gravavel), e se re-executa de la. Toda flag que voce passou e preservada.

## Flags que valem conhecer

A lista completa esta em `setup.sh --help`; abaixo so o subset de instalacao:

| Flag | O que faz |
|---|---|
| `--domain=<host>` | Hostname publico do Synapse. Caddy emite cert do Let's Encrypt automaticamente. Obrigatorio em modo nao-interativo com TLS. |
| `--base-domain=<host>` | Subdominio wildcard pra URLs por deployment (`<name>.<base>`). Exige `*.<host>` apontado pra VPS; o Caddy emite cert sob demanda na primeira request. |
| `--acme-email=<addr>` | Email da conta Let's Encrypt. Default `admin@<domain>`. |
| `--no-tls` | Pula Caddy / TLS. Use quando outro ingress for fronte do Synapse ou em ambientes de lab. |
| `--skip-dns-check` | Pula a checagem de A-record contra IP publico no pre-flight. Util enquanto o DNS nao propagou. |
| `--enable-ha` | Sobe o Postgres + MinIO embarcados pra deployments HA funcionarem out-of-the-box. |
| `--install-dir=<path>` | Sobrescreve `/opt/synapse`. Toda lifecycle command posterior respeita esse mesmo caminho. |
| `--non-interactive` | Desliga todos os prompts. Combine com `--domain=` ou `--no-tls`. |
| `--no-bootstrap` | Pula o re-exec do auto-clone. Util quando voce ja fez `git clone` manual. |

As flags `--upgrade`, `--backup`, `--restore`, `--reconfigure`, `--uninstall`, `--logs`, `--status` e `--doctor` sao do ciclo pos-instalacao e ficam documentadas separadamente.

## O que o instalador faz, fase por fase

Cada fase carrega um `CURRENT_STEP`; se algo crashar, o trap de erro mostra qual fase morreu e onde esta o log completo. A ordem (`setup.sh::main`):

1. **`wizard`** — so quando nao veio nenhuma flag de modo; coleta dominio, TLS, modo e diretorio interativamente.
2. **`autoinstall_docker`** — roda o `get.docker.com` quando o wizard concordou (ou em modo nao-interativo root com Docker ausente).
3. **`preflight`** — todas as checagens do `installer/install/preflight.sh`. Roda tudo mesmo apos falha pra voce ver todos os problemas de uma vez.
4. **`install_deps`** — instala `jq`, `curl` e `dig` via package manager do host quando faltarem (apt/dnf/pacman/apk).
5. **`install_dir`** — cria `INSTALL_DIR` (default `/opt/synapse`) e copia o repo pra dentro.
6. **`secrets`** — gera JWT, senha do Postgres e token do updater; renderiza `installer/templates/env.tmpl` em `.env` (modo `0600`). Idempotente em re-execucoes: segredos existentes sao preservados.
7. **`install_updater`** — instala o daemon `synapse-updater` (Python 3) como unit systemd, pra que a upgrade de um clique no dashboard consiga rebuildar a stack depois.
8. **`caddy`** — detecta se ja existe Caddy ou nginx no host. Se Caddy, anexa um bloco gerenciado no `/etc/caddy/Caddyfile` (com backup do antigo). Se nada, escreve um `Caddyfile` standalone e liga o profile `caddy` no compose. Hosts com nginx recebem snippet impresso pra colar manualmente.
9. **`compose_up`** — `docker compose up -d --build` (mais `--profile caddy` e/ou `--profile ha` quando aplicavel), espera ate 60 s pelo `/health`, e pre-puxa a imagem fixada do Convex backend pra que o primeiro create-deployment nao trave em um pull frio de ~150 MB.
10. **`verify`** — roda um self-test register → team → project → deployment contra a API. Depois que passa, o instalador faz TRUNCATE na tabela `users` pro wizard de primeira execucao do dashboard disparar quando voce abrir o navegador. Use `SYNAPSE_VERIFY_KEEP=1` pra preservar o admin do teste.
11. **`success`** — imprime banner verde com a URL pra abrir e cheat sheet de comandos.

A saida do instalador inteiro e teeada pra `/tmp/synapse-install.log` (ou o caminho em `SYNAPSE_INSTALL_LOG`).

## Pos-instalacao — abrindo o dashboard

O banner final mostra a URL. Resolvida nessa ordem:

- `--domain=<host>` definido → `https://<host>` (Caddy fronteia dashboard, API e UI do Convex).
- Sem dominio mas IP publico detectado → `http://<ip-publico>:6790`.
- Nenhum dos dois → `http://localhost:6790` (modo lab; navegadores remotos vao falhar porque o JS embutido fala com a API no host que voce abriu).

Ao abrir a URL voce cai em `/login`. A pagina primeiro chama `GET /v1/install_status` (probe publico, sem auth, em `synapse/internal/api/install_status.go`). Quando a resposta e `{"firstRun": true, "version": "..."}` o dashboard redireciona pra `/setup` e inicia o wizard de primeira execucao:

1. Loading.
2. Cria o admin (`POST /v1/auth/register`).
3. Sobe um team `Default` e um projeto `demo` com um deployment de dev.
4. Te deixa na pagina do projeto com a linha do deployment ja visivel.

`firstRun` e true exatamente quando a tabela `users` esta vazia (um `SELECT EXISTS (SELECT 1 FROM users)` barato). A fase de verify trunca `users` apos o self-test passar — e por isso que o wizard sempre dispara em instalacao nova.

## O que aparece em disco

`INSTALL_DIR` default e `/opt/synapse` (sobrescrita com `--install-dir=`). Apos instalar:

```
/opt/synapse/
  setup.sh                 # re-executavel pra lifecycle (upgrade/backup/restore/...)
  docker-compose.yml
  .env                     # segredos gerados, modo 0600 — NAO PERCA
  Caddyfile                # so quando o Caddy embarcado e usado (sem Caddy no host)
  installer/               # a arvore de libs que o script da source
  synapse/, dashboard/, …  # o resto do repo
  backups/                 # default de saida do --backup (tarballs com timestamp)
```

O `.env` carrega todo segredo. O `--uninstall` se recusa a apagar dados sem antes fazer um backup, mas o `.env` em si e sua unica copia das credenciais JWT e Postgres — guarde-o fora da maquina se voce nao puder perder sessoes antigas.

O log do instalador fica em `/tmp/synapse-install.log` (ou `SYNAPSE_INSTALL_LOG`); audit trails por comando ficam em `$INSTALL_DIR/{upgrade,backup,restore}.log`.

## Sanity check

Depois que o wizard do dashboard termina, voce pode validar a stack inteira:

```bash
# Containers gerenciados pelo Synapse carregam essa label
docker ps --filter label=synapse.managed=true

# Health da API
curl -sf http://localhost:8080/health

# Snapshot read-only de diagnostico (containers, volumes, URL publica, TLS, disco)
sudo /opt/synapse/setup.sh --status

# Re-roda o pre-flight contra a instalacao existente, sem mexer em nada
sudo /opt/synapse/setup.sh --doctor
```

Se tudo estiver verde, acabou — crie um time, crie um projeto, clique em **New deployment** e o Synapse sobe um Convex backend novo em poucos segundos.
