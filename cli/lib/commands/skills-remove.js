// `synapse skills remove [--purge]`
//
// Undo the install — drop harness symlinks. By default the source
// of truth in .synapse/skills/ stays untouched (so re-installing
// later is one command). Pass --purge to wipe it too.

const { removeInstall } = require("../skills/installer");
const { renderRemove } = require("./_skills-render");

module.exports = {
  name: "skills remove",
  summary:
    "Undo install — remove harness symlinks (source dir kept unless --purge).",
  usage: "synapse skills remove [--purge] [--json]",
  description: `Removes the symlinks created by \`skills install\` under each
harness's skill dir. Symlinks pointing elsewhere are skipped (not
clobbered); rerun with --force to remove them anyway.

Flags:
  --purge   also delete .synapse/skills/ (the source of truth)`,

  async run(args, ctx) {
    const purge = args.includes("--purge");
    const result = removeInstall(ctx.cwd, { purge });
    ctx.out.result(result, (r, { stdout }) => renderRemove(r, stdout));
  },
};
