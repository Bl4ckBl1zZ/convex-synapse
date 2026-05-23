// `synapse skills install [--force] [--force-links] [--all-harnesses]`
//
// First-time + idempotent install of bundled Synapse AI agent skills.
// Writes each shipped SKILL.md into the operator's
// `.synapse/skills/<name>/SKILL.md` and creates symlinks under each
// detected harness's skill directory (.claude/skills/, .agents/skills/).
//
// Customised skills are PRESERVED by default; re-run with --force to
// overwrite. Re-running with no flags after an `update` is a no-op.

const { installSkills } = require("../skills/installer");
const { renderInstall, exitCodeFor } = require("./_skills-render");

module.exports = {
  name: "skills install",
  summary:
    "Install bundled Synapse AI skills into .synapse/skills/ and symlink to detected harnesses.",
  usage:
    "synapse skills install [--force] [--force-links] [--all-harnesses] [--json]",
  description: `Writes each bundled SKILL.md into .synapse/skills/<name>/SKILL.md and
creates symlinks under each detected harness (.claude/skills/, .agents/skills/).
Idempotent — running twice is safe.

Flags:
  --force          overwrite even customised SKILL.md files
  --force-links    replace existing symlinks pointing elsewhere
  --all-harnesses  create symlinks for every known harness, not just
                   the ones detected in the cwd
  --json           machine-readable output`,

  async run(args, ctx) {
    const force = args.includes("--force");
    const forceLinks = args.includes("--force-links") || force;
    const targetAll = args.includes("--all-harnesses");
    const result = installSkills(ctx.cwd, { force, forceLinks, targetAll });
    ctx.out.result(result, (r, { stdout }) =>
      renderInstall(r, ctx.cwd, stdout, { verb: "Install" }),
    );
    process.exitCode = exitCodeFor(result);
  },
};
