// Cell Control Plane — Operation runs (Bloco 5). Read-only audit trail of
// sync / compute_drift / reconcile_dry_run. input/plan/result are redacted.

const { resolveProject } = require("./_resource");
const { redactOperationRun, renderOperationRun } = require("./_cellplane");

const operationsList = {
  name: "operations list",
  summary: "List recent operation runs for a project.",
  usage: "synapse operations list --project <id> [--json]",
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const runs = await ctx.api.operationRunsList(projectId);
    ctx.out.result({ projectId, count: runs.length, operationRuns: runs }, () => {
      ctx.out.table(
        runs.map((r) => ({
          type: r.type,
          status: r.status,
          scope: scopeLabel(r),
          created: r.createdAt || "",
          id: r.id,
        })),
        [
          { key: "type", header: "TYPE" },
          { key: "status", header: "STATUS" },
          { key: "scope", header: "SCOPE" },
          { key: "created", header: "CREATED" },
          { key: "id", header: "ID" },
        ],
      );
    });
  },
};

const operationsShow = {
  name: "operations show",
  summary: "Show an operation run + its planned steps.",
  usage: "synapse operations show <operation-run-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse operations show <operation-run-id>");
    const res = await ctx.api.operationRunGet(id);
    const data = {
      operationRun: redactOperationRun(res.operationRun),
      steps: res.steps || [],
    };
    ctx.out.result(data, () => renderOperationRun(ctx.out, data));
  },
};

function scopeLabel(r) {
  if (r.hostId) return "host";
  if (r.cellId) return "cell";
  if (r.deploymentId) return "deployment";
  if (r.projectId) return "project";
  return "—";
}

module.exports = [operationsList, operationsShow];
