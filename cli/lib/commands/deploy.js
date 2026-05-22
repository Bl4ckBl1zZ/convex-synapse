// `synapse deploy [--yes] [args]` — alias for `synapse convex --target
// prod deploy` with a confirmation gate. Refuses to run in non-TTY
// contexts unless --yes is passed so a CI script doesn't deadlock on a
// readline prompt.

const { confirm } = require("../prompts");
const { deploymentNameForTarget, readProjectConfig } = require("../project");
const convexCmd = require("./convex");

function extractYesFlag(args) {
  let yes = false;
  const rest = [];
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else {
      rest.push(arg);
    }
  }
  return { yes, rest };
}

// Signature kept at (args, opts) — not (args, ctx, opts) — so the
// existing test/bin.test.js callers that pass `{ convexImpl, ... }`
// as the second positional arg keep working. The dispatcher's `run()`
// below adapts ctx → opts.
async function deploy(
  args,
  {
    input = process.stdin,
    output = process.stderr,
    confirmImpl = confirm,
    convexImpl,
    cwd = process.cwd(),
    ctx,
  } = {},
) {
  const impl = convexImpl ?? ((a) => convexCmd.runConvexCommand(a, ctx));
  const { yes, rest } = extractYesFlag(args);
  const projectConfig = readProjectConfig(cwd);
  const deploymentName = deploymentNameForTarget(projectConfig, "prod");
  if (deploymentName && !yes) {
    if (!input.isTTY) {
      throw new Error(
        "synapse deploy needs confirmation. Pass --yes to skip in non-interactive contexts (CI, scripts), or run `synapse deploy` again inside a regular terminal.",
      );
    }
    const ok = await confirmImpl(
      `About to run \`convex deploy\` against PROD deployment ${deploymentName}. Continue? [y/N] `,
      { input, output, defaultAnswer: false },
    );
    if (!ok) {
      output.write("Deploy cancelled.\n");
      return;
    }
  }
  return await impl(["--target", "prod", "deploy", ...rest]);
}

module.exports = {
  name: "deploy",
  summary: "Confirm + run `convex deploy` against the linked prod deployment.",
  usage: "synapse deploy [--yes] [...args]",
  description: `Sugar for \`synapse convex --target prod deploy [...args]\` with a confirmation prompt. The first deploy of the session asks \`Continue? [y/N]\` — pass \`--yes\` (or \`-y\`) to skip in CI. Refuses in non-TTY contexts without --yes so a hung readline doesn't deadlock pipelines.`,

  deploy,
  extractYesFlag,

  async run(args, ctx) {
    return await deploy(args, { cwd: ctx.cwd, ctx });
  },
};
