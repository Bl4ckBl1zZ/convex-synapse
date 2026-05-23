// `synapse skills link [--force] [--all-harnesses]`
//
// Re-create missing harness symlinks without touching the SKILL.md
// files. The common case: an operator just cloned a repo where
// .synapse/skills/ is checked in but their local .claude/skills/
// dir is empty (it's gitignored).

const { linkOnly } = require("../skills/installer");
const { renderLink } = require("./_skills-render");

module.exports = {
  name: "skills link",
  summary:
    "(Re)create harness symlinks pointing at .synapse/skills/ (no SKILL.md writes).",
  usage: "synapse skills link [--force] [--all-harnesses] [--json]",
  description: `For when .synapse/skills/ is intact (e.g. checked in via git) but
.claude/skills/ symlinks are missing or broken — typical after a
fresh clone, a manual cleanup, or a machine reinstall. Doesn't
write any SKILL.md content.

Flags:
  --force          replace existing symlinks that point elsewhere
  --all-harnesses  link every known harness, not just detected ones`,

  async run(args, ctx) {
    const force = args.includes("--force");
    const targetAll = args.includes("--all-harnesses");
    const result = linkOnly(ctx.cwd, { force, targetAll });
    ctx.out.result(result, (r, { stdout }) => renderLink(r, stdout));
  },
};
