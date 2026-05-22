// `synapse https remove <domain> [--keep-certs] [--keep-script]
//   [--keep-hosts] [--yes] [--json]`
//
// Symmetric undo to `https setup`. Removes:
//   - The cert pair at ~/.config/dev-certs/<domain>/
//   - The hosts file entry inside the managed block
//   - The dev:https script from package.json (if it matches the
//     canonical form — never deletes operator-customised scripts)

const colors = require("../colors");
const { extractFlags } = require("./_resource");
const { confirm } = require("../prompts");
const detectMod = require("../https/detect");
const plannerMod = require("../https/planner");
const executorMod = require("../https/executor");

module.exports = {
  name: "https remove",
  summary: "Undo `synapse https setup` for a domain (cert + hosts + script).",
  usage:
    "synapse https remove <domain> [--keep-certs] [--keep-script] [--keep-hosts] [--yes] [--json]",
  description: `Reverses what \`synapse https setup\` did. Idempotent — running on a domain that was never set up is a no-op.

Flags:
  --keep-certs    don't delete the cert pair from ~/.config/dev-certs/
  --keep-script   don't touch package.json
  --keep-hosts    don't touch the hosts file
  --yes           skip the y/N confirmation
  --json          machine-readable output

Examples:
  synapse https remove dev.oldproject.com
  synapse https remove dev.test.com --keep-certs   # keep the cert, just untangle hosts + script`,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: [],
      boolean: ["keep-certs", "keep-script", "keep-hosts", "yes", "json"],
    });
    const domain = rest[0];
    if (!domain) {
      throw new Error("Usage: synapse https remove <domain>");
    }
    if (rest.length > 1) {
      throw new Error(`Unexpected positional: ${rest[1]}.`);
    }
    const yes = flags.yes === true;
    const detection = await detectMod.scan({ domain, cwd: ctx.cwd });
    const steps = plannerMod.planRemove(detection, {
      keepCerts: flags["keep-certs"] === true,
      keepScript: flags["keep-script"] === true,
      keepHosts: flags["keep-hosts"] === true,
    });
    if (!plannerMod.planIsExecutable(steps)) {
      const blocker = steps.find((s) => s.kind === "blocker");
      throw new Error(blocker?.blocker || "Plan is blocked.");
    }
    const willChange = steps.some((s) => s.kind === "exec");
    if (!willChange) {
      ctx.out.result(
        { domain, executedAny: false, results: [] },
        () => ctx.out.stdout.write(colors.dim("Nothing to remove.\n")),
      );
      return;
    }

    if (!ctx.out.json) {
      ctx.out.stdout.write(`${colors.bold("Will remove:")}\n`);
      for (const s of steps) {
        if (s.kind === "exec") {
          ctx.out.stdout.write(`  ${colors.red("✗")} ${s.title}\n`);
        }
      }
      ctx.out.stdout.write("\n");
    }
    if (!yes && !ctx.out.json) {
      const ok = await confirm(
        `Remove HTTPS setup for ${colors.bold(domain)}? [y/N] `,
        { defaultAnswer: false },
      );
      if (!ok) {
        ctx.out.info("Aborted.");
        process.exitCode = 1;
        return;
      }
    }
    if (!yes && ctx.out.json) {
      throw new Error("Refusing to remove in --json mode without --yes.");
    }
    const { results, failedAny } = await executorMod.execute(steps, { out: ctx.out });
    ctx.out.result(
      { domain, results, failedAny },
      (_d, { stdout }) => {
        for (const r of results) {
          if (r.kind === "ok") {
            stdout.write(`${colors.green("✓")} ${r.title}\n`);
          }
        }
      },
    );
    if (failedAny) process.exitCode = 1;
  },
};
