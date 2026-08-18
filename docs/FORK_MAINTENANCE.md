# Fork maintenance

This repository is a fork of [`Iann29/convex-synapse`](https://github.com/Iann29/convex-synapse)
that carries a small number of local patches. `.github/workflows/upstream-sync.yml`
keeps the two in step without anyone having to remember to do it.

## What the fork changes

| Area | Why it diverges |
|---|---|
| `synapse/internal/docker/provisioner.go` | Advertises the container-internal Convex origin instead of the published host port, so a deployment is reachable from inside the compose network in host-port mode |
| `synapse/internal/docker/remote.go` | Same origin fix on the remote-host dispatch path |
| `synapse/internal/docker/site_origin_test.go`, `synapse/internal/test/convex_origin_test.go` | Guard tests that pin the behaviour above |
| `docker-compose.local.yml`, `Caddyfile.cloudflare-local` | Local Cloudflare Tunnel stack, fork-only |
| `.github/workflows/publish-image.yml` | Publishes the patched server image to `ghcr.io/bl4ckbl1zz/synapse` |

The guard tests are the load-bearing part. They are what lets the sync merge
upstream automatically: if an upstream change breaks the origin behaviour these
patches exist to provide, `go test ./...` fails on the merge commit and nothing
is merged.

## How the sync works

Daily at 06:17 UTC (and on demand via **Actions → upstream-sync → Run workflow**):

1. **Detect** — fetch `upstream/main` and count what's new. Nothing new, nothing done.
2. **Merge** — build `automation/upstream-sync` from `main` and merge `upstream/main`
   into it. A merge, never a rebase: the fork's history is public, and a real merge
   base is what keeps every subsequent sync incremental.
3. **Verify** — run the entire `ci.yml` suite (Go tests, dashboard build, compose
   build, bats + shellcheck, Playwright e2e) against that exact merge commit.
4. **Merge the PR** — only if every job passed. Then dispatch `publish-image.yml`
   so the patched GHCR image tracks the new tip.

Everything runs on GitHub-hosted runners, free and unmetered because this
repository is public.

### Two things that shape the design

**Events created with `GITHUB_TOKEN` do not trigger workflows.** That is a
deliberate GitHub anti-recursion rule, and it means a PR opened by this workflow
would never fire `ci.yml`'s `pull_request` trigger — "merge when green" would be
merging on no evidence at all. So `ci.yml` is `workflow_call`-able and this
workflow invokes it directly, pinned to the merge SHA. The same rule is why the
image rebuild is an explicit `gh workflow run`: `workflow_dispatch` is one of the
two events exempt from it.

**The repo's default `GITHUB_TOKEN` permission is read-only.** The workflow
requests `contents: write`, `pull-requests: write` and `actions: write`
explicitly rather than loosening the repo-wide default.

## When it conflicts

Automatic merging stops. The workflow commits the conflicted tree — markers and
all — to `automation/upstream-sync` and opens it as a **draft** PR titled
`⚠️ CONFLICT`. A draft can't be merged, and CI is skipped, so the broken tree is
inert. Subsequent scheduled runs detect that draft and pause rather than
force-pushing over work in progress.

To resolve:

```bash
git fetch origin automation/upstream-sync
git checkout automation/upstream-sync
# fix the markers, keeping the fork's behaviour and upstream's improvement
cd synapse && go test ./... -count=1
git commit -am "merge: resolve upstream conflicts"
git push
gh pr ready <number>          # un-draft; this is what lets CI and merging proceed
```

Syncs resume once that PR is closed or merged.

## When the merge is clean but CI fails

The PR stays open, unmerged, with a comment linking the failing run. Upstream
changed something the fork's patches depend on. The next scheduled sync rebuilds
the branch from scratch, so a fix landing upstream clears it with no action here;
if the break is in the fork's own patches, fix them on `main` and the next sync
picks that up.

## Manual escape hatches

```bash
gh workflow run upstream-sync.yml                    # sync now
gh workflow run upstream-sync.yml -f force=true      # ignore a pending conflict PR
gh workflow run publish-image.yml                    # rebuild the GHCR image
```

Note that GitHub disables scheduled workflows in a repository after 60 days
without commits. This one commits on every sync, so it keeps itself alive as long
as upstream is active — but after a long quiet stretch, check that the schedule is
still enabled.
