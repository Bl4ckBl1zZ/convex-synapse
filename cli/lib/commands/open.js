// `synapse open [target]` — launches a URL in the operator's default
// browser. Cross-platform via the right `open` / `xdg-open` / `start`
// command per OS.
//
// Targets:
//   (default)        the linked project's page in the Synapse dashboard
//   dashboard        same as default
//   docs             docs.convex.dev (the upstream Convex docs)
//   deployment <n>   /embed/<name> — the dashboard with Convex Dashboard iframe
//   url              just the synapse base URL (for "open the dashboard root")
//
// For `dashboard` (the default), we do a single cheap GET probe against
// the linked project before spawning the browser, so an operator with a
// stale .synapse/project.json gets a warning on stderr instead of
// landing on a page that cascades "Failed to load X" errors. We never
// BLOCK the launch — operator may want to see the broken state.
// `docs` / `deployment <name>` / `url` skip the probe.

const { spawn } = require("node:child_process");
const { SynapseAPIError } = require("../api");

function buildUrl(target, restArgs, { cfg, projectConfig }) {
  const base = cfg?.baseUrl ?? "";
  switch (target) {
    case undefined:
    case "dashboard": {
      if (projectConfig?.team?.slug && projectConfig?.project?.id) {
        return `${base}/teams/${encodeURIComponent(projectConfig.team.slug)}/${encodeURIComponent(projectConfig.project.id)}`;
      }
      // Fall back to /teams (operator picks the project visually).
      return `${base}/teams`;
    }
    case "docs":
      return "https://docs.convex.dev";
    case "deployment": {
      const name = restArgs[0];
      if (!name) {
        throw new Error("Usage: synapse open deployment <name>");
      }
      return `${base}/embed/${encodeURIComponent(name)}`;
    }
    case "url":
      return base || "https://docs.convex.dev";
    default:
      throw new Error(
        `Unknown target: ${target}. Try: dashboard | docs | deployment <name> | url`,
      );
  }
}

function launcher(platform = process.platform) {
  if (platform === "darwin") return { cmd: "open", shell: false };
  if (platform === "win32") return { cmd: "start", shell: true };
  // Linux + others
  return { cmd: "xdg-open", shell: false };
}

// Cheap pre-flight probe: confirm the linked project still exists before
// launching the browser. Returns one of:
//   "ok"          — project resolved on the backend
//   "not_found"   — backend returned 404 (project deleted or transferred)
//   "unverified"  — couldn't reach backend / non-404 error / no session /
//                   no linked project
// Only `dashboard` target calls this — `docs` is external, `deployment
// <name>` and `url` are operator-supplied + assumed intentional.
async function checkProjectStatus(ctx, projectConfig) {
  if (!projectConfig?.project?.id) return "unverified";
  if (!ctx?.cfgOrNull?.accessToken) return "unverified";
  if (!ctx.api) return "unverified";
  try {
    await ctx.api.getProject(projectConfig.project.id);
    return "ok";
  } catch (err) {
    if (err instanceof SynapseAPIError && err.status === 404) {
      return "not_found";
    }
    return "unverified";
  }
}

module.exports = {
  name: "open",
  summary: "Open a Synapse-related URL in your default browser.",
  usage: "synapse open [dashboard|docs|deployment <name>|url] [--json]",
  description: `Launches a browser. With no argument, opens the linked project's page in the dashboard.

Targets:
  dashboard       project page on the Synapse dashboard (default)
  docs            https://docs.convex.dev
  deployment <n>  /embed/<n> — Convex Dashboard iframe shell
  url             the saved Synapse base URL`,

  // Exports for tests.
  buildUrl,
  launcher,
  checkProjectStatus,

  async run(args, ctx) {
    const target = args[0];
    const url = buildUrl(target, args.slice(1), {
      cfg: ctx.cfgOrNull,
      projectConfig: ctx.projectConfig,
    });

    // Pre-flight only for dashboard (default + explicit). Other targets
    // either point externally or are intentionally URL-direct.
    const shouldProbe = target === undefined || target === "dashboard";
    let projectStatus = "unverified";
    if (shouldProbe && ctx.projectConfig?.project?.id) {
      projectStatus = await checkProjectStatus(ctx, ctx.projectConfig);
    }

    if (ctx.out.json) {
      ctx.out.result({ url, target: target ?? "dashboard", projectStatus }, () => {});
      return;
    }

    if (projectStatus === "not_found") {
      const projName = ctx.projectConfig?.project?.name || ctx.projectConfig?.project?.id;
      const base = ctx.cfgOrNull?.baseUrl ?? "";
      ctx.out.warn(
        `Linked project ${projName} was not found on ${base}. It may have been deleted. Run \`synapse select\` to relink.`,
      );
    } else if (shouldProbe && projectStatus === "unverified" && ctx.projectConfig?.project?.id && ctx.cfgOrNull?.accessToken) {
      ctx.out.info("Could not verify project state (offline?), opening anyway.");
    }

    const { cmd, shell } = launcher();
    ctx.out.info(`Opening ${url}`);
    try {
      const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell });
      child.unref();
    } catch (err) {
      // If the launcher isn't on PATH (rare — xdg-open is part of
      // xdg-utils, ships on every desktop Linux), the operator can
      // still see the URL we tried.
      ctx.out.error(`Could not launch browser: ${err.message}`, {
        hint: `Open this URL manually: ${url}`,
      });
      process.exitCode = 1;
    }
  },
};
