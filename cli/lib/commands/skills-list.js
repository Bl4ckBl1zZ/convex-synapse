// `synapse skills list [--json]`
//
// Inventory of bundled skills + their local status (missing /
// pristine / customised / ok) + per-harness symlink health.

const { listInstallation } = require("../skills/installer");
const { renderList } = require("./_skills-render");

module.exports = {
  name: "skills list",
  summary: "Show installed skills + symlink health.",
  usage: "synapse skills list [--json]",
  description: `Prints every bundled skill, its local status (missing / ok /
customised / pristine), and the per-harness symlink state.

Status legend:
  ok          local file matches bundled — nothing to do
  pristine    local file matches the version we last wrote (safe to
              auto-update); newer bundled version available
  customised  local file diverges from both — \`skills update\` will
              preserve it; pass --force to overwrite
  missing     skill folder doesn't exist locally yet`,

  async run(_args, ctx) {
    const report = listInstallation(ctx.cwd);
    ctx.out.result(report, (r, { stdout }) => renderList(r, stdout));
  },
};
