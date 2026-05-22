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
    return {
      status: exists ? "ok" : "warn",
      summary: exists
        ? `linked to ${ctx.projectConfig.project?.name || "?"}`
        : "no project metadata in this directory",
      remediation: exists ? null : "Run `synapse select` to link this directory.",
      data: {
        cwd: ctx.cwd,
        linked: exists,
        project: exists ? ctx.projectConfig.project?.id : null,
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
  autoFix: "never",
  dependsOn: ["auth-token-valid", "in-project-dir"],
  run: safeRun(async (ctx) => {
    if (!ctx.projectConfig || !ctx.api) {
      return { status: "skipped", summary: "no linked project or no session", data: {} };
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
        remediation: "Run `synapse select` to re-link.",
        data: { teamRef, projectId: ctx.projectConfig.project?.id },
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
            "Set SYNAPSE_BASE_DOMAIN on the server (wildcard subdomain) OR add a custom domain to this deployment.",
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
  checkProjectStillExists,

  // Tier C (per deployment)
  makeDeploymentCheck("dev"),
  makeDeploymentCheck("prod"),
];

module.exports = { ALL_CHECKS, isBrowserReachable, cmpVer };
