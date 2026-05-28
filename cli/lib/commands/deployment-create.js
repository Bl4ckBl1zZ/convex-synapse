// `synapse deployment create [--type=dev|prod|preview|custom] [--ha]
//   [--default] [--project=<id>] [--json]`
//
// Provisions a new Convex backend container under the linked (or
// --project=) project. The backend generates the deployment name
// (animal-adjective-NNNN) — we don't accept it as an arg, matching
// Convex Cloud's contract.
//
// Safety: prod creation prompts for `--yes` (or stdin "yes") because
// the container is real, gets a host port, and counts against quota.
// dev creates straight through.

const colors = require("../colors");
const { extractFlags, resolveProject } = require("./_resource");
const { confirm } = require("../prompts");

const VALID_TYPES = new Set(["dev", "prod", "preview", "custom"]);

module.exports = {
  name: "deployment create",
  summary: "Create a new Convex deployment under the linked project.",
  usage:
    "synapse deployment create [--type=dev|prod|preview|custom] [--ha] [--default] [--host=<host-uuid>] [--project=<id>] [--yes] [--json]",
  description: `Provisions a real Convex backend container. The backend generates the deployment name (animal-adjective-NNNN); you receive it in the response.

Flags:
  --type=<dev|prod|preview|custom>  Deployment type. Default: dev.
  --ha                              Provision HA (2 replicas + Postgres + S3).
                                    Requires SYNAPSE_HA_ENABLED on the host.
  --default                         Mark as the project's default deployment.
  --host=<host-uuid>                Place this deployment on a specific host
                                    (v1.18+, Remote Hosts). Default: the
                                    self-host. Pass a host UUID — find one
                                    via "synapse hosts list".
  --project=<id>                    Operate on a non-linked project.
  --yes                             Skip the prod-confirmation prompt.
  --json                            Machine-readable output.


Examples:
  synapse deployment create
  synapse deployment create --type=prod --yes
  synapse deployment create --type=dev --ha --default --project=<uuid>`,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: ["type", "project", "host"],
      boolean: ["ha", "default", "yes"],
    });
    if (rest.length > 0) {
      throw new Error(
        `Unexpected positional: ${rest[0]}. The backend generates the deployment name; flags only.`,
      );
    }
    // resolveProject reads from --project= via extractProjectFlag. We
    // already consumed --project above; thread it back through args so
    // resolveProject can see it.
    const resolveArgs = flags.project ? [`--project=${flags.project}`] : [];
    const { projectId, source } = resolveProject(ctx, resolveArgs);

    const type = (flags.type || "dev").toLowerCase();
    if (!VALID_TYPES.has(type)) {
      throw new Error(
        `Invalid --type: ${type}. Must be one of: ${[...VALID_TYPES].join(", ")}.`,
      );
    }
    const ha = flags.ha === true || flags.ha === "true";
    const isDefault = flags.default === true || flags.default === "true";
    const yes = flags.yes === true || flags.yes === "true";

    // Prod confirmation. Mirrors `synapse deploy`'s prompt — operator
    // muscle-memory expects the same friction. Skipped in --json mode
    // (CI scripts must pass --yes explicitly anyway).
    if (type === "prod" && !yes && !ctx.out.json) {
      const confirmed = await confirm(
        `Create a NEW PROD deployment under ${source === "linked" ? "this directory's linked project" : projectId}? [y/N] `,
        { defaultAnswer: false },
      );
      if (!confirmed) {
        ctx.out.info("Aborted.");
        process.exitCode = 1;
        return;
      }
    }
    if (type === "prod" && !yes && ctx.out.json) {
      // Fail closed in JSON mode so a script can't accidentally
      // provision prod without an explicit --yes.
      throw new Error(
        "Refusing to create a prod deployment in --json mode without --yes.",
      );
    }

    if (!ctx.out.json) {
      ctx.out.info(
        `Creating ${type}${ha ? " (HA)" : ""}${isDefault ? " [default]" : ""} deployment in project ${projectId}…`,
      );
    }
    const body = { type };
    if (ha) body.ha = true;
    if (isDefault) body.isDefault = true;
    if (flags.host) body.hostId = String(flags.host).trim();
    const created = await ctx.api.createDeployment(projectId, body);

    ctx.out.result(
      {
        projectId,
        projectSource: source,
        deployment: created,
      },
      (_d, { stdout }) => {
        stdout.write(
          `${colors.green("Created")} ${colors.bold(created.name)} ${colors.dim(`(${created.deploymentType || type})`)}\n`,
        );
        if (created.deploymentUrl || created.url) {
          stdout.write(colors.dim(`URL: ${created.deploymentUrl || created.url}\n`));
        }
        if (created.status) {
          stdout.write(colors.dim(`Status: ${created.status}\n`));
        }
        stdout.write(
          colors.dim(
            `Tip: run \`synapse deployment status ${created.name} --watch\` to track readiness, or \`synapse select\` to link this directory to it.\n`,
          ),
        );
      },
    );
  },
};
