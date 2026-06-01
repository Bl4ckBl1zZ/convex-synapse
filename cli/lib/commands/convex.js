// `synapse convex [--target dev|prod] [...args]` — escape hatch that
// delegates to `npx convex <args>` while wiring up Synapse credentials
// transparently. Used directly when the operator needs a Convex
// subcommand without a Synapse shortcut (run, env list, import, etc).
//
// `synapse dev` and `synapse deploy` are thin wrappers around this
// same flow with the target pre-set and (for deploy) a confirmation
// prompt.

const { runConvex } = require("../convex");
const { guardPublicConvexUrls, reassertPublicConvexUrls } = require("../env-file");
const { normalizeBaseUrl } = require("../config");
const {
  deploymentNameForTarget,
  readProjectConfig,
} = require("../project");

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

async function resolveConvexInvocation(
  args,
  { cfg = null, api = null, projectDir = process.cwd() } = {},
) {
  const parsed = parseConvexInvocation(args);
  const projectConfig = readProjectConfig(projectDir);
  if (!projectConfig) {
    if (parsed.explicitTarget) {
      throw new Error(
        "No Synapse project metadata found. Run `synapse select` first.",
      );
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
    throw new Error(
      `No ${parsed.target} deployment saved for this project. Run \`synapse select\` again.`,
    );
  }
  const credentials = await api.cliCredentials(deploymentName);
  return {
    ...parsed,
    credentials,
    deploymentName,
    projectConfig,
  };
}

async function runConvexCommand(args, ctx) {
  const projectConfig = readProjectConfig(ctx.cwd);
  let resolved;
  if (projectConfig) {
    // Need an authenticated session to fetch fresh credentials.
    const cfg = ctx.cfg;
    const api = ctx.api;
    resolved = await resolveConvexInvocation(args, { cfg, api, projectDir: ctx.cwd });
    ctx.out.info(
      `Using Synapse ${resolved.target} deployment ${resolved.deploymentName}.`,
    );
    // Synapse owns NEXT_PUBLIC_CONVEX_URL / NEXT_PUBLIC_CONVEX_SITE_URL.
    // The upstream `npx convex` re-derives them on every run from the
    // backend container's GET /get_canonical_urls and overwrites
    // .env.local (it may also print "Can't safely modify ... please edit
    // manually" — benign). That container value can lag the
    // deployment_domains table, so for a deployment with a role='site'
    // custom domain it would clobber the distinct HTTP-actions host with
    // the cloud URL. We re-assert the authoritative values (from
    // cli_credentials) during + after the run — see
    // env-file.reassertPublicConvexUrls and docs/CONVEX_SITE_ORIGIN.md.
    ctx.out.info(
      "(npx convex may rewrite NEXT_PUBLIC_CONVEX_SITE_URL — Synapse re-asserts the correct value.)",
    );
  } else {
    resolved = await resolveConvexInvocation(args, { projectDir: ctx.cwd });
  }
  // Keep .env.local's public URLs correct for the whole run: a long-running
  // `dev` lets upstream clobber NEXT_PUBLIC_CONVEX_SITE_URL mid-session, so
  // guard the file while convex runs, then do a final authoritative
  // re-assert on exit (covers one-shots like `deploy` and the case where
  // upstream created .env.local during the run).
  const stopEnvGuard = guardPublicConvexUrls(ctx.cwd, resolved.credentials);
  let code;
  try {
    code = await runConvex(resolved.args, { credentials: resolved.credentials });
  } finally {
    stopEnvGuard();
    if (resolved.credentials) {
      try {
        reassertPublicConvexUrls(ctx.cwd, resolved.credentials);
      } catch {
        // Best-effort — never fail the convex command over an env tidy-up.
      }
    }
  }
  // v1.8.6 (A5): when npx convex exits non-zero, surface a hint about
  // where the failure came from — operators see a `[X]` from convex
  // and assume Synapse broke. Point them at the right `--help`.
  if (code !== 0) {
    ctx.out.info(
      `\n(npx convex exited ${code}. If this looks like an unknown-command typo, run \`synapse convex --help\` for the upstream Convex help.)`,
    );
  }
  process.exitCode = code;
}

module.exports = {
  name: "convex",
  summary: "Run any `convex` subcommand with Synapse credentials injected.",
  usage: "synapse convex [--target dev|prod] [...args]",
  description: `Escape hatch for any \`convex\` invocation that doesn't have a Synapse shortcut. Resolves the right deployment from the linked project, fetches fresh credentials from the backend, scrubs CONVEX_DEPLOYMENT from the child env, and spawns \`npx convex\` with the rest of the args.

Examples:
  synapse convex --help                     # show convex's help
  synapse convex run messages:list          # run a function against dev
  synapse convex --target prod env list     # list prod env vars
  synapse convex import data.snapshot.gz    # restore a snapshot to dev

By default the target is inferred: \`deploy\` → prod, everything else → dev.`,

  // Exports kept for the legacy test imports.
  inferConvexTarget,
  parseConvexInvocation,
  parseConvexTarget,
  resolveConvexInvocation,
  runConvexCommand,

  async run(args, ctx) {
    return await runConvexCommand(args, ctx);
  },
};
