// `synapse skills update [--force] [--force-links]`
//
// Refresh bundled skills after a CLI version bump. Same code path
// as `skills install` — exists as a distinct verb so the operator's
// intent is explicit ("I want to pull in upstream changes") and the
// output header reads "Update" instead of "Install".

const { installSkills } = require("../skills/installer");
const { renderInstall, exitCodeFor } = require("./_skills-render");

module.exports = {
  name: "skills update",
  summary: "Refresh bundled skills, preserving customisations (3-way diff).",
  usage: "synapse skills update [--force] [--force-links] [--json]",
  description: `Like \`skills install\` but tailored for a re-run after a CLI version
bump. Skill files matching the LAST install we wrote are overwritten
silently; files you've edited locally are preserved and surfaced in
the output.

Re-run with --force to overwrite even customised files.`,

  async run(args, ctx) {
    const force = args.includes("--force");
    const forceLinks = args.includes("--force-links") || force;
    const result = installSkills(ctx.cwd, { force, forceLinks });
    ctx.out.result(result, (r, { stdout }) =>
      renderInstall(r, ctx.cwd, stdout, { verb: "Update" }),
    );
    process.exitCode = exitCodeFor(result);
  },
};
