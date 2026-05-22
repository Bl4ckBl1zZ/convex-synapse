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
// No backend call; everything is built client-side from the saved cfg
// + projectConfig.

const { spawn } = require("node:child_process");

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

  async run(args, ctx) {
    const target = args[0];
    const url = buildUrl(target, args.slice(1), {
      cfg: ctx.cfgOrNull,
      projectConfig: ctx.projectConfig,
    });

    if (ctx.out.json) {
      ctx.out.result({ url, target: target ?? "dashboard" }, () => {});
      return;
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
