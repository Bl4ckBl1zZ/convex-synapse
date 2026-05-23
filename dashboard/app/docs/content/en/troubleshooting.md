# Troubleshooting

Specific symptoms, the diagnosis you run to confirm the cause, and the fix.

## "Email or password is incorrect" on Windows PowerShell

**Symptom.** `synapse login` on Windows returns "Email or password is incorrect" even when the credentials work in the dashboard. Affects passwords with non-ASCII characters (accents, ñ, ã, ç, ...).

**Diagnosis.** Run `chcp` in the same PowerShell session. If it returns anything other than `65001` (UTF-8), PowerShell is reading your keystrokes through a legacy codepage.

**Fix.** Upgrade the CLI to v1.8.10+ which auto-runs `chcp 65001` on startup on Windows:

```powershell
npm install -g @iann29/synapse@latest
synapse login
```

## `synapse dev` fails with "CONVEX_DEPLOYMENT must not be set..."

**Symptom.** `synapse dev` aborts with `CONVEX_DEPLOYMENT must not be set when calling convex dev`. The CLI sets that env internally; an environment-level export shadows it.

**Diagnosis.**

```bash
grep -RIn 'CONVEX_DEPLOYMENT' ~/.bashrc ~/.zshrc ~/.profile ~/.config/fish/ 2>/dev/null
env | grep CONVEX
```

**Fix.**

```bash
unset CONVEX_DEPLOYMENT
synapse select       # re-bind
synapse dev
```

Then delete the offending line from the shell rc file.

## Stale `.synapse/project.json`

**Symptom.** `synapse dev` / `synapse deploy` complain about a project/deployment that no longer exists, or that you've renamed.

**Diagnosis.**

```bash
cat .synapse/project.json
```

If `projectId` / `prodDeploymentName` / `devDeploymentName` don't match what the dashboard shows for the current team, the local pin is stale.

**Fix.**

```bash
synapse doctor --fix --yes
```

Re-probes the server, drops orphaned pins, re-binds whatever still exists.

## "URL not browser-reachable" / orange embed banner

**Symptom.** In the dashboard, opening a deployment shows an orange banner: "this deployment's URL is not browser-reachable" — or the embedded Convex Dashboard at `/embed/<name>` fails to load.

**Diagnosis.** Deployment URL like `https://synapse.example.com/d/brave-dolphin-1060/` works server-to-server but browsers running the Convex dashboard in an iframe hit Mixed Content / cross-origin restrictions. The deployment needs either a wildcard subdomain or a fully custom domain.

**Fix.**

**Option A — wildcard subdomain:**

```bash
# DNS: add wildcard A record  *.synapse.example.com  → <vps-ip>
./setup.sh --reconfigure --base-domain=synapse.example.com
```

**Option B — custom domain per deployment:**

In the dashboard → deployment → Custom domains → Add → enter `convex.your-app.com`, set the displayed `CNAME` / `A` record on your DNS provider, click Verify.

## `synapse status` shows red `no-domain` chip

**Symptom.** `synapse status` displays a red `no-domain` chip next to the deployment row.

**Diagnosis.** Same root cause as the orange embed banner — the deployment URL is the legacy `/d/<name>/` proxy form.

**Fix.** Same as above — `--base-domain` reconfigure or add a custom domain.

## `synapse deploy` says "No prod deployment saved"

**Symptom.** `synapse deploy` fails with "No prod deployment saved for this project".

**Diagnosis.**

```bash
cat .synapse/project.json
```

`prodDeploymentName` is missing or `null`.

**Fix.** Create a prod deployment in the dashboard, then:

```bash
synapse select       # pick the prod deployment
synapse deploy
```

## `synapse open` opens a broken page

**Symptom.** `synapse open` launches a browser at a URL that 404s or fails to load.

**Diagnosis.** Pre-v1.8.1 the CLI built the URL incorrectly. Check version: `synapse --version`.

**Fix.**

```bash
npm install -g @iann29/synapse@latest    # >= 1.8.1
synapse open
```

## Auto-update fails mid-upgrade

**Symptom.** Dashboard's upgrade dialog stays in `polling` then flips to `failed`, or the page never reloads after `rebooting`.

**Diagnosis.** SSH to the VPS:

```bash
journalctl -u synapse-updater --no-pager -n 200
ls -lt /var/log/synapse-updater/
sudo tail -n 200 /var/log/synapse-updater/<latest>.log
sudo cat /var/lib/synapse-updater/status.json
sudo tail -n 100 /opt/synapse/upgrade.log
```

Common culprits:

- `compose up --build` failed (look for `[FATAL]` in the per-run log)
- Health check timed out at 180s
- Image rollback was triggered

**Fix.**

```bash
./setup.sh --status
./setup.sh --upgrade --force
# If still broken:
LATEST_BACKUP=$(ls -t /opt/synapse/backups/*.tar.gz | head -n1)
./setup.sh --restore="$LATEST_BACKUP"
```

If the daemon's lock file is orphaned:

```bash
sudo rm /var/lib/synapse-updater/upgrade.lock
sudo systemctl restart synapse-updater
```

## Operator can't log in but other team members can

**Symptom.** One specific user authenticates but `/v1/admin/version_check` returns 403 for them; other admins of the same team work fine.

**Diagnosis.** Instance-admin is a per-user flag, separate from team roles:

```bash
docker exec synapse-postgres psql -U synapse -d synapse -c \
  "SELECT id, email, is_instance_admin FROM users ORDER BY created_at;"
```

The first user registered after install is auto-promoted; team admins do NOT inherit instance-admin.

**Fix.** Promote the user manually:

```bash
docker exec synapse-postgres psql -U synapse -d synapse -c \
  "UPDATE users SET is_instance_admin = true WHERE email = 'ops@example.com';"
```

## HA deployment stuck in provisioning

**Symptom.** New HA-mode deployment sits at "provisioning" or "queued" indefinitely.

**Diagnosis.**

```bash
./setup.sh --logs=synapse --tail=200 | grep -E 'provisioner|advisory|HA|ha_'
docker exec synapse-postgres psql -U synapse -d synapse -c \
  "SELECT id, kind, status, last_error, attempts, created_at
     FROM provisioning_jobs
    WHERE status IN ('queued','running','failed')
    ORDER BY created_at DESC LIMIT 10;"
./setup.sh --status | grep -E 'backend-postgres|minio'
```

Common culprits: `--enable-ha` passed but `ha` compose profile inactive; `SYNAPSE_BACKEND_POSTGRES_URL`/`SYNAPSE_BACKEND_S3_*` empty in `.env`; advisory-lock contention.

**Fix.**

```bash
./setup.sh --upgrade --force
```

If a single job is wedged:

```bash
docker exec synapse-postgres psql -U synapse -d synapse -c \
  "UPDATE provisioning_jobs SET status='failed', last_error='manual reset'
    WHERE id='<job-id>' AND status='running';"
```

## Caddy not getting certs

**Symptom.** Deployment URL is `https://<dep>.<base>` but browser shows TLS failure or `ERR_CONNECTION_REFUSED`. Custom domain stuck at "pending verification" forever.

**Diagnosis.**

```bash
# 1. DNS
dig +short '<deployment>.<base-domain>'
curl -s https://api.ipify.org

# 2. tls_ask gate
curl -i "http://localhost:8080/v1/internal/tls_ask?domain=<deployment>.<base-domain>"
# 200 = OK; 404 = unknown hostname; 403 = deleted

# 3. Caddy logs
./setup.sh --logs=caddy --tail=200 | grep -E 'on-demand|tls|certificate|<base-domain>'
```

Common culprits: wildcard `*.<base>` A record missing or pointing elsewhere; `<deployment>.<base>` doesn't match any non-deleted row; Let's Encrypt rate-limited (5 failed validations per account, per hostname, per hour).

**Fix.**

```bash
# Fix DNS at your registrar, then re-probe.
# If tls_ask returns 404 but the deployment exists:
docker compose -f /opt/synapse/docker-compose.yml restart synapse
# If API is reachable but Caddy can't get a cert:
docker compose -f /opt/synapse/docker-compose.yml exec caddy \
  caddy reload --config /etc/caddy/Caddyfile
```

For Let's Encrypt rate-limit recovery, wait it out (1 hour minimum).
