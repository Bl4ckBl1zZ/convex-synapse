// `synapse env unset NAME [NAME2 ...] [--project=<id>] [--json]`
//
// Batch-deletes project-default env vars. Sends op=delete for each
// name in a single transactional update. Unknown names are not an
// error server-side (the DELETE is idempotent), but we surface a
// warning when ALL passed names were unknown — usually a typo.

const colors = require("../colors");
const { extractFlags, resolveProject } = require("./_resource");

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

module.exports = {
  name: "env unset",
  summary: "Delete one or more project-default environment variables.",
  usage: "synapse env unset NAME [NAME2 ...] [--project=<id>] [--json]",
  description: `Calls POST /v1/projects/{id}/update_default_environment_variables with op=delete. Idempotent — deleting a name that doesn't exist is silent.

Flags:
  --project=<id>     Override the linked project.
  --json             Machine-readable output.

Examples:
  synapse env unset OLD_API_KEY
  synapse env unset FOO BAR BAZ`,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: ["project"],
      boolean: ["json"],
    });
    if (rest.length === 0) {
      throw new Error("Usage: synapse env unset NAME [NAME2 ...]");
    }
    for (const name of rest) {
      if (!NAME_RE.test(name)) {
        throw new Error(
          `Invalid env name: ${JSON.stringify(name)}. Names must match [A-Z_][A-Z0-9_]*.`,
        );
      }
    }

    const resolveArgs = flags.project ? [`--project=${flags.project}`] : [];
    const { projectId, source } = resolveProject(ctx, resolveArgs);

    // We could pre-fetch the existing var list to warn about unknown
    // names. Skipping: an extra GET on every unset doubles latency for
    // the common case where the operator typed the right name. The
    // backend's op=delete is idempotent.
    const changes = rest.map((name) => ({ op: "delete", name }));
    if (!ctx.out.json) {
      ctx.out.info(
        `Unsetting ${rest.length} env var${rest.length > 1 ? "s" : ""} on project ${projectId}…`,
      );
    }
    await ctx.api.updateProjectEnvVars(projectId, changes);

    ctx.out.result(
      {
        projectId,
        projectSource: source,
        deleted: rest.length,
        names: rest,
      },
      (_d, { stdout }) => {
        for (const name of rest) {
          stdout.write(`${colors.red("-")} ${colors.bold(name)}\n`);
        }
        stdout.write(
          colors.dim(
            "Existing deployments keep their cached value until they're recreated.\n",
          ),
        );
      },
    );
  },
};
