// `synapse dev [args]` — thin alias for `synapse convex --target dev dev`.
// We don't replicate the credentials/spawn pipeline here; just call
// the convex command with the target hard-coded.

const convexCmd = require("./convex");

// Same (args, opts) signature as deploy — preserves the test seam.
async function dev(args, { convexImpl, ctx } = {}) {
  const impl = convexImpl ?? ((a) => convexCmd.runConvexCommand(a, ctx));
  return await impl(["--target", "dev", "dev", ...args]);
}

module.exports = {
  name: "dev",
  summary: "Run `convex dev` against the linked dev deployment.",
  usage: "synapse dev [...args]",
  description: `Sugar for \`synapse convex --target dev dev [...args]\`. Watches and pushes schema/functions to the dev deployment selected by \`synapse select\`. Pass \`--once\` (a convex flag) to run a single push and exit.`,

  dev,

  async run(args, ctx) {
    return await dev(args, { ctx });
  },
};
