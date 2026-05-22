// `synapse deployment rotate-key <name> [--yes] [--confirm=<name>] [--write] [--json]`
//
// Calls POST /v1/deployments/{name}/reissue_admin_key. Re-mints the
// admin_key from the current INSTANCE_SECRET (no container restart).
//
// What this does NOT do:
//   - It does NOT rotate INSTANCE_SECRET (so existing deploy keys keep
//     working). To actually invalidate a leaked credential you'd need
//     to recreate the deployment.
//   - It does NOT auto-update the operator's .env.local. We surface a
//     --write flag that opt-in does it (using the same writer as
//     `synapse select`), but the default is "show the key and let the
//     operator paste it".
//
// Safety:
//   - prod deployments REQUIRE typed-confirm (--confirm=<name>) since
//     rotating mid-flight breaks the iframed Convex Dashboard until the
//     operator hits "Refresh credentials".
//   - dev: `--yes` suffices.

const colors = require("../colors");
const { extractFlags } = require("./_resource");
const { confirm, typedConfirm } = require("../prompts");
const { SynapseAPIError } = require("../api");
const { writeProjectEnv } = require("../env-file");

module.exports = {
  name: "deployment rotate-key",
  summary: "Re-mint a deployment's admin key (cures stale credentials).",
  usage:
    "synapse deployment rotate-key <name> [--yes] [--confirm=<name>] [--write] [--json]",
  description: `Calls POST /v1/deployments/{name}/reissue_admin_key. Used when the stored admin_key drifts out of sync with the running container (symptom: "deployment URL or admin key is invalid" inside the Convex Dashboard iframe).

The deployment's INSTANCE_SECRET is NOT rotated — existing deploy keys keep working. If you need to invalidate a leaked credential, delete + recreate the deployment.

Flags:
  --yes               Skip the y/N prompt (dev only).
  --confirm=<name>    Pre-supply the typed confirmation for prod.
  --write             Also rewrite .env.local in the current directory
                      IF this is the linked dev deployment.
  --json              Machine-readable output.

Examples:
  synapse deployment rotate-key brave-dolphin-1060 --yes
  synapse deployment rotate-key wise-otter-2200 --confirm=wise-otter-2200 --write`,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: ["confirm"],
      boolean: ["yes", "write", "json"],
    });
    const name = rest[0];
    if (!name) {
      throw new Error(
        "Usage: synapse deployment rotate-key <name> [--yes|--confirm=<name>]",
      );
    }
    if (rest.length > 1) {
      throw new Error(`Unexpected positional: ${rest[1]}.`);
    }
    const yes = flags.yes === true || flags.yes === "true";
    const write = flags.write === true || flags.write === "true";
    const typed = typeof flags.confirm === "string" ? flags.confirm : null;

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

    // Adopted deployments can't be rotated — backend will 400, but we
    // catch it earlier with a clearer message.
    if (dep.adopted) {
      throw new Error(
        `Cannot rotate key for "${name}" — it's an adopted (external) deployment. Rotate the admin key on the source side and re-adopt.`,
      );
    }

    if (type === "prod") {
      if (!typed && ctx.out.json) {
        throw new Error(
          `Refusing to rotate prod key for "${name}" in --json mode without --confirm=${name}.`,
        );
      }
      const ok = await typedConfirm("rotate-key", name, { typed });
      if (!ok) {
        ctx.out.info(`Aborted (confirmation didn't match "${name}").`);
        process.exitCode = 1;
        return;
      }
    } else {
      if (!yes && !typed && !ctx.out.json) {
        const confirmed = await confirm(
          `Rotate admin key for ${type} deployment ${colors.bold(name)}? [y/N] `,
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
          `Refusing to rotate "${name}" in --json mode without --yes.`,
        );
      }
    }

    if (!ctx.out.json) {
      ctx.out.info(`Rotating admin key for ${name}…`);
    }
    const res = await ctx.api.reissueAdminKey(name);

    // Optional .env.local rewrite. Only fires when:
    //   - --write was passed
    //   - the rotated deployment is the linked dev deployment in CWD
    //   - we can fetch fresh credentials to wire in the new url+key
    let envWritten = null;
    if (write) {
      const linked = ctx.projectConfig;
      const matchedDev = linked?.deployments?.dev?.name === name;
      if (!matchedDev) {
        if (!ctx.out.json) {
          ctx.out.warn(
            "--write skipped: this is not the linked dev deployment in the current directory.",
          );
        }
      } else {
        const creds = await ctx.api.cliCredentials(name);
        envWritten = writeProjectEnv(ctx.cwd, creds, {
          team: { slug: linked.team?.slug, name: linked.team?.name },
          project: { slug: linked.project?.slug, name: linked.project?.name },
          target: "dev",
        });
      }
    }

    ctx.out.result(
      {
        rotated: true,
        deploymentName: res.deploymentName || name,
        prefix: res.prefix,
        // Full new key. Same exposure profile as `synapse credentials`
        // — operator already had this on disk before rotation; the
        // surface is unchanged.
        adminKey: res.adminKey,
        envWritten,
      },
      (_d, { stdout }) => {
        stdout.write(
          `${colors.green("Rotated")} ${colors.bold(name)} ${colors.dim(`(prefix ${res.prefix})`)}\n`,
        );
        stdout.write(colors.dim("New admin key (paste into .env.local or pass --write):\n"));
        stdout.write(res.adminKey + "\n");
        if (envWritten) {
          stdout.write(colors.green(`Updated ${envWritten}\n`));
        } else if (write) {
          stdout.write(
            colors.dim("Hint: pass --write only when rotating the linked dev deployment.\n"),
          );
        }
      },
    );
  },
};
