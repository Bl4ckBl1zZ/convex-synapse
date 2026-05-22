// `synapse deployment delete <name> [--yes] [--confirm=<name>] [--json]`
//
// Destroys the container + storage volume. Irreversible.
//
// Safety levels:
//   - dev: single `--yes` confirms (or interactive y/N prompt)
//   - prod: typed-confirmation REQUIRED — operator must re-type the
//     deployment name. `--yes` is NOT enough for prod (mirrors the
//     dashboard's v1.7.2 typed-confirm flow). Non-interactive callers
//     pass `--confirm=<exact-name>` instead.
//
// The deployment type is fetched from the backend before the delete
// fires so we know whether to ask for typed-confirm. One extra GET is
// cheap and prevents the "I thought this was dev" footgun.

const colors = require("../colors");
const { extractFlags } = require("./_resource");
const { confirm, typedConfirm } = require("../prompts");
const { SynapseAPIError } = require("../api");

module.exports = {
  name: "deployment delete",
  summary: "Delete a deployment (container + volume — irreversible).",
  usage:
    "synapse deployment delete <name> [--yes] [--confirm=<name>] [--json]",
  description: `Calls POST /v1/deployments/{name}/delete. The container is destroyed and the storage volume is wiped. Production deployments require typed confirmation — re-type the deployment name.

Flags:
  --yes                Skip the y/N prompt for dev deployments.
  --confirm=<name>     Pre-supply the typed confirmation (CI usage). For
                       prod deployments this is mandatory in --json mode.
  --json               Machine-readable output.

Examples:
  synapse deployment delete brave-dolphin-1060
  synapse deployment delete brave-dolphin-1060 --yes              # dev only
  synapse deployment delete wise-otter-2200 --confirm=wise-otter-2200`,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: ["confirm"],
      boolean: ["yes", "json"],
    });
    const name = rest[0];
    if (!name) {
      throw new Error(
        "Usage: synapse deployment delete <name> [--yes|--confirm=<name>]",
      );
    }
    if (rest.length > 1) {
      throw new Error(`Unexpected positional: ${rest[1]}.`);
    }
    const yes = flags.yes === true || flags.yes === "true";
    const typed = typeof flags.confirm === "string" ? flags.confirm : null;

    // Look up the deployment to learn its type. 404 here is the most
    // common operator typo case — surface a clear error before any
    // destructive call.
    let dep;
    try {
      dep = await ctx.api.getDeployment(name);
    } catch (err) {
      if (err instanceof SynapseAPIError && err.status === 404) {
        throw new Error(
          `Deployment "${name}" not found. Run \`synapse list deployments\` to see your deployments.`,
        );
      }
      throw err;
    }
    const type = dep.deploymentType || dep.type || "unknown";

    if (type === "prod") {
      // Typed-confirmation MANDATORY. --yes alone does not bypass it.
      if (!typed && ctx.out.json) {
        throw new Error(
          `Refusing to delete prod deployment "${name}" in --json mode without --confirm=${name}.`,
        );
      }
      const ok = await typedConfirm("delete", name, { typed });
      if (!ok) {
        ctx.out.info(`Aborted (confirmation didn't match "${name}").`);
        process.exitCode = 1;
        return;
      }
    } else {
      // Dev / preview / custom — y/N prompt unless --yes was passed.
      if (!yes && !typed && !ctx.out.json) {
        const confirmed = await confirm(
          `Delete ${type} deployment ${colors.bold(name)}? [y/N] `,
          { defaultAnswer: false },
        );
        if (!confirmed) {
          ctx.out.info("Aborted.");
          process.exitCode = 1;
          return;
        }
      }
      if (!yes && !typed && ctx.out.json) {
        throw new Error(
          `Refusing to delete "${name}" in --json mode without --yes.`,
        );
      }
    }

    if (!ctx.out.json) {
      ctx.out.info(`Deleting ${type} deployment ${name}…`);
    }
    await ctx.api.deleteDeployment(name);

    ctx.out.result(
      { deleted: true, name, type },
      (_d, { stdout }) => {
        stdout.write(`${colors.red("Deleted")} ${colors.bold(name)} ${colors.dim(`(${type})`)}\n`);
      },
    );
  },
};
