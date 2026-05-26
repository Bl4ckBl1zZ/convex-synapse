// Cell Control Plane — Desired / Observed / Drift / Reconcile dry-run (Bloco 5).
//
// Diagnose + plan ONLY. `reconcile dry-run` never applies and never sends
// apply:true; an `--apply` flag is rejected with a clear error. Drift diffs +
// the dry-run plan are redacted before printing.

const colors = require("../colors");
const { resolveProject } = require("./_resource");
const {
  resolveScope,
  extractValueFlag,
  redactDriftItems,
  redactOperationRun,
  renderDrift,
  renderDryRun,
} = require("./_cellplane");

const desiredSync = {
  name: "desired sync",
  summary: "Derive desired state from placements (idempotent; applies nothing).",
  usage: "synapse desired sync --project <id> [--json]",
  description: `Runs sync_from_placements: derives the project's DesiredState from its deployment placements. Idempotent and side-effect-free on hosts — it only records intent.`,
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const res = await ctx.api.desiredSync(projectId);
    ctx.out.result({ projectId, ...res }, () => {
      ctx.out.stdout.write(
        `${colors.green("Synced desired state")} ` +
          colors.dim(
            `created ${res.created ?? 0} · updated ${res.updated ?? 0} · unchanged ${res.unchanged ?? 0} · superseded ${res.superseded ?? 0}\n`,
          ),
      );
      ctx.out.stdout.write(colors.dim("No changes were applied to hosts.\n"));
    });
  },
};

const desiredList = {
  name: "desired list",
  summary: "List active desired states (by project or host).",
  usage: "synapse desired list (--project <id> | --host <id>) [--json]",
  async run(args, ctx) {
    const host = extractValueFlag(args, "host");
    let scope;
    let id;
    let desired;
    if (host.value) {
      scope = "host";
      id = host.value;
      desired = await ctx.api.hostDesiredState(id);
    } else {
      const proj = resolveProject(ctx, host.rest);
      scope = "project";
      id = proj.projectId;
      desired = await ctx.api.desiredListProject(id);
    }
    ctx.out.result({ scope, id, count: desired.length, desired }, () => {
      ctx.out.table(
        desired.map((d) => ({
          resourceKey: d.resourceKey,
          status: d.status,
          version: d.version,
          host: String(d.hostId || "").slice(0, 8),
          source: d.source,
        })),
        [
          { key: "resourceKey", header: "RESOURCE" },
          { key: "status", header: "STATUS" },
          { key: "version", header: "VER", align: "right" },
          { key: "host", header: "HOST" },
          { key: "source", header: "SOURCE" },
        ],
      );
    });
  },
};

const observedList = {
  name: "observed list",
  summary: "List a host's observed state (host facts + synapse-managed containers).",
  usage: "synapse observed list --host <id> [--json]",
  async run(args, ctx) {
    const host = extractValueFlag(args, "host");
    if (!host.value) throw new Error("Usage: synapse observed list --host <host-id>");
    const observed = await ctx.api.hostObservedState(host.value);
    ctx.out.result({ hostId: host.value, count: observed.length, observed }, () => {
      ctx.out.table(
        observed.map((o) => ({
          resourceType: o.resourceType,
          resourceKey: o.resourceKey,
          state: (o.observed && o.observed.state) || "",
          observedAt: o.observedAt || "",
        })),
        [
          { key: "resourceType", header: "TYPE" },
          { key: "resourceKey", header: "RESOURCE" },
          { key: "state", header: "STATE" },
          { key: "observedAt", header: "OBSERVED AT" },
        ],
      );
    });
  },
};

const driftRecompute = {
  name: "drift recompute",
  summary: "Recompute drift for a host / cell / project (diagnosis only).",
  usage: "synapse drift recompute (--project <id> | --cell <id> | --host <id>) [--json]",
  async run(args, ctx) {
    const { scope, id, rest } = resolveScope(ctx, args);
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const res = await ctx.api.driftRecompute(scope, id);
    const data = { scope, id, report: res.report ?? null, items: redactDriftItems(res.items || []) };
    ctx.out.result(data, () => renderDrift(ctx.out, data));
  },
};

const driftLatest = {
  name: "drift latest",
  summary: "Show the latest drift report for a host / cell / project.",
  usage: "synapse drift latest (--project <id> | --cell <id> | --host <id>) [--json]",
  async run(args, ctx) {
    const { scope, id, rest } = resolveScope(ctx, args);
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const res = await ctx.api.driftLatest(scope, id);
    const data = { scope, id, report: res.report ?? null, items: redactDriftItems(res.items || []) };
    ctx.out.result(data, () => renderDrift(ctx.out, data));
  },
};

const reconcileDryRun = {
  name: "reconcile dry-run",
  summary: "Build a reconcile plan (dry-run only — applies nothing).",
  usage: "synapse reconcile dry-run (--project <id> | --cell <id> | --host <id>) [--json]",
  description: `Builds a reconcile plan from current drift. Every step is planned/no-op/skipped; applyAllowed=false; nothing is sent to the agent.

There is no apply mode. Passing --apply is an error.`,
  async run(args, ctx) {
    // Hard guard: the CLI has no apply path and never sends apply:true.
    if (args.some((a) => a === "--apply" || a.startsWith("--apply="))) {
      throw new Error(
        "apply is not implemented; this CLI only supports dry-run. The agent is observe-only and nothing is ever applied.",
      );
    }
    const { scope, id, rest } = resolveScope(ctx, args);
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const res = await ctx.api.reconcileDryRun(scope, id);
    const data = {
      scope,
      id,
      operationRun: redactOperationRun(res.operationRun),
      steps: res.steps || [],
    };
    ctx.out.result(data, () => renderDryRun(ctx.out, data));
  },
};

module.exports = [
  desiredSync,
  desiredList,
  observedList,
  driftRecompute,
  driftLatest,
  reconcileDryRun,
];
