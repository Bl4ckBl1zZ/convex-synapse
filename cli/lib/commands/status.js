// `synapse status` — quick summary of every deployment in the linked
// project. Status icon + type badge + URL + URL form chip. Mirrors
// what the dashboard's project page shows, in 1 terminal screen.
//
// Works without `synapse select` IF --project=<id> is passed. Otherwise
// reads .synapse/project.json from cwd.

const colors = require("../colors");

// Same heuristic as dashboard/app/embed/[name]/page.tsx:isBrowserReachableURL.
// We classify the URL form so the operator knows at a glance which
// deployments are reachable from the browser vs which fall back to
// the host:port form that needs SYNAPSE_BASE_DOMAIN or a custom domain.
function urlForm(rawUrl, publicUrl) {
  if (!rawUrl) return "unknown";
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return "unknown";
  }
  if (u.pathname.startsWith("/d/")) return "path";
  const STANDARD = new Set(["", "443", "80", "6791"]);
  if (
    !STANDARD.has(u.port) &&
    u.hostname !== "localhost" &&
    u.hostname !== "127.0.0.1"
  ) {
    return "host";
  }
  if (!publicUrl) return "custom";
  try {
    const pu = new URL(publicUrl);
    if (u.hostname === pu.hostname) return "custom";
    if (u.hostname.endsWith("." + pu.hostname)) return "wildcard";
    return "custom";
  } catch {
    return "custom";
  }
}

function parseFlags(args) {
  let projectId = null;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project") {
      projectId = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--project=")) {
      projectId = arg.slice("--project=".length);
    } else {
      rest.push(arg);
    }
  }
  return { projectId, rest };
}

module.exports = {
  name: "status",
  summary: "List deployments in the linked project with status + URL form.",
  usage: "synapse status [--project=<id>] [--json]",
  description: `Lists every deployment in the linked project (or the project given by --project=<id>) along with its status, URL, and URL form ('custom' / 'wildcard' / 'path' / 'host').

The URL form tells you whether the deployment is reachable from a browser:
  custom    bound to a custom domain (api.client.com) — reachable
  wildcard  uses SYNAPSE_BASE_DOMAIN subdomain — reachable
  path      /d/<name>/* via the proxy — browser-reachable but CLI-broken
            (the Convex CLI strips paths from base URLs)
  host      host:port form — NOT reachable from a normal browser
            (Caddy doesn't TLS-front dynamic ports)

Run \`synapse doctor\` for a deeper health check.`,

  // Re-exports for tests.
  urlForm,
  parseFlags,

  async run(args, ctx) {
    const { projectId: explicitProjectId } = parseFlags(args);
    let projectId = explicitProjectId;
    let projectLabel = null;
    if (!projectId) {
      const pc = ctx.requireProject();
      projectId = pc.project.id;
      projectLabel = pc.project.name || pc.project.slug;
    }

    const deployments = await ctx.api.deployments(projectId);
    const baseUrl = ctx.cfg.baseUrl;

    const rows = deployments.map((d) => {
      const type = d.deploymentType || d.type || "";
      const url = d.deploymentUrl || d.url || "";
      return {
        name: d.name,
        type,
        status: d.status,
        url,
        urlForm: urlForm(url, baseUrl),
        isDefault: !!d.isDefault,
        adopted: !!d.adopted,
        haEnabled: !!d.haEnabled,
        replicaCount: d.replicaCount,
      };
    });

    ctx.out.result(
      { projectId, project: projectLabel, deployments: rows },
      (data, { stdout }) => {
        if (data.project) {
          stdout.write(colors.bold(`Project: ${data.project}\n`));
        }
        if (rows.length === 0) {
          stdout.write(colors.dim("(no deployments)\n"));
          return;
        }
        const tag = (form) => {
          switch (form) {
            case "custom":
              return colors.green("custom");
            case "wildcard":
              return colors.green("wildcard");
            case "path":
              return colors.dim("path");
            case "host":
              return colors.red("no-domain");
            default:
              return colors.dim("?");
          }
        };
        ctx.out.table(
          rows.map((r) => ({
            name: colors.bold(r.name),
            type: typeBadge(r.type),
            status: colors.statusBadge(r.status || ""),
            urlForm: tag(r.urlForm),
            url: r.url,
          })),
          [
            { key: "name", header: "NAME" },
            { key: "type", header: "TYPE" },
            { key: "status", header: "STATUS" },
            { key: "urlForm", header: "FORM" },
            { key: "url", header: "URL" },
          ],
        );
        const broken = rows.filter((r) => r.urlForm === "host").length;
        const hasProd = rows.some((r) => r.type === "prod");
        const hasDev = rows.some((r) => r.type === "dev");

        if (broken > 0) {
          stdout.write("\n");
          ctx.out.warn(
            `${broken} deployment${broken > 1 ? "s" : ""} not browser-reachable — instance admin can enable wildcard at ${baseUrl}/admin/host-domain, or add a custom domain per deployment.`,
          );
        }
        // v1.8.5 hints: when nothing's broken, surface the next-step
        // bread-crumb so first-time operators know what to do next.
        if (broken === 0 && rows.length > 0) {
          stdout.write("\n");
          if (!hasProd && hasDev) {
            ctx.out.info(
              `No prod deployment yet. Create one at ${baseUrl}/teams/<team>/${projectId} → "New deployment" → PROD, then \`synapse select\` again.`,
            );
          } else if (hasDev) {
            ctx.out.info("Run `synapse dev` to start a Convex dev session in this directory.");
          }
        }
      },
    );
  },
};

// Tiny tone helper that mirrors the dashboard's envTone() so colors
// stay consistent across UI surfaces.
function typeBadge(t) {
  switch (t) {
    case "prod":
      return colors.yellow(t.toUpperCase());
    case "dev":
      return colors.cyan ? colors.cyan(t.toUpperCase()) : t.toUpperCase();
    case "preview":
      return colors.dim(t.toUpperCase());
    default:
      return t ? colors.dim(t) : "";
  }
}
