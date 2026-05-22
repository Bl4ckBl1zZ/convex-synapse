// Doctor's check catalog. Each check is a pure-ish function that returns
// a CheckResult (or throws — the runner catches and converts to issue).
//
// The runner imports `ALL_CHECKS` (in execution order, respecting tier
// dependencies) and iterates. New checks should be added here with a
// stable id; --json consumers depend on the id surface staying stable
// across schemaVersion bumps.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { SynapseAPI, SynapseAPIError } = require("../api");
const { readProjectEnv } = require("../env-file");
const { writeProjectConfig } = require("../project");

const REQUIRED_NODE = "18.17.0";

// Compare semver-ish strings. Returns -1 / 0 / 1.
function cmpVer(a, b) {
  const ap = a.replace(/^v/, "").split(".").map(Number);
  const bp = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const av = ap[i] || 0;
    const bv = bp[i] || 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

// Wrap a check function so a thrown error doesn't crash the runner.
function safeRun(fn) {
  return async (ctx) => {
    const t0 = Date.now();
    try {
      const r = await fn(ctx);
      return { ...r, durationMs: Date.now() - t0 };
    } catch (err) {
      return {
        status: "issue",
        summary: `unexpected error: ${err.message || String(err)}`,
        data: { error: String(err.message || err) },
        durationMs: Date.now() - t0,
      };
    }
  };
}

// -------- local-env -------------------------------------------------

const checkNodeVersion = {
  id: "node-version",
  category: "local-env",
  title: `Node.js >= ${REQUIRED_NODE}`,
  autoFix: "never",
  dependsOn: [],
  run: safeRun(async () => {
    const observed = process.version;
    const ok = cmpVer(observed, REQUIRED_NODE) >= 0;
    return {
      status: ok ? "ok" : "issue",
      summary: ok ? observed : `${observed} (need >= v${REQUIRED_NODE})`,
      remediation: ok ? null : "Upgrade Node via nvm/volta/asdf.",
      data: { observed, required: REQUIRED_NODE },
    };
  }),
};

const checkConfigFileMode = {
  id: "home-config-readable",
  category: "local-env",
  title: "~/.synapse/config.json mode 0600",
  autoFix: "auto",
  dependsOn: [],
  run: safeRun(async (ctx) => {
    const cfg = ctx.cfgPath;
    if (!fs.existsSync(cfg)) {
      return {
        status: "warn",
        summary: "no saved session",
        remediation: "Run `synapse login <url>` to authenticate.",
        data: { path: cfg, exists: false },
      };
    }
    const mode = fs.statSync(cfg).mode & 0o777;
    const ok = mode === 0o600 || process.platform === "win32";
    return {
      status: ok ? "ok" : "warn",
      summary: ok ? `${cfg} (mode 0600)` : `mode 0${mode.toString(8)} (expected 0600)`,
      remediation: ok ? null : `chmod 600 ${cfg}`,
      data: { path: cfg, mode: mode.toString(8) },
    };
  }),
  // Auto-fix: chmod 600.
  fix: async (ctx) => {
    try {
      fs.chmodSync(ctx.cfgPath, 0o600);
      return { kind: "applied", message: "chmod 600 applied" };
    } catch (err) {
      return { kind: "failed", message: err.message };
    }
  },
};

// -------- project --------------------------------------------------

const checkInProjectDir = {
  id: "in-project-dir",
  category: "project",
  title: ".synapse/project.json present",
  autoFix: "never",
  dependsOn: [],
  run: safeRun(async (ctx) => {
    const exists = ctx.projectConfig !== null && ctx.projectConfig !== undefined;
    if (!exists) {
      return {
        status: "warn",
        summary: "no project metadata in this directory",
        remediation: "Run `synapse select` to link this directory.",
        data: { cwd: ctx.cwd, linked: false, project: null },
      };
    }
    // v1.8.1: `doctor --fix --yes` may have written a stale marker into
    // project.json. Detect it explicitly so the next doctor run says
    // "linked-but-stale" instead of confidently claiming a healthy link.
    if (ctx.projectConfig.staleReason === "project-not-found") {
      const date = ctx.projectConfig.staleAt
        ? ctx.projectConfig.staleAt.slice(0, 10)
        : "previously";
      return {
        status: "warn",
        summary: `directory was unlinked by doctor — staleReason: project-not-found (${date})`,
        remediation: "Run `synapse select` to re-link.",
        data: {
          cwd: ctx.cwd,
          linked: false,
          stale: true,
          previous: ctx.projectConfig.previous ?? null,
        },
      };
    }
    return {
      status: "ok",
      summary: `linked to ${ctx.projectConfig.project?.name || "?"}`,
      data: {
        cwd: ctx.cwd,
        linked: true,
        project: ctx.projectConfig.project?.id,
      },
    };
  }),
};

const checkEnvLocalPresent = {
  id: "env-local-present",
  category: "project",
  title: ".env.local exists",
  autoFix: "never",
  dependsOn: ["in-project-dir"],
  run: safeRun(async (ctx) => {
    if (!ctx.projectConfig) {
      return { status: "skipped", summary: "no linked project", data: {} };
    }
    const p = path.join(ctx.cwd, ".env.local");
    const exists = fs.existsSync(p);
    return {
      status: exists ? "ok" : "issue",
      summary: exists ? p : "missing .env.local",
      remediation: exists ? null : "Run `synapse select` — it writes .env.local.",
      data: { path: p, exists },
    };
  }),
};

const checkEnvLocalHasVars = {
  id: "env-local-has-self-hosted-vars",
  category: "project",
  title: "CONVEX_SELF_HOSTED_URL + ADMIN_KEY in .env.local",
  autoFix: "never",
  dependsOn: ["env-local-present"],
  run: safeRun(async (ctx) => {
    if (!ctx.projectConfig) {
      return { status: "skipped", summary: "no linked project", data: {} };
    }
    const env = readProjectEnv(ctx.cwd);
    const hasUrl = !!env.CONVEX_SELF_HOSTED_URL;
    const hasKey = !!env.CONVEX_SELF_HOSTED_ADMIN_KEY;
    if (hasUrl && hasKey) {
      return {
        status: "ok",
        summary: "both vars present",
        data: { hasUrl, hasKey },
      };
    }
    return {
      status: "issue",
      summary: !hasUrl && !hasKey ? "both vars missing" : hasUrl ? "admin key missing" : "URL missing",
      remediation: "Run `synapse select` to rewrite .env.local.",
      data: { hasUrl, hasKey },
    };
  }),
};

// v1.8.2: separate check for the Cloud-compatible NEXT_PUBLIC_* vars.
// Self-hosted auth (above) is REQUIRED. These public vars are
// convenience for code that imports CONVEX_URL the way Cloud
// tutorials do — missing them only warns, never blocks (the CLI
// still works without them).
const checkEnvLocalHasPublicVars = {
  id: "env-local-has-public-convex-vars",
  category: "project",
  title: "NEXT_PUBLIC_CONVEX_URL + NEXT_PUBLIC_CONVEX_SITE_URL in .env.local",
  autoFix: "never",
  dependsOn: ["env-local-present"],
  run: safeRun(async (ctx) => {
    if (!ctx.projectConfig) {
      return { status: "skipped", summary: "no linked project", data: {} };
    }
    const env = readProjectEnv(ctx.cwd);
    const hasUrl = !!env.NEXT_PUBLIC_CONVEX_URL;
    const hasSite = !!env.NEXT_PUBLIC_CONVEX_SITE_URL;
    if (hasUrl && hasSite) {
      return {
        status: "ok",
        summary: "both public vars present",
        data: { hasUrl, hasSite },
      };
    }
    const missing = [];
    if (!hasUrl) missing.push("NEXT_PUBLIC_CONVEX_URL");
    if (!hasSite) missing.push("NEXT_PUBLIC_CONVEX_SITE_URL");
    return {
      status: "warn",
      summary: `missing: ${missing.join(", ")} (Cloud-style vars; CLI still works)`,
      remediation:
        "Run `synapse select` to regenerate .env.local with Cloud-compatible vars (CLI v1.8.2+).",
      data: { hasUrl, hasSite, missing },
    };
  }),
};

const checkGitignoreProtectsEnv = {
  id: "gitignore-protects-env",
  category: "project",
  title: ".gitignore protects .env.local and .synapse/",
  autoFix: "auto",
  dependsOn: [],
  run: safeRun(async (ctx) => {
    const p = path.join(ctx.cwd, ".gitignore");
    if (!fs.existsSync(p)) {
      return {
        status: "warn",
        summary: "no .gitignore in this directory",
        remediation: "Create .gitignore with `.env.local` and `.synapse/` entries.",
        data: { exists: false },
      };
    }
    const content = fs.readFileSync(p, "utf8");
    const hasEnv = /^\.env\.local\s*$/m.test(content) || /^\.env\*\.local\s*$/m.test(content);
    const hasSyn = /^\.synapse\//m.test(content) || /^\.synapse\s*$/m.test(content);
    if (hasEnv && hasSyn) {
      return { status: "ok", summary: "both ignored", data: { hasEnv, hasSyn } };
    }
    const missing = [];
    if (!hasEnv) missing.push(".env.local");
    if (!hasSyn) missing.push(".synapse/");
    return {
      status: "warn",
      summary: `missing entries: ${missing.join(", ")}`,
      remediation: `Append to .gitignore: ${missing.join(" ")}`,
      data: { hasEnv, hasSyn, missing },
    };
  }),
  fix: async (ctx) => {
    const p = path.join(ctx.cwd, ".gitignore");
    let content = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
    if (content && !content.endsWith("\n")) content += "\n";
    const toAppend = [];
    if (!/^\.env\.local\s*$/m.test(content) && !/^\.env\*\.local\s*$/m.test(content)) {
      toAppend.push(".env.local");
    }
    if (!/^\.synapse\//m.test(content) && !/^\.synapse\s*$/m.test(content)) {
      toAppend.push(".synapse/");
    }
    if (toAppend.length === 0) {
      return { kind: "skipped", message: "already protected" };
    }
    content += "# added by `synapse doctor --fix`\n" + toAppend.join("\n") + "\n";
    fs.writeFileSync(p, content);
    return { kind: "applied", message: `appended ${toAppend.join(" + ")}` };
  },
};

const checkNoShellConvexDeployment = {
  id: "no-shell-convex-deployment",
  category: "project",
  title: "shell does NOT export CONVEX_DEPLOYMENT",
  autoFix: "never",
  dependsOn: [],
  run: safeRun(async (ctx) => {
    const v = ctx.env.CONVEX_DEPLOYMENT;
    if (!v) return { status: "ok", summary: "unset", data: {} };
    return {
      status: "warn",
      summary: `set to "${v}" — overrides .env.local`,
      remediation: "Unset CONVEX_DEPLOYMENT in your shell rc, or use `synapse dev` which strips it.",
      data: { value: v },
    };
  }),
};

// -------- backend --------------------------------------------------

const checkBackendReachable = {
  id: "backend-reachable",
  category: "backend",
  title: "Synapse backend reachable",
  autoFix: "never",
  dependsOn: [],
  run: safeRun(async (ctx) => {
    if (!ctx.cfg) {
      return {
        status: "skipped",
        summary: "not logged in",
        remediation: "Run `synapse login <url>`.",
        data: {},
      };
    }
    const t0 = Date.now();
    const probe = new SynapseAPI({ baseUrl: ctx.cfg.baseUrl });
    try {
      const status = await probe.request("GET", "/v1/install_status", undefined, {
        auth: false,
      });
      const latency = Date.now() - t0;
      return {
        status: "ok",
        summary: `${ctx.cfg.baseUrl} (v${status.version}, ${latency}ms)`,
        data: {
          baseUrl: ctx.cfg.baseUrl,
          version: status.version,
          firstRun: status.firstRun,
          latencyMs: latency,
        },
      };
    } catch (err) {
      return {
        status: "issue",
        summary: `unreachable — ${err.message || String(err)}`,
        remediation: `Check VPN/firewall. Try \`curl ${ctx.cfg.baseUrl}/v1/install_status\` from this machine.`,
        data: { baseUrl: ctx.cfg.baseUrl, error: String(err.message || err) },
      };
    }
  }),
};

const checkAuthTokenValid = {
  id: "auth-token-valid",
  category: "backend",
  title: "session valid",
  autoFix: "never",
  dependsOn: ["backend-reachable"],
  run: safeRun(async (ctx) => {
    if (!ctx.cfg || !ctx.api) {
      return { status: "skipped", summary: "not logged in", data: {} };
    }
    try {
      const me = await ctx.api.me();
      return {
        status: "ok",
        summary: me.email || me.user?.email || "(unknown email)",
        data: { email: me.email || me.user?.email },
      };
    } catch (err) {
      const code = err instanceof SynapseAPIError ? err.code : "unknown";
      return {
        status: "issue",
        summary: `auth failed (${code})`,
        remediation: "Run `synapse login <url>` again.",
        data: { code, message: err.message },
      };
    }
  }),
};

const checkProjectStillExists = {
  id: "project-still-exists",
  category: "backend",
  title: "linked project exists on backend",
  // v1.8.1: was "never" — promoted to "prompt" so `doctor --fix --yes`
  // can auto-remediate stale .synapse/project.json. See Bug 3 in
  // docs/V1_8_1_STALE_LINK_FIXES.md for the design (B-then-C hybrid).
  autoFix: "prompt",
  dependsOn: ["auth-token-valid", "in-project-dir"],
  run: safeRun(async (ctx) => {
    if (!ctx.projectConfig || !ctx.api) {
      return { status: "skipped", summary: "no linked project or no session", data: {} };
    }
    // The marker case (stale link written by a prior --fix) has no
    // project.id to look up — checkInProjectDir already warned about
    // it. Skip the network call.
    if (!ctx.projectConfig.project?.id) {
      return { status: "skipped", summary: "no project id (stale marker?)", data: {} };
    }
    const teamRef = ctx.projectConfig.team?.slug || ctx.projectConfig.team?.id;
    if (!teamRef) {
      return { status: "warn", summary: "linked project has no team ref", data: {} };
    }
    try {
      const projects = await ctx.api.projects(teamRef);
      const found = projects.find((p) => p.id === ctx.projectConfig.project?.id);
      if (found) {
        return {
          status: "ok",
          summary: `${found.name} (${found.slug})`,
          data: { id: found.id },
        };
      }
      return {
        status: "issue",
        summary: "project not found in team — deleted or transferred?",
        remediation: "Run `synapse select` to re-link, or `synapse doctor --fix --yes`.",
        data: {
          teamRef,
          projectId: ctx.projectConfig.project?.id,
          teamSlug: ctx.projectConfig.team?.slug,
          projectSlug: ctx.projectConfig.project?.slug,
        },
      };
    } catch (err) {
      return {
        status: "issue",
        summary: `lookup failed: ${err.message}`,
        remediation: "Check membership; project may have been deleted.",
        data: { error: err.message },
      };
    }
  }),
  // Two-phase fix (Bug 3 design):
  //   B) If exactly one other team owns a project with the same slug,
  //      auto-relink (project was transferred). Deployments are reset
  //      because the old refs are stale — operator runs `synapse
  //      select` once if they want specific dev/prod refs.
  //   C) Otherwise (no match, ambiguous match, or any API error):
  //      mark project.json as stale and keep the operator's previous
  //      block for forensics. Append an idempotent comment marker to
  //      .env.local so the bogus admin key isn't silently trusted.
  // Both paths are reachable only under `--fix --yes` (autoFix=prompt
  // + allowPrompt=true at runner.js applyAutoFixes).
  fix: async (ctx) => {
    if (!ctx.projectConfig || !ctx.api) {
      return { kind: "failed", message: "no project config or no API session" };
    }
    const savedProjectId = ctx.projectConfig.project?.id;
    const savedProjectSlug = ctx.projectConfig.project?.slug;
    const previous = {
      team: ctx.projectConfig.team,
      project: ctx.projectConfig.project,
    };
    // Fresh listing — never trust the upstream check's stale data.
    let teams;
    try {
      teams = await ctx.api.teams();
    } catch (err) {
      return { kind: "failed", message: `could not list teams: ${err.message}` };
    }
    const candidates = [];
    if (savedProjectSlug) {
      for (const team of teams) {
        let projects;
        try {
          projects = await ctx.api.projects(team.slug || team.id);
        } catch {
          continue; // one team's lookup failed; try the rest
        }
        for (const p of projects) {
          if (p.slug === savedProjectSlug && p.id !== savedProjectId) {
            candidates.push({ team, project: p });
          }
        }
      }
    }
    if (candidates.length === 1) {
      // Heuristic B: unambiguous re-link (most likely a transfer).
      const { team, project } = candidates[0];
      const newConfig = {
        synapseUrl: ctx.projectConfig.synapseUrl,
        team,
        project,
        deployments: {},
      };
      writeProjectConfig(ctx.cwd, newConfig);
      // Sync in-memory ctx so the runner's recheck sees the new state.
      // Without this, `Object.assign(r, fresh, {fixedBy})` overwrites
      // with another "issue" because run() still reads the old project.id.
      ctx.projectConfig = newConfig;
      return {
        kind: "applied",
        message: `re-linked to ${team.slug || team.name}/${project.slug || project.name} (project was transferred)`,
      };
    }
    // Fallback C: write a stale marker. Keep synapseUrl + the previous
    // block so the operator can audit what was there.
    const staleAt = new Date().toISOString();
    const staleConfig = {
      synapseUrl: ctx.projectConfig.synapseUrl,
      staleReason: "project-not-found",
      staleAt,
      previous,
    };
    writeProjectConfig(ctx.cwd, staleConfig);
    ctx.projectConfig = staleConfig;
    // Idempotent comment marker on .env.local. The admin key inside is
    // still bogus, but deletion would lose info the operator may want
    // to grep, so just annotate. Marker string is stable so re-running
    // fix doesn't keep appending.
    try {
      const envPath = path.join(ctx.cwd, ".env.local");
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf8");
        const marker = "# stale — admin key invalid";
        if (!content.includes(marker)) {
          const banner = `${marker} since ${staleAt.slice(0, 10)}, run \`synapse select\`\n`;
          fs.writeFileSync(envPath, banner + content);
        }
      }
    } catch {
      // Best-effort; project.json marker is the source of truth.
    }
    return {
      kind: "applied",
      message: "marked stale — run `synapse select` to re-link",
    };
  },
};

// -------- deployments ----------------------------------------------

function isBrowserReachable(url) {
  if (!url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const STANDARD = new Set(["", "443", "80", "6791"]);
  if (STANDARD.has(u.port)) return true;
  return u.hostname === "localhost" || u.hostname === "127.0.0.1";
}

function makeDeploymentCheck(target) {
  return {
    id: `deployment-${target}-health`,
    category: "deployments",
    title: `${target} deployment health`,
    autoFix: "never",
    dependsOn: ["project-still-exists"],
    run: safeRun(async (ctx) => {
      if (!ctx.projectConfig || !ctx.api) {
        return { status: "skipped", summary: "no project or session", data: {} };
      }
      const ref = ctx.projectConfig.deployments?.[target];
      if (!ref || !ref.name) {
        return {
          status: target === "dev" ? "issue" : "warn",
          summary: "no deployment saved",
          remediation: `Run \`synapse select\` and pick a ${target} deployment.`,
          data: { target, saved: false },
        };
      }
      let auth;
      try {
        auth = await ctx.api.cliCredentials(ref.name);
      } catch (err) {
        return {
          status: "issue",
          summary: `${ref.name}: credentials fetch failed (${err.message})`,
          remediation: "Backend may be down, or the deployment was deleted.",
          data: { name: ref.name, error: err.message },
        };
      }
      const reachable = isBrowserReachable(auth.convexUrl);
      // Probe /version on the deployment (it's a public endpoint on the
      // Convex backend container). Cheap signal that the URL responds.
      let probeOk = false;
      let probeError = null;
      let probeLatencyMs = null;
      if (reachable) {
        const t0 = Date.now();
        try {
          const ac = new AbortController();
          const timeout = setTimeout(() => ac.abort(), 3500);
          const res = await fetch(auth.convexUrl + "/version", {
            signal: ac.signal,
          });
          clearTimeout(timeout);
          probeOk = res.ok;
          probeLatencyMs = Date.now() - t0;
        } catch (err) {
          probeError = err.name === "AbortError" ? "timeout (>3.5s)" : err.message;
        }
      }
      const data = {
        name: ref.name,
        url: auth.convexUrl,
        browserReachable: reachable,
        probeOk,
        probeError,
        probeLatencyMs,
      };
      if (!reachable) {
        return {
          status: "issue",
          summary: `${ref.name}: URL not browser-reachable (${auth.convexUrl})`,
          remediation:
            "Enable wildcard subdomain via /admin/host-domain in the dashboard (instance admin) OR add a custom domain to this deployment.",
          data,
        };
      }
      if (!probeOk) {
        return {
          status: "warn",
          summary: `${ref.name}: URL reachable but /version probe failed (${probeError ?? "no body"})`,
          remediation: "TLS may still be provisioning. Retry in 30s.",
          data,
        };
      }
      return {
        status: "ok",
        summary: `${ref.name} — ${auth.convexUrl} (${probeLatencyMs}ms)`,
        data,
      };
    }),
  };
}

const ALL_CHECKS = [
  // Tier A
  checkNodeVersion,
  checkConfigFileMode,
  checkInProjectDir,
  checkNoShellConvexDeployment,
  checkGitignoreProtectsEnv,
  checkBackendReachable,

  // Tier B
  checkAuthTokenValid,
  checkEnvLocalPresent,
  checkEnvLocalHasVars,
  checkEnvLocalHasPublicVars,
  checkProjectStillExists,

  // Tier C (per deployment)
  makeDeploymentCheck("dev"),
  makeDeploymentCheck("prod"),
];

module.exports = { ALL_CHECKS, isBrowserReachable, cmpVer };
