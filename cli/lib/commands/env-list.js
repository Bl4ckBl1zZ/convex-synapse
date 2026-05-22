// `synapse env list [--for=dev|prod|preview] [--project=<id>] [--json]`
//
// Lists project-level (default) environment variables. These are
// injected into the Convex backend container at provision time;
// changing one only affects deployments that haven't been created yet
// UNLESS a separate `sync_env_to_deployments` job is triggered (see
// the dashboard's env panel).
//
// The `--for=<type>` filter narrows to vars whose deploymentTypes
// array includes the type. Omitted = show every var with its type set.

const colors = require("../colors");
const { extractFlags, resolveProject } = require("./_resource");

const VALID_FORS = new Set(["dev", "prod", "preview"]);

module.exports = {
  name: "env list",
  summary: "List project-default environment variables.",
  usage:
    "synapse env list [--for=<dev|prod|preview>] [--project=<id>] [--mask] [--json]",
  description: `Calls GET /v1/projects/{id}/list_default_environment_variables. Default behaviour shows the variable VALUES — pass --mask to redact them (useful when sharing a terminal recording).

Flags:
  --for=<type>       Filter to vars whose deploymentTypes include <type>.
  --project=<id>     Override the linked project.
  --mask             Redact values to "********" (length-preserving).
  --json             Machine-readable output.

Examples:
  synapse env list
  synapse env list --for=prod --mask
  synapse env list --json | jq '.configs[].name'`,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: ["for", "project"],
      boolean: ["mask", "json"],
    });
    if (rest.length > 0) {
      throw new Error(`Unexpected positional: ${rest[0]}.`);
    }
    const filter = typeof flags.for === "string" ? flags.for.toLowerCase() : null;
    if (filter && !VALID_FORS.has(filter)) {
      throw new Error(
        `Invalid --for: ${filter}. Must be one of: ${[...VALID_FORS].join(", ")}.`,
      );
    }
    const mask = flags.mask === true || flags.mask === "true";

    const resolveArgs = flags.project ? [`--project=${flags.project}`] : [];
    const { projectId, source } = resolveProject(ctx, resolveArgs);

    const resp = await ctx.api.listProjectEnvVars(projectId);
    let configs = resp.configs || [];
    if (filter) {
      configs = configs.filter(
        (c) => Array.isArray(c.deploymentTypes) && c.deploymentTypes.includes(filter),
      );
    }
    // Stable order for piping into diff tools.
    configs.sort((a, b) => a.name.localeCompare(b.name));

    ctx.out.result(
      {
        projectId,
        projectSource: source,
        count: configs.length,
        filter,
        masked: mask,
        configs: mask
          ? configs.map((c) => ({ ...c, value: maskValue(c.value) }))
          : configs,
      },
      (_d, { stdout }) => {
        stdout.write(colors.dim(`Project: ${projectId}${filter ? `  · filter: ${filter}` : ""}\n`));
        if (configs.length === 0) {
          stdout.write(colors.dim("(no env vars)\n"));
          return;
        }
        ctx.out.table(
          configs.map((c) => ({
            name: colors.bold(c.name),
            value: mask ? colors.dim(maskValue(c.value)) : c.value,
            types: (c.deploymentTypes || []).join(",") || colors.dim("(all)"),
          })),
          [
            { key: "name", header: "NAME" },
            { key: "value", header: "VALUE" },
            { key: "types", header: "DEPLOYMENT_TYPES" },
          ],
        );
      },
    );
  },
};

// Length-preserving redaction. Operators sometimes screenshot the
// output to share — a fixed-length blob would leak the length.
function maskValue(v) {
  if (v === undefined || v === null || v === "") return "";
  return "*".repeat(String(v).length);
}

module.exports.maskValue = maskValue;
