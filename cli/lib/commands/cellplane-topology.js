// Cell Control Plane — Topology (Bloco 5). Read-only Host → Cell → Deployment
// → Links tree, with warnings. Project-RBAC server-side.

const { resolveProject } = require("./_resource");
const { renderTopology } = require("./_cellplane");

const topologyShow = {
  name: "topology show",
  summary: "Show the Host → Cell → Deployment → Links topology for a project.",
  usage: "synapse topology show --project <id> [--json]",
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const topo = await ctx.api.cellTopology(projectId);
    ctx.out.result(topo, () => renderTopology(ctx.out, topo));
  },
};

module.exports = [topologyShow];
