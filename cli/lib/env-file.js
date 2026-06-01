// Writes / reads `.env.local` for Synapse-linked projects.
//
// As of v1.8.4 the file is drop-in compatible with Convex Cloud
// tutorials (cloud-style NEXT_PUBLIC_* vars) while keeping CONVEX_DEPLOYMENT
// commented so the Convex CLI's mode picker doesn't see both modes active:
//
//   # Convex (Synapse self-hosted — drop-in compatible with Cloud tutorials)
//   NEXT_PUBLIC_CONVEX_URL="https://<name>.app.synapsepanel.com"
//   NEXT_PUBLIC_CONVEX_SITE_URL="https://<name>.site.app.synapsepanel.com"
//   # CONVEX_DEPLOYMENT=dev:<name> # team: <team>, project: <project>
//
//   # Self-hosted auth (Synapse cannot use Cloud account session)
//   CONVEX_SELF_HOSTED_URL="https://<name>.app.synapsepanel.com"
//   CONVEX_SELF_HOSTED_ADMIN_KEY="<name>|..."
//
// In Cloud, NEXT_PUBLIC_CONVEX_URL points at `.convex.cloud` (the API /
// cloud listener, port 3210) and NEXT_PUBLIC_CONVEX_SITE_URL at
// `.convex.site` (the site proxy where HTTP actions live, port 3211).
// Synapse mirrors this: when the deployment has a base domain or a
// role='site' custom domain, the site URL is a distinct host
// (`<name>.site.<base>`) routed to port 3211. Without one (host-port
// mode, where 3211 isn't separately published) the site URL falls back
// to the cloud URL. See the repo's docs/CONVEX_SITE_ORIGIN.md.
//
// CONVEX_DEPLOYMENT stays commented in self-hosted mode. The Convex
// CLI errors with "CONVEX_DEPLOYMENT must not be set when
// CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY are set" if
// both are present at runtime. Our wrapper deletes CONVEX_DEPLOYMENT
// from process.env before spawning npx convex, but the convex CLI
// invokes dotenv.config() on its own and re-reads .env.local, which
// would resurrect the var. Keeping the line commented preserves the
// human-readable context (team/project, deployment kind) without
// triggering the conflict. v1.8.2-v1.8.3 wrote it active — that
// regression broke `synapse dev` and is fixed in v1.8.4.

const fs = require("node:fs");
const path = require("node:path");

const SELF_HOSTED_URL = "CONVEX_SELF_HOSTED_URL";
const SELF_HOSTED_ADMIN_KEY = "CONVEX_SELF_HOSTED_ADMIN_KEY";
const CONVEX_DEPLOYMENT = "CONVEX_DEPLOYMENT";
const NEXT_PUBLIC_CONVEX_URL = "NEXT_PUBLIC_CONVEX_URL";
const NEXT_PUBLIC_CONVEX_SITE_URL = "NEXT_PUBLIC_CONVEX_SITE_URL";

const PUBLIC_HEADER = "# Convex (Synapse self-hosted — drop-in compatible with Cloud tutorials)";
const AUTH_HEADER = "# Self-hosted auth (Synapse cannot use Cloud account session)";

// Keys whose VALUE we own. The CONVEX_DEPLOYMENT line is special-cased
// (it's a bare assignment with an inline comment, not a quoted value),
// so it's not in this map.
const MANAGED_VALUE_KEYS = [
  NEXT_PUBLIC_CONVEX_URL,
  NEXT_PUBLIC_CONVEX_SITE_URL,
  SELF_HOSTED_URL,
  SELF_HOSTED_ADMIN_KEY,
];

function quoteEnvValue(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function envAssignment(name, value) {
  return `${name}=${quoteEnvValue(value)}`;
}

function keyFromLine(line) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match ? match[1] : null;
}

// Detects a CONVEX_DEPLOYMENT line whether it's:
//   - Bare:        `CONVEX_DEPLOYMENT=dev:x`
//   - Exported:    `export CONVEX_DEPLOYMENT=dev:x`
//   - Commented:   `# CONVEX_DEPLOYMENT=... # disabled by synapse CLI...` (v1.8.1-)
// Returns true for any of these so `synapse select` can authoritatively
// replace a previously-commented form with the new uncommented line.
function isDeploymentLine(line) {
  if (keyFromLine(line) === CONVEX_DEPLOYMENT) return true;
  return /^\s*#\s*(?:export\s+)?CONVEX_DEPLOYMENT\s*=/.test(line);
}

// Trim any character that would break a single-line trailing comment.
// We're not parsing it back as a value (it lives in a `# ...` tail),
// but a literal newline in a team/project name would split the line and
// poison subsequent parsing. Defensive normalization only.
function sanitizeForComment(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\r\n]+/g, " ").replace(/#/g, "·").trim();
}

function unquoteEnvValue(raw) {
  const value = String(raw || "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvContent(content) {
  const out = {};
  for (const line of String(content || "").split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(line)) {
      continue;
    }
    const key = keyFromLine(line);
    if (!key) {
      continue;
    }
    const valueStart = line.indexOf("=");
    if (valueStart < 0) {
      continue;
    }
    out[key] = unquoteEnvValue(line.slice(valueStart + 1));
  }
  return out;
}

function readProjectEnv(projectDir) {
  const file = path.join(projectDir, ".env.local");
  if (!fs.existsSync(file)) {
    return {};
  }
  return parseEnvContent(fs.readFileSync(file, "utf8"));
}

// Build the (commented) CONVEX_DEPLOYMENT line. Returns null when we
// don't have enough info (legacy caller with no deploymentName).
//
// REGRESSION FIX v1.8.4: this line MUST be commented. Convex CLI rejects
// the combination of CONVEX_DEPLOYMENT + CONVEX_SELF_HOSTED_URL/ADMIN_KEY
// — the two modes are mutually exclusive. v1.8.2 wrote it ACTIVE, which
// broke `npx convex` (and therefore `synapse dev`) because Convex's
// internal dotenv re-loads .env.local after our wrapper deletes the
// var from the child env. Keeping it commented preserves the human
// context (team/project label) while never showing up in the parsed
// env. See https://github.com/Iann29/convex-synapse/issues for the
// real-world report from the user's session.
function buildDeploymentLine({ deploymentName, target, teamName, projectName, teamSlug, projectSlug }) {
  if (!deploymentName) return null;
  const safeTarget = target === "prod" ? "prod" : "dev";
  const teamLabel = sanitizeForComment(teamName || teamSlug);
  const projectLabel = sanitizeForComment(projectName || projectSlug);
  const parts = [];
  if (teamLabel) parts.push(`team: ${teamLabel}`);
  if (projectLabel) parts.push(`project: ${projectLabel}`);
  const comment = parts.length > 0 ? ` # ${parts.join(", ")}` : "";
  return `# ${CONVEX_DEPLOYMENT}=${safeTarget}:${deploymentName}${comment}`;
}

function updateEnvContent(content, opts) {
  const { convexUrl, siteUrl, adminKey } = opts || {};
  if (!convexUrl || !adminKey) {
    throw new Error("updateEnvContent requires convexUrl + adminKey");
  }
  const deploymentLine = buildDeploymentLine(opts || {});

  const lines = content ? content.split(/\r?\n/) : [];
  // Drop trailing empty lines — we'll re-add a single newline via join.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  // NEXT_PUBLIC_CONVEX_SITE_URL is the HTTP-actions host (Convex port
  // 3211). It's distinct from the cloud URL when the backend handed us a
  // siteUrl (base domain / role='site' custom domain); otherwise it falls
  // back to the cloud URL (host-port mode). See docs/CONVEX_SITE_ORIGIN.md.
  const publicSiteUrl = siteUrl || convexUrl;

  // Canonical assignments by key.
  const assignments = {
    [NEXT_PUBLIC_CONVEX_URL]: envAssignment(NEXT_PUBLIC_CONVEX_URL, convexUrl),
    [NEXT_PUBLIC_CONVEX_SITE_URL]: envAssignment(NEXT_PUBLIC_CONVEX_SITE_URL, publicSiteUrl),
    [SELF_HOSTED_URL]: envAssignment(SELF_HOSTED_URL, convexUrl),
    [SELF_HOSTED_ADMIN_KEY]: envAssignment(SELF_HOSTED_ADMIN_KEY, adminKey),
  };

  const seen = new Set();
  const out = [];
  let seenDeployment = false;

  for (const line of lines) {
    const key = keyFromLine(line);

    // CONVEX_DEPLOYMENT handling (incl. legacy `# CONVEX_DEPLOYMENT=...
    // # disabled by synapse CLI` form):
    //   - new API (caller passed deploymentName)  → first match becomes
    //     the authoritative line; subsequent matches are dropped.
    //   - legacy API (no deploymentName)          → leave existing lines
    //     untouched so callers still using the old shape don't surprise
    //     their users.
    if (isDeploymentLine(line)) {
      if (deploymentLine) {
        if (!seenDeployment) {
          out.push(deploymentLine);
          seenDeployment = true;
        }
        continue;
      }
      out.push(line);
      continue;
    }

    if (assignments[key] && !seen.has(key)) {
      out.push(assignments[key]);
      seen.add(key);
      continue;
    }
    if (assignments[key] && seen.has(key)) {
      // Duplicate of a key we already wrote — drop to keep file canonical.
      continue;
    }
    out.push(line);
  }

  // Append any unseen managed keys, grouped under section headers so a
  // brand-new file gets a tidy layout. On idempotent rewrites the loop
  // above will have replaced everything in place; only the first-time
  // write hits this block.
  const newPublicLines = [];
  if (!seen.has(NEXT_PUBLIC_CONVEX_URL)) {
    newPublicLines.push(assignments[NEXT_PUBLIC_CONVEX_URL]);
    seen.add(NEXT_PUBLIC_CONVEX_URL);
  }
  if (!seen.has(NEXT_PUBLIC_CONVEX_SITE_URL)) {
    newPublicLines.push(assignments[NEXT_PUBLIC_CONVEX_SITE_URL]);
    seen.add(NEXT_PUBLIC_CONVEX_SITE_URL);
  }
  if (deploymentLine && !seenDeployment) {
    newPublicLines.push(deploymentLine);
    seenDeployment = true;
  }

  const newAuthLines = [];
  if (!seen.has(SELF_HOSTED_URL)) {
    newAuthLines.push(assignments[SELF_HOSTED_URL]);
    seen.add(SELF_HOSTED_URL);
  }
  if (!seen.has(SELF_HOSTED_ADMIN_KEY)) {
    newAuthLines.push(assignments[SELF_HOSTED_ADMIN_KEY]);
    seen.add(SELF_HOSTED_ADMIN_KEY);
  }

  if (newPublicLines.length > 0 || newAuthLines.length > 0) {
    if (out.length > 0) out.push("");
    if (newPublicLines.length > 0) {
      out.push(PUBLIC_HEADER);
      out.push(...newPublicLines);
    }
    if (newAuthLines.length > 0) {
      if (newPublicLines.length > 0) out.push("");
      out.push(AUTH_HEADER);
      out.push(...newAuthLines);
    }
  }

  return out.join("\n") + "\n";
}

function writeProjectEnv(projectDir, credentials, opts = {}) {
  const file = path.join(projectDir, ".env.local");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const next = updateEnvContent(existing, {
    convexUrl: credentials.convexUrl,
    siteUrl: credentials.siteUrl,
    adminKey: credentials.adminKey,
    deploymentName: credentials.deploymentName || opts.deploymentName,
    target: opts.target,
    teamName: opts.team?.name,
    teamSlug: opts.team?.slug,
    projectName: opts.project?.name,
    projectSlug: opts.project?.slug,
  });
  fs.writeFileSync(file, next, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
  return file;
}

// reassertPublicConvexUrls forces .env.local's NEXT_PUBLIC_CONVEX_URL and
// NEXT_PUBLIC_CONVEX_SITE_URL to Synapse's authoritative values, rewriting
// ONLY those two lines and leaving the rest of the file byte-for-byte.
//
// Why this exists: `synapse select` writes the correct values, but the
// upstream `npx convex dev|deploy` re-derives them on every run from the
// backend container's GET /get_canonical_urls (its baked CONVEX_SITE_ORIGIN)
// and overwrites .env.local. That container value can lag the
// deployment_domains table — e.g. a role='site' custom domain that went
// active after the container was last (re)created — so upstream silently
// replaces the distinct site host with the cloud URL. `credentials.siteUrl`
// (from GET /v1/deployments/{name}/cli_credentials) is recomputed from the
// domains table on every request and is the source of truth; re-asserting
// it after (and during) an upstream run keeps NEXT_PUBLIC_CONVEX_SITE_URL
// pointing at the HTTP-actions host. See docs/CONVEX_SITE_ORIGIN.md.
//
// Deliberately surgical (two keys, in place) rather than a full
// updateEnvContent rewrite: the dev-time guard below calls this on every
// file change, and re-canonicalizing the whole file would churn/fight the
// operator's own layout. Compares by parsed VALUE, so an already-correct
// value in any quoting style is left untouched — which also makes this a
// no-op (returns false) when nothing drifted, keeping the fs.watch guard
// loop-safe. Returns false when the file is absent (`synapse select` owns
// creation) or already correct; true when it rewrote a line.
function reassertPublicConvexUrls(projectDir, credentials = {}) {
  const { convexUrl, siteUrl } = credentials || {};
  if (!convexUrl) {
    return false;
  }
  const file = path.join(projectDir, ".env.local");
  if (!fs.existsSync(file)) {
    return false;
  }
  const existing = fs.readFileSync(file, "utf8");
  const want = {
    [NEXT_PUBLIC_CONVEX_URL]: convexUrl,
    // Host-port mode hands back no siteUrl; fall back to the cloud URL so
    // both vars stay populated (same rule updateEnvContent uses).
    [NEXT_PUBLIC_CONVEX_SITE_URL]: siteUrl || convexUrl,
  };
  const current = parseEnvContent(existing);
  if (Object.entries(want).every(([key, value]) => current[key] === value)) {
    return false;
  }

  const out = [];
  const seen = new Set();
  for (const line of existing.split(/\r?\n/)) {
    const key = keyFromLine(line);
    if (key && want[key] !== undefined) {
      if (seen.has(key)) {
        continue; // collapse any duplicate managed line
      }
      seen.add(key);
      out.push(envAssignment(key, want[key]));
      continue;
    }
    out.push(line);
  }
  // Append any managed var the file never had. Rare — `synapse select` and
  // upstream convex both write both keys — but keep the contract total.
  const missing = [NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_CONVEX_SITE_URL].filter(
    (key) => !seen.has(key),
  );
  if (missing.length > 0) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    for (const key of missing) out.push(envAssignment(key, want[key]));
    out.push("");
  }

  fs.writeFileSync(file, out.join("\n"), { mode: 0o600 });
  return true;
}

// guardPublicConvexUrls watches .env.local for the lifetime of a
// long-running `npx convex` (e.g. `dev`) and re-asserts the authoritative
// public URLs whenever upstream rewrites them — so the value is correct for
// the whole dev session, not just after the process exits. Returns a stop()
// that closes the watcher; the caller still does a final re-assert after the
// child exits (it covers the case where .env.local didn't exist when the
// guard installed — upstream creates it mid-run).
//
// Loop-safe: reassertPublicConvexUrls is a no-op once the values match, so
// our own restore write can't ping-pong with the watcher. `watch` is
// injectable for tests. Best-effort throughout — a platform without
// fs.watch (or a transient error) just falls back to the post-run assert.
function guardPublicConvexUrls(projectDir, credentials, { watch = fs.watch } = {}) {
  const file = path.join(projectDir, ".env.local");
  if (!credentials || !credentials.convexUrl || !fs.existsSync(file)) {
    return () => {};
  }
  let watcher = null;
  try {
    watcher = watch(file, () => {
      try {
        reassertPublicConvexUrls(projectDir, credentials);
      } catch {
        // Transient read/write race — the next event or the caller's
        // post-run re-assert is the backstop.
      }
    });
    // Don't let the watcher keep the process alive on its own.
    if (watcher && typeof watcher.unref === "function") watcher.unref();
  } catch {
    watcher = null;
  }
  return () => {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
  };
}

module.exports = {
  CONVEX_DEPLOYMENT,
  NEXT_PUBLIC_CONVEX_URL,
  NEXT_PUBLIC_CONVEX_SITE_URL,
  SELF_HOSTED_ADMIN_KEY,
  SELF_HOSTED_URL,
  MANAGED_VALUE_KEYS,
  PUBLIC_HEADER,
  AUTH_HEADER,
  buildDeploymentLine,
  guardPublicConvexUrls,
  isDeploymentLine,
  keyFromLine,
  parseEnvContent,
  quoteEnvValue,
  reassertPublicConvexUrls,
  readProjectEnv,
  sanitizeForComment,
  updateEnvContent,
  writeProjectEnv,
};
