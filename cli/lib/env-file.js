// Writes / reads `.env.local` for Synapse-linked projects.
//
// As of v1.8.2 the file is drop-in compatible with Convex Cloud
// tutorials:
//
//   # Convex (Synapse self-hosted — drop-in compatible with Cloud tutorials)
//   NEXT_PUBLIC_CONVEX_URL="https://<name>.app.synapsepanel.com"
//   NEXT_PUBLIC_CONVEX_SITE_URL="https://<name>.app.synapsepanel.com"
//   CONVEX_DEPLOYMENT=dev:<name> # team: <team>, project: <project>
//
//   # Self-hosted auth (Synapse cannot use Cloud account session)
//   CONVEX_SELF_HOSTED_URL="https://<name>.app.synapsepanel.com"
//   CONVEX_SELF_HOSTED_ADMIN_KEY="<name>|..."
//
// In Cloud, NEXT_PUBLIC_CONVEX_URL points at `.convex.cloud` and
// NEXT_PUBLIC_CONVEX_SITE_URL at `.convex.site` — two different
// origins. In self-hosted both point at the same URL; the backend
// container routes API calls and HTTP actions on the same host.
//
// CONVEX_DEPLOYMENT is kept uncommented for cosmetic familiarity —
// the synapse wrapper around `npx convex` (`runConvex` in
// lib/convex.js) deletes it from the child env when self-hosted
// vars are present, so it never accidentally triggers Cloud auth.

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

// Build the authoritative CONVEX_DEPLOYMENT line. Returns null when we
// don't have enough info to write one (e.g. legacy caller with no
// deploymentName) — caller should skip writing instead of writing a
// half-formed line.
function buildDeploymentLine({ deploymentName, target, teamName, projectName, teamSlug, projectSlug }) {
  if (!deploymentName) return null;
  const safeTarget = target === "prod" ? "prod" : "dev";
  const teamLabel = sanitizeForComment(teamName || teamSlug);
  const projectLabel = sanitizeForComment(projectName || projectSlug);
  const parts = [];
  if (teamLabel) parts.push(`team: ${teamLabel}`);
  if (projectLabel) parts.push(`project: ${projectLabel}`);
  const comment = parts.length > 0 ? ` # ${parts.join(", ")}` : "";
  return `${CONVEX_DEPLOYMENT}=${safeTarget}:${deploymentName}${comment}`;
}

function updateEnvContent(content, opts) {
  const { convexUrl, adminKey } = opts || {};
  if (!convexUrl || !adminKey) {
    throw new Error("updateEnvContent requires convexUrl + adminKey");
  }
  const deploymentLine = buildDeploymentLine(opts || {});

  const lines = content ? content.split(/\r?\n/) : [];
  // Drop trailing empty lines — we'll re-add a single newline via join.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  // Canonical assignments by key.
  const assignments = {
    [NEXT_PUBLIC_CONVEX_URL]: envAssignment(NEXT_PUBLIC_CONVEX_URL, convexUrl),
    [NEXT_PUBLIC_CONVEX_SITE_URL]: envAssignment(NEXT_PUBLIC_CONVEX_SITE_URL, convexUrl),
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
  isDeploymentLine,
  keyFromLine,
  parseEnvContent,
  quoteEnvValue,
  readProjectEnv,
  sanitizeForComment,
  updateEnvContent,
  writeProjectEnv,
};
