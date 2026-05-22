// `synapse list [deployments|projects|teams]` — read-only catalog
// dumper. Single-arg subcommand that mirrors what you'd see in the
// dashboard, but scriptable (every subcommand supports --json).
//
// Resolution rules:
//   - `list teams`        → no flag needed (always lists the operator's teams)
//   - `list projects`     → uses linked team OR --team=<slug|id>
//   - `list deployments`  → uses linked project OR --project=<id>

const colors = require("../colors");
const { extractTeamFlag, extractProjectFlag } = require("./_resource");

const KINDS = ["deployments", "projects", "teams"];

async function listTeams(ctx) {
  const teams = await ctx.api.teams();
  ctx.out.result(
    { kind: "teams", count: teams.length, teams },
    (_d, { stdout }) => {
      if (teams.length === 0) {
        stdout.write(colors.dim("(no teams — create one in the dashboard)\n"));
        return;
      }
      ctx.out.table(
        teams.map((t) => ({
          name: colors.bold(t.name || t.slug || t.id),
          slug: t.slug || colors.dim("?"),
          id: colors.dim(t.id),
        })),
        [
          { key: "name", header: "NAME" },
          { key: "slug", header: "SLUG" },
          { key: "id", header: "ID" },
        ],
      );
    },
  );
}

async function listProjects(ctx, args) {
  const { teamRef: explicit, rest } = extractTeamFlag(args);
  if (rest.length > 0) {
    throw new Error(
      `Unexpected positional: ${rest[0]}. Usage: synapse list projects [--team=<slug|id>]`,
    );
  }
  // Linked-project fallback uses ctx.projectConfig.team.slug.
  let teamRef = explicit;
  let source = "flag";
  if (!teamRef) {
    const linked = ctx.projectConfig;
    if (linked && linked.team && (linked.team.slug || linked.team.id)) {
      teamRef = linked.team.slug || linked.team.id;
      source = "linked";
    }
  }
  if (!teamRef) {
    throw new Error(
      "No linked team. Pass --team=<slug|id> or run `synapse select` first.",
    );
  }
  const projects = await ctx.api.projects(teamRef);
  ctx.out.result(
    { kind: "projects", team: teamRef, teamSource: source, count: projects.length, projects },
    (_d, { stdout }) => {
      stdout.write(colors.dim(`Team: ${teamRef}\n`));
      if (projects.length === 0) {
        stdout.write(colors.dim("(no projects)\n"));
        return;
      }
      ctx.out.table(
        projects.map((p) => ({
          name: colors.bold(p.name || p.slug),
          slug: p.slug || colors.dim("?"),
          id: colors.dim(p.id),
        })),
        [
          { key: "name", header: "NAME" },
          { key: "slug", header: "SLUG" },
          { key: "id", header: "ID" },
        ],
      );
    },
  );
}

async function listDeployments(ctx, args) {
  const { projectId: explicit, rest } = extractProjectFlag(args);
  if (rest.length > 0) {
    throw new Error(
      `Unexpected positional: ${rest[0]}. Usage: synapse list deployments [--project=<id>]`,
    );
  }
  let projectId = explicit;
  let source = "flag";
  if (!projectId) {
    const linked = ctx.projectConfig;
    if (linked && linked.project && linked.project.id) {
      projectId = linked.project.id;
      source = "linked";
    }
  }
  if (!projectId) {
    throw new Error(
      "No linked project. Pass --project=<id> or run `synapse select` first.",
    );
  }
  const deployments = await ctx.api.deployments(projectId);
  ctx.out.result(
    { kind: "deployments", projectId, projectSource: source, count: deployments.length, deployments },
    (_d, { stdout }) => {
      stdout.write(colors.dim(`Project: ${projectId}\n`));
      if (deployments.length === 0) {
        stdout.write(colors.dim("(no deployments — create one with `synapse deployment create`)\n"));
        return;
      }
      ctx.out.table(
        deployments.map((d) => ({
          name: colors.bold(d.name),
          type: typeBadge(d.deploymentType || d.type),
          status: colors.statusBadge(d.status || ""),
          url: d.deploymentUrl || d.url || colors.dim("(no url)"),
        })),
        [
          { key: "name", header: "NAME" },
          { key: "type", header: "TYPE" },
          { key: "status", header: "STATUS" },
          { key: "url", header: "URL" },
        ],
      );
    },
  );
}

function typeBadge(t) {
  switch (t) {
    case "prod":
      return colors.yellow((t || "").toUpperCase());
    case "dev":
      return colors.cyan ? colors.cyan(t.toUpperCase()) : t.toUpperCase();
    case "preview":
      return colors.dim((t || "").toUpperCase());
    default:
      return t ? colors.dim(t) : "";
  }
}

module.exports = {
  name: "list",
  summary: "List teams, projects, or deployments visible to your session.",
  usage: "synapse list <deployments|projects|teams> [--project=<id>] [--team=<slug>] [--json]",
  description: `Catalogs the resource of the chosen kind. All subcommands support --json for scripting.

Resource resolution:
  list teams        always lists every team you're a member of
  list projects     uses the linked team if no --team flag
  list deployments  uses the linked project if no --project flag

Examples:
  synapse list teams
  synapse list projects --team=amageia
  synapse list deployments --project=00000000-0000-0000-0000-000000000000
  synapse list deployments --json | jq '.deployments[] | .name'`,

  // Exports for tests.
  KINDS,
  listTeams,
  listProjects,
  listDeployments,

  async run(args, ctx) {
    const kind = args[0];
    if (!kind) {
      throw new Error(`Usage: synapse list <${KINDS.join("|")}>`);
    }
    if (!KINDS.includes(kind)) {
      throw new Error(
        `Unknown list kind: ${kind}. Try: ${KINDS.join(" | ")}.`,
      );
    }
    const rest = args.slice(1);
    if (kind === "teams") return listTeams(ctx);
    if (kind === "projects") return listProjects(ctx, rest);
    return listDeployments(ctx, rest);
  },
};
