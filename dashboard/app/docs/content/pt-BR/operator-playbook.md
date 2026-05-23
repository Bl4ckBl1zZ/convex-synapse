# Guia do operador — todos os modos do `setup.sh`

Esse é o guia de referência do único binário que o operador roda no VPS: `setup.sh`. Toda ação de ciclo de vida — instalar, atualizar, backup, restaurar, desinstalar, logs, status, reconfigurar — é uma flag dele.

Cada execução faz tee de stdout+stderr para `/tmp/synapse-install.log` (sobrescreva com `SYNAPSE_INSTALL_LOG`). Ações de lifecycle também escrevem trilha de auditoria por ação no install dir.

`--version` e `--help` saem sem escrever logs nem pegar o flock em `/var/lock/synapse-installer.lock`. O resto é single-instance por host.

## Instalar (primeira vez)

Dois pontos de entrada, mesmo resultado:

```bash
# A. curl|sh hospedado (não precisa de git clone)
curl -sSf https://raw.githubusercontent.com/Iann29/convex-synapse/main/setup.sh \
  | bash -s -- --domain=synapse.example.com

# B. Depois de `git clone`
./setup.sh --domain=synapse.example.com
```

Fases na ordem: `wizard` → `autoinstall_docker` → `preflight` → `install_deps` → `install_dir` → `secrets` → `install_updater` → `caddy` → `compose_up` → `verify` → `success_screen`.

Flags principais:

| Flag | O que faz |
|---|---|
| `--domain=<host>` | TLS via Caddy + Let's Encrypt; obrigatório em não-interativo |
| `--base-domain=<host>` | Subdomínios por deployment; precisa DNS wildcard |
| `--acme-email=<endereço>` | Email Let's Encrypt; default `admin@<domain>` |
| `--enable-ha` | Ativa profile `ha` do compose (backend-postgres + minio) |
| `--no-tls` | Pula Caddy |
| `--skip-dns-check` | Pula checagem A-record no preflight |
| `--non-interactive` | Sem prompts |
| `--install-dir=<path>` | Sobrescreve `/opt/synapse` |
| `--no-bootstrap` | Pula re-exec do auto-clone |

`phase_verify` roda self-test register → team → project → deployment, depois faz `TRUNCATE users CASCADE` pro wizard em `/setup` disparar. `SYNAPSE_VERIFY_KEEP=1` preserva o admin de demo.

## `--upgrade` — autodetecta latest, snapshot-rollback em falha

```bash
./setup.sh --upgrade                       # release mais recente
./setup.sh --upgrade --ref=v1.10.0
./setup.sh --upgrade --ref=feat/foo
./setup.sh --upgrade --force
```

Prioridade do ref: `--ref=` > `tag_name` de `GET https://api.github.com/repos/Iann29/convex-synapse/releases/latest` (timeout 5s) > `main`.

Fluxo: snapshot de imagens → clone do target → rsync (preserva `.env`/`Caddyfile`/`upgrade.log`) → re-exec sob código novo → `secrets::ensure_env` preenche keys novas → `phase_install_updater` atualiza daemon → pre-pull de imagens pinadas → carimba `SYNAPSE_VERSION` no `.env` ANTES do build (senão BuildKit cache-hits) → `compose up -d --build` → espera até `LIFECYCLE_HEALTH_TIMEOUT` (180s) pelo `/health`. Em falha de build/health: re-tag imagens do snapshot, restaura versão antiga, exit 2.

Trilha em `$INSTALL_DIR/upgrade.log`.

## `--backup` — local + S3 opcional

```bash
./setup.sh --backup
./setup.sh --backup --out=/var/backups/synapse-2026-05.tar.gz
./setup.sh --backup --exclude-env
./setup.sh --backup --to-s3=s3://meu-bucket/synapse/
```

Output default: `$INSTALL_DIR/backups/synapse-backup-<UTC>.tar.gz`. Formato `synapse-backup-v1`:

```
manifest.txt              format=synapse-backup-v1, timestamp, version, env_included
.env                      (omitido com --exclude-env)
docker-compose.yml
synapse.sql.gz            pg_dump --clean --if-exists do DB de metadados
volumes/synapse-data-*.tar.gz   um tarball por volume de deployment
```

pg_dump roda dentro de `synapse-postgres` via `docker exec` com `set -o pipefail`. Volumes montados read-only num sidecar `busybox:stable`.

### S3 + compatíveis

`--to-s3=` é `s3://bucket/key`. Barra final = diretório + apenda basename. Requer:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
```

Pra Backblaze B2 / Cloudflare R2 / Wasabi / MinIO:

```bash
export SYNAPSE_BACKUP_S3_ENDPOINT=https://<conta>.r2.cloudflarestorage.com
```

Upload via `curl --aws-sigv4` (curl 7.75+) — sem dependência da aws CLI. Tarball local mantido após upload. Trilha em `$INSTALL_DIR/backup.log`.

## `--restore=<arquivo>` — local ou `s3://`

```bash
./setup.sh --restore=/var/backups/synapse-2026-05.tar.gz
./setup.sh --restore=s3://meu-bucket/synapse/snap-1.tar.gz
./setup.sh --restore=/path/to/backup.tar.gz --keep-env
```

S3 auto-baixado pra temp. Sem `--non-interactive`, operador confirma `[y/N]`.

Fluxo: extrai → valida `manifest.txt` → para containers gerenciados → `compose down` → restaura `.env` (a menos de `--keep-env`) → pra cada `volumes/*.tar.gz`: `docker volume rm` + recria + extrai via busybox → limpa pgdata por sufixo → `compose up -d postgres`; espera até 90s pelo `SELECT 1` → `gunzip` do dump + `psql -v ON_ERROR_STOP=1 < arquivo` (o `<` é load-bearing) → `compose up -d`; espera até 120s pelo `/health`.

Trilha em `$INSTALL_DIR/restore.log`.

## `--uninstall` — backup prévio obrigatório por default

```bash
./setup.sh --uninstall
./setup.sh --uninstall --skip-backup
./setup.sh --uninstall --keep-volumes
./setup.sh --uninstall --non-interactive
```

Fluxo default: roda `lifecycle::backup` em `/tmp/synapse-uninstall-backup-<UTC>.tar.gz` (sobrescreva com `--backup-out=`) → para containers gerenciados → `compose down` → limpa `synapse-data-*` + `*synapse-pgdata` (a menos de `--keep-volumes`) → tira bloco `# BEGIN synapse` do `/etc/caddy/Caddyfile` → `rm -rf` no install dir.

Wipe default é proposital: pgdata encriptado com `POSTGRES_PASSWORD` do `.env`; synapse-data tem admin keys cujos segredos vivem em rows postgres. Sem o `.env` (que mora no install dir), volumes ficam inúteis. Recuperação: backup → reinstalar → `--restore=<backup>`.

## `--logs=<componente> [--follow] [--tail=<n>]`

```bash
./setup.sh --logs=synapse                # últimas 200 linhas
./setup.sh --logs=synapse --follow
./setup.sh --logs=dashboard --tail=500
```

Componentes validados: `synapse`, `dashboard`, `postgres`, `caddy`, `convex-dashboard`, `convex-dashboard-proxy`. Stream direto pro stdout — pipe pra `less`/`grep` funciona.

## `--status` — diagnóstico read-only

```bash
./setup.sh --status
```

Não muta. Sai `0` saudável, `1` degradado, `2` quebrado.

Mostra: versão, public URL, base de custom domains, cada container do compose, count + nomes de deployments gerenciados, volumes `synapse-data-*` e `*synapse-pgdata`, comparação DNS, validade cert TLS (warn <14d, fail expirado), uso de disco em `/var/lib/docker`.

## `--doctor` — preflight contra install existente

```bash
./setup.sh --doctor
```

Re-roda checks de preflight sem mutar. Útil como primeiro comando pra "host está ok?".

## `--reconfigure` — troca host público sem reinstalar

```bash
./setup.sh --reconfigure --domain=novo.example.com
./setup.sh --reconfigure --no-tls
./setup.sh --reconfigure --base-domain=apps.example.com
./setup.sh --reconfigure --domain=novo.example.com --acme-email=ops@novo.example.com
```

`--domain` e `--no-tls` mutuamente exclusivos; pelo menos um de `--domain`/`--no-tls`/`--base-domain` precisa. Mexe só em `.env` e `Caddyfile` — nunca em Postgres, deployments ou schema.

Valida Caddyfile renderizado dentro de `caddy:2-alpine` descartável (`caddy validate`) antes de promover. Dashboard é rebuildado porque Next.js faz inline de `NEXT_PUBLIC_*` em build time.

Trilha em `$INSTALL_DIR/reconfigure.log`.

## Mapa de arquivos de log

| Ação | Arquivo |
|---|---|
| Todas as fases | `$SYNAPSE_INSTALL_LOG` (default `/tmp/synapse-install.log`) |
| `--upgrade` | `$INSTALL_DIR/upgrade.log` |
| `--backup` | `$INSTALL_DIR/backup.log` |
| `--restore` | `$INSTALL_DIR/restore.log` |
| `--reconfigure` | `$INSTALL_DIR/reconfigure.log` |
| `--uninstall` | Herda do install; linha de backup prévio vai no backup log em andamento |
| `--logs`, `--status`, `--doctor` | Sem arquivo — stream/stdout |
| Self-update daemon (por upgrade) | `/var/log/synapse-updater/<UTC>.log` |
| Self-update daemon (por reconfigure) | `/var/log/synapse-updater/reconfigure-<UTC>.log` |
| Self-update daemon (journal) | `journalctl -u synapse-updater` |
