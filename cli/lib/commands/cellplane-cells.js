// Cell Control Plane — Cells (Bloco 5). Project-RBAC server-side.
// Create metadata + attach resources; no host mutation.

const colors = require("../colors");
const { extractFlags, resolveProject } = require("./_resource");

const KINDS = new Set(["core", "runtime", "integration", "preview", "enterprise-app"]);
const ENVS = new Set(["dev", "staging", "prod", "preview"]);

const cellsList = {
  name: "cells list",
  summary: "List the cells in a project.",
  usage: "synapse cells list --project <id> [--json]",
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const cells = await ctx.api.cellsList(projectId);
    ctx.out.result({ kind: "cells", projectId, count: cells.length, cells }, () => {
      ctx.out.table(
        cells.map((c) => ({
          name: c.name,
          kind: c.kind,
          env: c.environment,
          status: c.status,
          id: c.id,
        })),
        [
          { key: "name", header: "NAME" },
          { key: "kind", header: "KIND" },
          { key: "env", header: "ENV" },
          { key: "status", header: "STATUS" },
          { key: "id", header: "ID" },
        ],
      );
    });
  },
};

const cellsShow = {
  name: "cells show",
  summary: "Show a single cell.",
  usage: "synapse cells show <cell-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse cells show <cell-id>");
    const cell = await ctx.api.cellGet(id);
    ctx.out.result({ cell }, () => {
      const w = ctx.out.stdout;
      w.write(`${colors.bold(cell.name)} ${colors.dim("(" + cell.id + ")")}\n`);
      w.write(colors.dim(`  kind: ${cell.kind} · env: ${cell.environment} · status: ${cell.status}\n`));
      if (cell.region) w.write(colors.dim(`  region: ${cell.region} · tier: ${cell.isolationTier}\n`));
      if (cell.primaryDeploymentId) w.write(colors.dim(`  primary deployment: ${cell.primaryDeploymentId}\n`));
      if (cell.primaryHostId) w.write(colors.dim(`  primary host: ${cell.primaryHostId}\n`));
    });
  },
};

const cellsCreate = {
  name: "cells create",
  summary: "Create a cell under a project.",
  usage:
    "synapse cells create --project <id> --name <name> [--kind core|runtime|integration|preview|enterprise-app] [--env dev|staging|prod|preview] [--region <r>] [--isolation-tier shared|premium|dedicated|internal] [--json]",
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    const { flags, rest: leftover } = extractFlags(rest, {
      string: ["name", "kind", "env", "region", "isolation-tier"],
    });
    if (leftover.length > 0) throw new Error(`Unexpected argument: ${leftover[0]}`);
    if (!flags.name) throw new Error("Usage: synapse cells create --project <id> --name <name> [...]");
    if (flags.kind && !KINDS.has(flags.kind)) {
      throw new Error(`Invalid --kind: ${flags.kind}. One of: ${[...KINDS].join(", ")}.`);
    }
    if (flags.env && !ENVS.has(flags.env)) {
      throw new Error(`Invalid --env: ${flags.env}. One of: ${[...ENVS].join(", ")}.`);
    }
    const body = { name: flags.name };
    if (flags.kind) body.kind = flags.kind;
    if (flags.env) body.environment = flags.env;
    if (flags.region) body.region = flags.region;
    if (flags["isolation-tier"]) body.isolationTier = flags["isolation-tier"];

    const cell = await ctx.api.cellCreate(projectId, body);
    ctx.out.result({ cell }, () => {
      ctx.out.stdout.write(
        `${colors.green("Created cell")} ${colors.bold(cell.name)} ${colors.dim(`(${cell.kind}/${cell.environment}, ${cell.id})`)}\n`,
      );
    });
  },
};

const cellsAttachDeployment = {
  name: "cells attach-deployment",
  summary: "Attach a deployment to a cell (creates a placement).",
  usage: "synapse cells attach-deployment <cell-id> <deployment-name> [--role <role>] [--json]",
  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, { string: ["role"] });
    const [cellId, deployment] = rest;
    if (!cellId || !deployment) {
      throw new Error("Usage: synapse cells attach-deployment <cell-id> <deployment-name>");
    }
    const res = await ctx.api.cellAttachDeployment(cellId, deployment, flags.role);
    ctx.out.result(res, () => {
      ctx.out.stdout.write(
        `${colors.green("Attached")} ${colors.bold(deployment)} → cell ${colors.bold(res.cell ? res.cell.name : cellId)}\n`,
      );
    });
  },
};

const cellsAttachHost = {
  name: "cells attach-host",
  summary: "Set a cell's primary host (accepts host id or name).",
  usage: "synapse cells attach-host <cell-id> <host-id-or-name> [--json]",
  async run(args, ctx) {
    const [cellId, host] = args;
    if (!cellId || !host) {
      throw new Error("Usage: synapse cells attach-host <cell-id> <host-id-or-name>");
    }
    const cell = await ctx.api.cellAttachHost(cellId, host);
    ctx.out.result({ cell }, () => {
      ctx.out.stdout.write(
        `${colors.green("Attached host")} ${colors.bold(host)} → cell ${colors.bold(cell.name || cellId)}\n`,
      );
    });
  },
};

const cellsResources = {
  name: "cells resources",
  summary: "List a cell's resources + placements.",
  usage: "synapse cells resources <cell-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse cells resources <cell-id>");
    const res = await ctx.api.cellResources(id);
    const resources = res.resources || [];
    const placements = res.placements || [];
    ctx.out.result(res, () => {
      const w = ctx.out.stdout;
      w.write(colors.dim(`Resources (${resources.length}):\n`));
      for (const r of resources) {
        w.write(`  ${r.resourceType} ${r.resourceId} ${colors.dim("[" + r.role + "]")}\n`);
      }
      w.write(colors.dim(`Placements (${placements.length}):\n`));
      for (const p of placements) {
        w.write(
          `  deployment ${p.deploymentId} → host ${p.hostId || "—"} ` +
            colors.dim(`desired=${p.desiredStatus} observed=${p.observedStatus}\n`),
        );
      }
    });
  },
};

const cellsDrain = {
  name: "cells drain",
  summary: "Mark a cell as draining (operator intent; observe-only).",
  usage: "synapse cells drain <cell-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse cells drain <cell-id>");
    const cell = await ctx.api.cellDrain(id);
    ctx.out.result({ cell }, () => {
      ctx.out.stdout.write(
        `${colors.yellow("Draining")} cell ${colors.bold(cell.name || id)} ${colors.dim("(records intent only)")}\n`,
      );
    });
  },
};

const cellsDelete = {
  name: "cells delete",
  summary: "Delete a cell. Deployments in it become unassigned (they keep running).",
  usage: "synapse cells delete <cell-id> --yes [--json]",
  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, { boolean: ["yes"] });
    const id = rest[0];
    if (!id) throw new Error("Usage: synapse cells delete <cell-id> --yes");
    if (!flags.yes) {
      throw new Error(
        "Refusing to delete a cell without --yes. Re-run with --yes to confirm. (Deployments in it keep running — they just become unassigned.)",
      );
    }
    const res = await ctx.api.cellDelete(id);
    ctx.out.result(res, () => {
      ctx.out.stdout.write(`${colors.red("Deleted")} cell ${colors.bold(id)}\n`);
    });
  },
};

module.exports = [
  cellsList,
  cellsShow,
  cellsCreate,
  cellsAttachDeployment,
  cellsAttachHost,
  cellsResources,
  cellsDrain,
  cellsDelete,
];
