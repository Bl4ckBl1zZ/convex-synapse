# Remote Hosts — Security model + rotation

v1.18.0 ships multi-host deployment via three trust layers
(Headscale tailnet membership, per-host SSH transport, forced-
command Docker whitelist). This doc is the operator-facing threat
model: what we protect against, what we deliberately don't, and
how to rotate when things go sideways.

Read [`docs/REMOTE_HOSTS.md`](REMOTE_HOSTS.md) first for the
architecture and operator flow. Everything below assumes that
shape.

## Threat model

### What we defend against

- **Stolen Synapse adoption token** (`syn_adopt_...`). Single-use:
  the first successful `POST /v1/agents/register` marks the row
  consumed and subsequent attempts return a clear error. 1-hour
  expiration (`remote_setup.go:remoteSetupTTL`). Stored only as
  SHA-256 hash in `host_adoption_tokens.token_hash`; plaintext
  never persisted. Worst case if intercepted in transit: the
  attacker registers *as that host* before the operator does, the
  legitimate install fails with "token already consumed", the
  operator mints a fresh bundle. Recovery is one click in the
  dashboard.

- **Stolen Headscale pre-auth key** (`tskey-auth-...`). Same
  shape: single-use, 1-hour expiration, minted by
  `headscale.CreatePreAuthKey` with `reusable=false`. Worst case
  if intercepted: the attacker joins the tailnet as a Headscale
  node before the legitimate VPS does. They get a `100.64.0.0/10`
  IP, but no SSH key for any synapse-deployer account on any
  existing VPS — Headscale ACLs (when enabled, see Hardening
  below) drop them at the tailnet layer; without ACLs they can
  reach `synapse-deployer@<other-vps>:22` but fail authentication
  because their key isn't in any `authorized_keys`.

- **Compromised remote VPS**. The synapse-deployer SSH privkey on
  that VPS *can* be used to SSH back into the same VPS as
  synapse-deployer, but the only thing reachable that way is the
  forced-command wrapper — same whitelist as Synapse central uses.
  The wrapper does not grant a shell, port-forward, or X11. **Per-
  host keypair = blast-radius isolation by design** (the privkey
  fingerprint on `hosts.ssh_privkey_fingerprint` is per-row).
  Compromise of one VPS does not let an attacker SSH into any
  *other* VPS.

  > **One scoped sudo (host teardown).** synapse-deployer is otherwise
  > a no-sudo account. The single exception: a `NOPASSWD` sudoers rule
  > (`/etc/sudoers.d/synapse-deployer-teardown`) lets it run exactly one
  > root-owned, argument-less script — `/usr/local/bin/synapse-agent-teardown`
  > — reached via the wrapper's `synapse-agent-teardown` sentinel when the
  > operator deletes the host. The script is root-owned and not writable by
  > synapse-deployer, so a stolen key can at most trigger this VPS's *own*
  > self-decommission (a wipe, not a takeover) — never a shell, and never
  > reach another host. The sudoers rule is validated with `visudo -cf`
  > before install so a bad render can't wedge sudo.

- **Compromised non-deployer user on a remote VPS**. The
  synapse-agent observer runs as user `synapse-agent` (in the
  `docker` group). A separate non-root user. Even a root-level
  compromise of an unrelated tenant on the VPS cannot escalate to
  *Synapse central*: there's nothing for `synapse-agent` to
  authenticate *to Synapse central* except via the outbound HTTPS
  heartbeat carrying its own token, and the agent token only
  authenticates for THIS host's observe-only API. The synapse-
  deployer user's privkey is read-locked (0600) and only the
  privkey + Synapse central's copy can authenticate to its
  authorized_keys, but anyone with root on the VPS can read it —
  that's a VPS-compromise scenario, blast-radius scoped per
  bullet above.

- **Attacker on the public internet**. Cannot reach the agent's
  heartbeat port (the agent only initiates outbound HTTPS to
  Synapse central; nothing on the agent listens). Cannot reach
  the `Match User synapse-deployer` block: `sshd` itself does
  bind `0.0.0.0:22`, but the wrapper's whitelist gates execution
  regardless of source — and a public attacker has no privkey, so
  authentication fails first. Cannot reach Synapse central's
  Headscale API: it's behind the same Caddy that gates the rest
  of `synapse.<base-domain>`, and the API key never leaves the
  control plane host.

- **Tailnet membership without Headscale approval**. Headscale
  pre-auth keys are the gate. Plaintext keys are shown once at
  mint time and immediately consumed by the legitimate install.
  Headscale's own audit log
  (`docker compose logs headscale`) records every node-join with
  its pre-auth key id.

### What we don't defend against (explicit)

- **Compromise of the Synapse central host.** An attacker with
  root on the control plane host can read every per-host SSH
  privkey from Postgres after extracting `SYNAPSE_STORAGE_KEY`
  from `.env`. From there they can SSH-dispatch
  whitelisted-Docker commands to every adopted VPS. This is the
  standard single-point-of-failure for any self-hosted control
  plane; protect the control plane host's `.env` like a
  production secret store (HSM/KMS integration deferred — see
  [What's NOT instrumented](#whats-not-instrumented-in-v1180)).

- **Compromise of the Headscale binary on the Synapse central
  host.** A patched `headscale` could mint pre-auth keys silently
  and approve fake nodes. Same trust boundary as the synapse-api
  binary itself.

- **Insider with instance-admin access.** Anyone holding an
  instance-admin Synapse account can mint Setup remote install
  bundles (adoption + Headscale pre-auth keys), add new hosts,
  and place arbitrary deployments on them. Full trust assumed at
  this tier — there's no segregation between "add a host" and
  "place a deployment on a host" in v1.18.

- **Tailnet-internal MITM.** `sshprov.Client` uses
  `ssh.InsecureIgnoreHostKey()` (documented in
  `synapse/internal/sshprov/client.go:16-20`). Per-host fingerprint
  pinning is operationally painful across a growing fleet (every
  VPS rotation re-issues an SSH host key, every operator has to
  push the new fingerprint into the control plane). We accept
  that trade and rely on:
  - Headscale ACLs + tailnet IP identity as the network-level
    second factor (an attacker would need to either compromise
    Headscale to forge a tailnet IP, or compromise an *existing*
    on-tailnet box to MITM, both of which already imply enough
    capability to exfiltrate the privkey from Synapse central or
    the VPS directly).
  - The forced-command wrapper as the third layer.

  Operators paranoid about insider attacks on the tailnet itself
  should enable Headscale ACLs restricting tailnet traffic to
  `(synapse-central, *)` only.

- **Side-channels on the remote VPS.** A separate process on the
  VPS that has `CAP_SYS_PTRACE` or root and can `ptrace` the
  synapse-deployer-exec wrapper at exec time can observe the
  Docker command. We don't sandbox the wrapper beyond what `sshd`
  + the `restrict` clause already enforce.

- **Supply-chain integrity of the agent binary.** `install-
  agent.sh` SHA256-verifies the tarball against the digest in
  `GET /v1/install_agent/config`, but that digest is computed by
  the same control plane that's distributing the binary —
  compromise of Synapse central poisons both. Operators who want
  a stronger guarantee should mirror the GitHub Release asset
  through their own pipeline and pin a fork via
  `SYNAPSE_BOOTSTRAP_REPO_URL`.

## Key + secret inventory

| Where it lives | What it is | Lifetime | Rotation |
|---|---|---|---|
| `.env` on control plane: `SYNAPSE_STORAGE_KEY` | AES-256-GCM key wrapping every per-host SSH privkey *and* HA Postgres URLs | install lifetime | [Rotation runbook A](#a-rotate-synapse_storage_key) |
| `.env` on control plane: `SYNAPSE_HEADSCALE_API_KEY` | Admin token Synapse uses to call Headscale's HTTP API | install lifetime | [Rotation runbook B](#b-rotate-headscale-admin-api-key) |
| `.env` on control plane: `SYNAPSE_HEADSCALE_DB_PASSWORD` | Postgres credentials for Headscale's database | install lifetime | Standard Postgres ALTER USER + restart |
| Postgres: `host_adoption_tokens.token_hash` | SHA-256 of plaintext `syn_adopt_...`; consumed at register | ≤1 h, single-use | Mint a fresh bundle (dashboard) |
| Postgres: `hosts.ssh_privkey_encrypted` | `crypto.SecretBox` ciphertext of the per-host ed25519 privkey | host lifetime | [Rotation runbook C](#c-rotate-a-per-host-ssh-keypair) |
| Postgres: `hosts.ssh_pubkey` | OpenSSH pubkey + `hosts.ssh_privkey_fingerprint` (display) | host lifetime | Same as ciphertext above |
| VPS: `/etc/synapse-agent/synapse_deployer_ed25519` (mode 0600) | Local copy of the ed25519 privkey | host lifetime | Same as above (re-run install-agent.sh) |
| VPS: `/home/synapse-deployer/.ssh/authorized_keys` | Matching pubkey + `command=` + `restrict` clause | host lifetime | Re-render via re-running install-agent.sh |
| VPS: `/etc/synapse-agent/config.json` (mode 0600) | Long-lived agent token (heartbeat auth) | until revoke/rotate | `POST /v1/host_agents/{id}/rotate_token` — see HOSTS_AND_AGENTS.md |
| Headscale: pre-auth key (`tskey-auth-...`) | One-time tailnet join credential | ≤1 h, single-use | Mint a fresh bundle |

## Rotation runbooks

### A. Rotate `SYNAPSE_STORAGE_KEY`

Touches every per-host SSH privkey *and* every HA Postgres URL.
**Do not** attempt without a tested backup — a bad re-encrypt
leaves every adopted VPS unreachable until rolled back.

```bash
# 1. Take a full backup. setup.sh --backup writes a tarball
#    + manifest.txt the restore path can rehydrate.
sudo ./setup.sh --backup --to-s3=s3://your-bucket/synapse-backups

# 2. Stop the synapse-api container (workers must not run during
#    re-encrypt). Headscale + Caddy + postgres stay up.
docker compose stop synapse-api

# 3. Generate the new key and re-encrypt every encrypted column.
#    The reencrypt utility ships in synapse/cmd/reencrypt; build
#    it ad-hoc from the same checkout that brought the install up:
cd synapse && go run ./cmd/reencrypt \
  --old-key="$SYNAPSE_STORAGE_KEY" \
  --new-key="$(openssl rand -base64 32)"
# Prints the new key once on stdout — copy it now.

# 4. Update .env on the control plane host:
#    SYNAPSE_STORAGE_KEY=<new key from step 3>
# 5. Bring synapse-api back up:
docker compose up -d synapse-api

# 6. Sanity-check by provisioning a no-op stop+start on each
#    remote host via the dashboard (Deployments → Restart). A
#    successful round-trip proves the new key decrypts the privkey
#    successfully.
```

> If `cmd/reencrypt` is not present in your checkout (it lives on
> `main`; some forks omit it) the v1.18.0 fallback is **destroy +
> recreate every remote host adoption**: re-run install-agent.sh
> on each VPS from a fresh **Setup remote install** bundle. The
> register endpoint replaces the row's encrypted privkey
> column, so the new key wraps the new keypair end-to-end.

### B. Rotate Headscale admin API key

The key Synapse uses to mint pre-auth keys and inspect tailnet
nodes. Compromise = an attacker can mint tailnet pre-auth keys at
will.

```bash
# On the control plane host:
cd <install-dir>

# 1. Mint a new API key via the headscale CLI inside the container.
NEW_KEY=$(docker compose --profile headscale exec -T headscale \
  headscale apikeys create | awk 'END{print $NF}')

# 2. Update .env:
#    SYNAPSE_HEADSCALE_API_KEY=<NEW_KEY>
# 3. Restart synapse-api (it reads the key only on startup).
docker compose restart synapse-api

# 4. Expire (or delete) the old key once you're sure the new one
#    is live (a fresh "Setup remote install" mint succeeds):
docker compose --profile headscale exec -T headscale \
  headscale apikeys expire --prefix=<old-key-prefix>
```

### C. Rotate a per-host SSH keypair

v1.18.0 does **not** ship `install-agent.sh --rotate-ssh-key` (the
comment in `migrations/000025_hosts_ssh_privkey.up.sql` references
it as a Phase 4 follow-up). The supported rotation is destroy +
re-adopt the host's keypair, which keeps the host row, its
deployments, and its observed history intact:

```bash
# 1. In the dashboard: Hosts → the row → "Setup remote install".
#    Mint a fresh bundle. (This consumes a new adoption token +
#    a new Headscale pre-auth key, both 1h TTL.)

# 2. SSH into the VPS as root and re-run the new one-liner. The
#    install script is idempotent — Tailscale is already up
#    (skipped), Docker is present (skipped), agent users exist
#    (skipped). The keypair step regenerates the keypair at
#    /etc/synapse-agent/synapse_deployer_ed25519 and re-writes
#    /home/synapse-deployer/.ssh/authorized_keys with the new
#    pubkey. The register POST replaces hosts.ssh_pubkey +
#    hosts.ssh_privkey_encrypted + ssh_privkey_fingerprint with
#    the new values.

# 3. Sanity-check from the control plane:
#    Dashboard → Deployments → restart any deployment on this host.
#    A successful round-trip proves Synapse central can SSH with
#    the new key.
```

The old privkey is overwritten on the VPS by the new key file.
The old encrypted blob in Postgres is overwritten by the
`UPDATE hosts SET ssh_privkey_encrypted=...` inside the register
handler.

### D. Revoke a compromised remote host

A VPS you no longer trust. Severs every channel: SSH dispatch,
heartbeat auth, tailnet identity.

```bash
# 1. Revoke the agent token — heartbeats start 401-ing immediately.
curl -X POST -H "Authorization: Bearer $SYNAPSE_ADMIN_PAT" \
  https://<base-domain>/v1/host_agents/<agent-id>/revoke

# 2. Expire the tailnet node from Headscale — the VPS loses
#    its 100.x IP on the next tailscale poll (<1 min).
docker compose --profile headscale exec -T headscale \
  headscale nodes expire --identifier=<node-id>

# 3. (Optional but recommended) NULL the host's encrypted privkey
#    so Synapse central refuses to even attempt SSH if you forget
#    to delete the host row.
PGPASSWORD=$PGPASSWORD psql -h localhost -U synapse -d synapse \
  -c "UPDATE hosts SET ssh_privkey_encrypted=NULL, status='offline'
      WHERE id='<host-uuid>'::uuid;"

# 4. Migrate any deployments that lived on this host elsewhere
#    (destroy + recreate — see REMOTE_HOSTS.md §Limitations).

# 5. If the VPS is still accessible (i.e. you're decommissioning
#    a legitimate host, not responding to compromise), wipe the
#    agent footprint with the installer's uninstall mode:
#      sudo bash install-agent.sh --uninstall
#    (removes the unit, binary, config, SSH wrapper + keys, scoped
#    sudoers, and system users; idempotent). Deleting the host from
#    the dashboard already attempts this over SSH — step 5 is the
#    manual path for a host the control plane can't reach.
```

> **Note:** deleting a host from the dashboard / CLI now performs
> steps 2 and 5 automatically as best-effort (Headscale node
> deregistration + box-side teardown over SSH). This runbook is the
> manual fallback for compromise response or an unreachable box.

### E. Rotate the agent token without rotating the SSH key

The agent token authenticates the heartbeat. Rotating it is cheap
and operator-visible; the SSH key stays intact.

```bash
# 1. Mint a fresh agent token:
curl -X POST -H "Authorization: Bearer $SYNAPSE_ADMIN_PAT" \
  https://<base-domain>/v1/host_agents/<agent-id>/rotate_token
# Returns the new token ONCE.

# 2. Update /etc/synapse-agent/config.json on the VPS with the
#    new token, or re-run `synapse-agent join`:
sudo /usr/local/bin/synapse-agent join \
  --control-url https://<base-domain> --token <new token>

# 3. Restart the agent to pick up the new config:
sudo systemctl restart synapse-agent

# Heartbeats with the old token start 401-ing. The host row
# stays attached to deployments uninterrupted.
```

## Hardening checklist (operator)
A defense-in-depth pass operators **should** complete after
adopting their first remote host. Most are not on by default
before v1.18; v1.19+ ships least-privilege tag-based ACLs and
control-plane tailnet membership as the new defaults.

1. **Headscale ACLs are tag-based by default in v1.19+** —
   `tag:synapse-control` (the central VPS) can only reach
   `tag:synapse-remote:22`; remote hosts cannot reach each other
   on the tailnet. The pre-v1.19 default was a permissive
   `src:["*"], dst:["*:*"]` rule; upgraded installs whose
   `<install-dir>/headscale/policy.hujson` was operator-edited
   keep their custom policy untouched — re-render is opt-in via
   `cp installer/templates/headscale.policy.hujson
   <install-dir>/headscale/`. To customize further, edit
   `<install-dir>/headscale/policy.hujson` and restart the
   headscale container.
2. **Restrict the VPS's public sshd to your operator IP** (or
   tailnet only). The `Match User synapse-deployer` block does
   not bind public sshd open or shut on its own — operators
   sshd:22 itself is still 0.0.0.0. Edit
   `/etc/ssh/sshd_config` to set `ListenAddress` to the tailnet
   IP only, or add a `Match Address` block restricting the public
   listener to your bastion.
3. **Set `SYNAPSE_STORAGE_KEY` to a key you generated locally**
   (`openssl rand -base64 32`), and keep it out of git, CI
   secrets, and chat logs. Compromise of this key compromises
   every adopted VPS's SSH privkey.
4. **Aggregate the synapse-deployer-exec audit log.** The wrapper
   logs every accepted + refused command via `logger -p
   auth.notice`. Pipe `journalctl _COMM=sshd` from each VPS to a
   central log store (Loki / CloudWatch / etc) so a flood of
   refusals on one host is observable from one place. v1.18.0
   ships no built-in aggregation.
5. **Set `iptables`/`nftables` egress rules on the VPS** to
   restrict outbound traffic to the tailnet + Docker Hub /
   ghcr.io / your registry of choice. The agent itself only
   needs outbound HTTPS to the control plane and Docker pulls
   from upstream registries.
6. **Monitor `hosts.last_heartbeat_at`** via the dashboard or
   `synapse hosts list --json`. A flap in `effectiveStatus` from
   `online` to `stale`/`offline` is the earliest signal of
   either VPS-level distress or tailnet partition.
7. **Audit instance-admins quarterly.** Anyone with
   instance-admin can mint Setup remote install bundles. The
   `audit_events` table records every mint with the actor's user
   id; review.
8. **Pin the agent version** in production. `install-agent.sh
   --agent-version=v1.X.Y` overrides the version
   `GET /v1/install_agent/config` would return — useful for
   staged rollouts of the agent across a fleet.
9. **Back up Postgres on a separate cadence from**
   **`SYNAPSE_STORAGE_KEY`**. A backup that contains both the
   ciphertext column *and* the storage key is decrypt-able by
   anyone who steals the tarball; store them on separate
   trust boundaries (off-box backup, KMS-wrapped key).
10. **Disable unused subcommands in `synapse-deployer-exec`.** If
    your install doesn't use HA features that need `docker
    inspect` etc, fork the wrapper at
    `installer-agent/templates/synapse-deployer-exec` to a
    shorter whitelist. The v1.18.0 default is the union of
    every subcommand Synapse central ever sends.
11. **Run `tailscale netcheck` from each VPS** on every install
    to confirm direct connectivity (no DERP relay). DERP traffic
    is still WireGuard-encrypted, but direct paths are lower
    latency for the per-deployment provision call.
12. **Pre-create the `synapse-agent` / `synapse-deployer` users
    with a fixed UID/GID** if your VPS has compliance reqs about
    UID stability. install-agent.sh uses `useradd --system` with
    auto-allocated UIDs by default.

## What's NOT instrumented in v1.18.0

Honest gaps. Each is a v1.19+ candidate; calling them out so
operators don't assume coverage that isn't there.

- **No automated key rotation.** `SYNAPSE_STORAGE_KEY`,
  `SYNAPSE_HEADSCALE_API_KEY`, and per-host SSH keys all rotate
  via operator-driven runbooks above. No scheduled rotation, no
  reminder ticker.
- **No central audit-log aggregation** for the per-VPS
  synapse-deployer-exec wrapper. Audit lives on each VPS's
  journal — operators must ship it themselves.
- **No anomaly detection** on `docker` subcommand patterns. A
  burst of `docker rm` followed by `docker run` looks identical
  to a re-provision in v1.18.0.
- **No HSM / KMS / Vault integration** for
  `SYNAPSE_STORAGE_KEY`. The key sits in `.env`, file-system
  permissions are the protection.
- **No mTLS** between synapse-api and the synapse-headscale
  container. They share a docker network; trust is "same docker
  compose project".
- **No per-host capability segmentation.** Every adopted VPS has
  the same trust level (Synapse central can dispatch the full
  whitelist to any of them). A future "preview-tier-only host"
  variant would restrict the host's whitelist further.
- **No rate-limiting on `POST /v1/hosts/{id}/remote_setup`**
  beyond the global API rate limits. An instance-admin with a
  leaked PAT could mint adoption tokens in a loop; the audit log
  catches it after the fact.
