#!/usr/bin/env node

const { SynapseAPI, SynapseAPIError } = require("../lib/api");
const { clearConfig, normalizeBaseUrl, requireConfig, writeConfig } = require("../lib/config");
const { quoteEnvValue, writeProjectEnv } = require("../lib/env-file");
const {
  buildProjectConfig,
  deploymentNameForTarget,
  readProjectConfig,
  writeProjectConfig,
} = require("../lib/project");
const { BACK, askCredentials, choose, confirm } = require("../lib/prompts");
const colors = require("../lib/colors");
const { runConvex } = require("../lib/convex");

function debugLog(msg) {
  if (process.env.DEBUG_SYNAPSE) {
    process.stderr.write(`[DEBUG] ${msg}\n`);
  }
}

function usage() {
  return `Usage:
  synapse login <url>
  synapse logout
  synapse whoami
  synapse select
  synapse dev [...args]                                    Run \`convex dev\` against the linked dev deployment.
  synapse deploy [--yes] [...args]                          Run \`convex deploy\` against the linked prod deployment (asks for confirmation).
  synapse credentials <deployment> [--format env|shell|json]
  synapse convex [--target dev|prod] [...args]              Escape hatch for any other \`convex\` subcommand.

Tip: \`synapse select\` writes the deployment credentials to .env.local, so you can also
run \`npx convex <args>\` directly without going through this wrapper.
`;
}

function clientFromConfig() {
  const cfg = requireConfig();
  const api = new SynapseAPI({ baseUrl: cfg.baseUrl, accessToken: cfg.accessToken });
  const refreshable = new Proxy(api, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") {
        return value;
      }
      return async (...args) => {
        try {
          return await value.apply(target, args);
        } catch (err) {
          if (!(err instanceof SynapseAPIError) || err.status !== 401 || !cfg.refreshToken) {
            throw err;
          }
          const session = await new SynapseAPI({ baseUrl: cfg.baseUrl }).refresh(cfg.refreshToken);
          if (!session.accessToken) {
            throw err;
          }
          cfg.accessToken = session.accessToken;
          cfg.refreshToken = session.refreshToken || cfg.refreshToken;
          cfg.tokenType = session.tokenType || cfg.tokenType || "Bearer";
          if (session.user) {
            cfg.user = session.user;
          }
          writeConfig(cfg);
          target.accessToken = cfg.accessToken;
          return await value.apply(target, args);
        }
      };
    },
  });
  return {
    cfg,
    api: refreshable,
  };
}

function labelName(item) {
  const name = item.name || item.slug || item.id;
  const slug = item.slug && item.slug !== name ? ` (${item.slug})` : "";
  return `${name}${slug}`;
}

function teamRef(team) {
  return team.slug || team.id;
}

function deploymentLabel(deployment) {
  const bits = [colors.bold(deployment.name)];
  const type = deployment.deploymentType || deployment.type;
  if (type) {
    bits.push(colors.dim(type));
  }
  if (deployment.status) {
    bits.push(colors.statusBadge(deployment.status));
  }
  return bits.filter(Boolean).join(" - ");
}

function deploymentType(deployment) {
  return deployment.deploymentType || deployment.type || "";
}

function sortDeploymentsForChoice(deployments) {
  return [...deployments].sort((a, b) => {
    if (!!a.isDefault !== !!b.isDefault) {
      return a.isDefault ? -1 : 1;
    }
    return String(b.createTime || b.createdAt || "").localeCompare(String(a.createTime || a.createdAt || ""));
  });
}

async function chooseDeploymentForType(type, deployments, chooseOpts = {}) {
  const matches = sortDeploymentsForChoice(
    deployments.filter((d) => deploymentType(d) === type && d.status !== "deleted"),
  );
  debugLog(
    `chooseDeploymentForType(${type}): matched ${matches.length} of ${deployments.length} ` +
    `(types: ${deployments.map((d) => deploymentType(d) || "?").join(",")})`,
  );
  if (matches.length === 0) {
    return null;
  }
  return await choose(
    `${type} deployments`,
    matches.map((d) => ({ label: deploymentLabel(d), value: d })),
    { singularLabel: `${type} deployment`, ...chooseOpts },
  );
}

function parseConvexTarget(args) {
  let target = null;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--target") {
      target = args[index + 1];
      if (!target) {
        throw new Error("--target requires dev or prod");
      }
      index += 2;
      continue;
    }
    if (arg && arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
      index += 1;
      continue;
    }
    break;
  }
  if (target && target !== "dev" && target !== "prod") {
    throw new Error("--target must be dev or prod");
  }
  return {
    explicitTarget: Boolean(target),
    target,
    args: args.slice(index),
  };
}

function inferConvexTarget(args) {
  const command = args.find((arg) => arg && !arg.startsWith("-")) || "";
  return command === "deploy" ? "prod" : "dev";
}

function parseConvexInvocation(args) {
  const parsed = parseConvexTarget(args);
  return {
    ...parsed,
    target: parsed.target || inferConvexTarget(parsed.args),
  };
}

async function resolveConvexInvocation(args, { cfg = null, api = null, projectDir = process.cwd() } = {}) {
  const parsed = parseConvexInvocation(args);
  const projectConfig = readProjectConfig(projectDir);
  if (!projectConfig) {
    if (parsed.explicitTarget) {
      throw new Error("No Synapse project metadata found. Run `synapse select` first.");
    }
    return {
      ...parsed,
      credentials: null,
      deploymentName: "",
      projectConfig: null,
      target: null,
    };
  }

  if (!cfg || !api) {
    throw new Error("Not logged in. Run `synapse login <url>` first.");
  }
  if (
    projectConfig.synapseUrl &&
    cfg.baseUrl &&
    normalizeBaseUrl(projectConfig.synapseUrl) !== normalizeBaseUrl(cfg.baseUrl)
  ) {
    throw new Error(
      `This project is linked to ${projectConfig.synapseUrl}, but the saved Synapse session is for ${cfg.baseUrl}. Run \`synapse login ${projectConfig.synapseUrl}\` or \`synapse select\` again.`,
    );
  }

  const deploymentName = deploymentNameForTarget(projectConfig, parsed.target);
  if (!deploymentName) {
    throw new Error(`No ${parsed.target} deployment saved for this project. Run \`synapse select\` again.`);
  }
  const credentials = await api.cliCredentials(deploymentName);
  return {
    ...parsed,
    credentials,
    deploymentName,
    projectConfig,
  };
}

function formatCredentials(creds, format) {
  switch (format) {
    case "json":
      return JSON.stringify(creds, null, 2);
    case "shell":
      return creds.exportSnippet;
    case "env":
      return creds.envSnippet || `CONVEX_SELF_HOSTED_URL=${quoteEnvValue(creds.convexUrl)}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${quoteEnvValue(creds.adminKey)}`;
    default:
      throw new Error("format must be one of: env, shell, json");
  }
}

function parseFormat(args) {
  let format = "env";
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--format") {
      format = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--format=")) {
      format = arg.slice("--format=".length);
    } else {
      rest.push(arg);
    }
  }
  return { format, rest };
}

async function login(args) {
  const url = args[0];
  if (!url) {
    throw new Error("Usage: synapse login <url>");
  }
  const baseUrl = normalizeBaseUrl(url);
  const { email, password } = await askCredentials();
  const api = new SynapseAPI({ baseUrl });
  const session = await api.login(email, password);
  if (!session.accessToken) {
    throw new Error("Synapse login response did not include accessToken");
  }
  const file = writeConfig({
    baseUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken || null,
    tokenType: session.tokenType || "Bearer",
    user: session.user || null,
  });
  process.stderr.write(`Saved Synapse session to ${file}\n`);
}

async function logout() {
  const removed = clearConfig();
  process.stderr.write(removed ? "Logged out of Synapse.\n" : "No Synapse session was saved.\n");
}

async function whoami() {
  const { cfg, api } = clientFromConfig();
  const me = await api.me();
  const email = me.email || me.user?.email || "(unknown email)";
  const name = me.name || me.user?.name || "";
  process.stdout.write(`${name ? `${name} ` : ""}<${email}> on ${cfg.baseUrl}\n`);
}

// selectDeployment walks the operator through team → project → dev → prod
// pickers, then writes .synapse/project.json + .env.local. Implemented as a
// small state machine so the user can type `b` / `back` at any step to
// re-choose the previous selection without restarting the whole CLI.
//
// Network results are cached per (team, project) so back-navigation stays
// snappy and doesn't burn pagination roundtrips. `DEBUG_SYNAPSE=1` dumps
// the raw lists at each step — useful when an expected deployment is
// missing from the menu.
async function selectDeployment() {
  const { cfg, api } = clientFromConfig();

  const cache = {
    teamsList: null,
    projectsByTeamKey: new Map(),
    deploymentsByProjectId: new Map(),
  };
  async function fetchTeams() {
    if (!cache.teamsList) {
      cache.teamsList = await api.teams();
      debugLog(`teams loaded: ${cache.teamsList.length}`);
    }
    return cache.teamsList;
  }
  async function fetchProjects(team) {
    const key = team.id || team.slug || team.name;
    if (!cache.projectsByTeamKey.has(key)) {
      const projects = await api.projects(teamRef(team));
      cache.projectsByTeamKey.set(key, projects);
      debugLog(`projects for team ${key}: ${projects.length}`);
    }
    return cache.projectsByTeamKey.get(key);
  }
  async function fetchDeployments(project) {
    if (!cache.deploymentsByProjectId.has(project.id)) {
      const deployments = await api.deployments(project.id);
      cache.deploymentsByProjectId.set(project.id, deployments);
      debugLog(`deployments for project ${project.id}: ${deployments.length}`);
    }
    return cache.deploymentsByProjectId.get(project.id);
  }

  let team = null;
  let project = null;
  let dev = null;
  let prod = null;
  let step = "team";
  while (step !== "done") {
    if (step === "team") {
      const teams = await fetchTeams();
      // Back from team would be "exit" — not useful at the top of the flow.
      const picked = await choose(
        "teams",
        teams.map((t) => ({ label: labelName(t), value: t })),
        { singularLabel: "team", allowBack: false },
      );
      team = picked;
      step = "project";
    } else if (step === "project") {
      const projects = await fetchProjects(team);
      const picked = await choose(
        "projects",
        projects.map((p) => ({ label: labelName(p), value: p })),
        { singularLabel: "project", allowBack: true },
      );
      if (picked === BACK) { step = "team"; continue; }
      project = picked;
      step = "dev";
    } else if (step === "dev") {
      const deployments = await fetchDeployments(project);
      const picked = await chooseDeploymentForType("dev", deployments, { allowBack: true });
      if (picked === BACK) { step = "project"; continue; }
      if (picked === null) {
        throw new Error(
          "No dev deployments available in this project. Create one first in the dashboard.",
        );
      }
      dev = picked;
      step = "prod";
    } else if (step === "prod") {
      const deployments = await fetchDeployments(project);
      const picked = await chooseDeploymentForType("prod", deployments, { allowBack: true });
      if (picked === BACK) { step = "dev"; continue; }
      prod = picked; // null is a valid outcome here (project has no prod yet)
      step = "done";
    }
  }

  const projectPath = writeProjectConfig(
    process.cwd(),
    buildProjectConfig({
      synapseUrl: cfg.baseUrl,
      team,
      project,
      deployments: { dev, prod },
    }),
  );
  const creds = await api.cliCredentials(dev.name);
  const envPath = writeProjectEnv(process.cwd(), creds);

  process.stderr.write(`\nLinked ${labelName(project)} to ${projectPath}.\n`);
  process.stderr.write(`Selected dev deployment ${colors.bold(dev.name)}. Updated ${envPath}.\n`);
  if (prod) {
    process.stderr.write(`Selected prod deployment ${colors.bold(prod.name)}.\n`);
  } else {
    process.stderr.write(
      `\n${colors.yellow("Warning:")} no prod deployment found. ` +
      "`synapse deploy` (and `synapse convex deploy`) will fail with a clear " +
      "error until you create a prod deployment and run `synapse select` again.\n",
    );
  }
  if (process.env.CONVEX_DEPLOYMENT) {
    process.stderr.write(
      `\n${colors.yellow("Warning:")} shell CONVEX_DEPLOYMENT is set. ` +
      "Use `synapse dev` / `synapse deploy` / `synapse convex ...` " +
      "or unset CONVEX_DEPLOYMENT before running `npx convex` directly.\n",
    );
  }
  // Discoverability hint (P3-012). The upstream Convex CLI's `dev` command
  // is what pushes the project's schema/functions and starts a dev server;
  // many operators land here from frameworks (Next/Vite) without knowing
  // that, then hit "page hangs forever" the first time their client tries
  // to query a backend that has no code deployed yet. Spell it out.
  process.stderr.write(
    `\nNext step: run ${colors.bold("synapse dev")} (or ${colors.bold("npx convex dev")}) once in this directory ` +
    "to push your schema and watch for changes.\n",
  );
}

async function credentials(args) {
  const { format, rest } = parseFormat(args);
  const deployment = rest[0];
  if (!deployment) {
    throw new Error("Usage: synapse credentials <deployment> [--format env|shell|json]");
  }
  if (!["env", "shell", "json"].includes(format)) {
    throw new Error("format must be one of: env, shell, json");
  }
  const { api } = clientFromConfig();
  const creds = await api.cliCredentials(deployment);
  process.stdout.write(formatCredentials(creds, format) + "\n");
}

async function convex(args) {
  const projectConfig = readProjectConfig(process.cwd());
  let resolved = {
    args,
    credentials: null,
    deploymentName: "",
    target: null,
  };
  if (projectConfig) {
    const { cfg, api } = clientFromConfig();
    resolved = await resolveConvexInvocation(args, { cfg, api });
    process.stderr.write(`Using Synapse ${resolved.target} deployment ${resolved.deploymentName}.\n`);
  } else {
    resolved = await resolveConvexInvocation(args);
  }
  const code = await runConvex(resolved.args, { credentials: resolved.credentials });
  process.exitCode = code;
}

// extractYesFlag pulls --yes / -y out of an arg vector so the rest can be
// passed verbatim to the underlying `convex` invocation. We strip only
// these synapse-level flags; everything else is forwarded.
function extractYesFlag(args) {
  let yes = false;
  const rest = [];
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else {
      rest.push(arg);
    }
  }
  return { yes, rest };
}

// dev is a convenience for `synapse convex --target dev dev`. We delegate
// to the existing convex pipeline so target resolution, credential fetching,
// and env-var sanitization stay in one place.
//
// The `convexImpl` seam exists so unit tests can short-circuit before
// runConvex actually spawns `npx`. Production wiring uses the local
// `convex` function above unchanged.
async function dev(args, { convexImpl = convex } = {}) {
  return await convexImpl(["--target", "dev", "dev", ...args]);
}

// deploy is the same delegation pattern as `dev`, but with a confirmation
// gate because publishing to prod is destructive (overwrites functions and
// schema). The gate is skippable via --yes / -y for CI use. Non-interactive
// callers without --yes get a clear refusal rather than a hang on
// readline.question() that never fires.
//
// We resolve the prod deployment name from the local project metadata so the
// prompt names the exact target. When there's no metadata (no `synapse
// select` yet), we let `convex()` produce its own "run select first" error
// without prompting — the operator obviously isn't ready to deploy.
async function deploy(args, {
  input = process.stdin,
  output = process.stderr,
  confirmImpl = confirm,
  convexImpl = convex,
} = {}) {
  const { yes, rest } = extractYesFlag(args);
  const projectConfig = readProjectConfig(process.cwd());
  const deploymentName = deploymentNameForTarget(projectConfig, "prod");
  if (deploymentName && !yes) {
    if (!input.isTTY) {
      throw new Error(
        "synapse deploy needs confirmation. Pass --yes to skip in non-interactive contexts (CI, scripts), " +
        "or run `synapse deploy` again inside a regular terminal.",
      );
    }
    const ok = await confirmImpl(
      `About to run \`convex deploy\` against PROD deployment ${deploymentName}. Continue? [y/N] `,
      { input, output, defaultAnswer: false },
    );
    if (!ok) {
      output.write("Deploy cancelled.\n");
      return;
    }
  }
  return await convexImpl(["--target", "prod", "deploy", ...rest]);
}

async function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "login":
      return await login(args);
    case "logout":
      return await logout();
    case "whoami":
      return await whoami();
    case "select":
      return await selectDeployment();
    case "credentials":
      return await credentials(args);
    case "dev":
      return await dev(args);
    case "deploy":
      return await deploy(args);
    case "convex":
      return await convex(args);
    case "-h":
    case "--help":
    case "help":
    case undefined:
      process.stdout.write(usage());
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    // Surface a concrete next step for the most common failure mode —
    // the user typed a Synapse URL that doesn't resolve or whose server
    // refused the connection. Without this hint, "fetch failed" reads
    // like a Node bug instead of a config / connectivity problem.
    if (err && err.code === "network_error") {
      process.stderr.write(
        "Hint: double-check the URL is reachable from this machine (try `curl <url>/v1/install_status`) " +
        "and that the Synapse server is running.\n",
      );
    }
    process.exitCode = 1;
  });
}

module.exports = {
  chooseDeploymentForType,
  clientFromConfig,
  deploy,
  dev,
  extractYesFlag,
  formatCredentials,
  inferConvexTarget,
  main,
  parseConvexInvocation,
  parseFormat,
  resolveConvexInvocation,
};
