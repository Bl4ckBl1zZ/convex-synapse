// Human-mode renderer for the DoctorReport. JSON mode lives in the
// command file; this is purely the terminal pretty-printer.

const colors = require("../colors");

const SYMBOL = {
  ok: "✓",
  warn: "!",
  issue: "✗",
  skipped: "·",
};
const TONE = {
  ok: colors.green,
  warn: colors.yellow,
  issue: colors.red,
  skipped: colors.dim,
};

const CATEGORY_TITLE = {
  "local-env": "Local environment",
  project: "Project",
  backend: "Backend",
  deployments: "Deployments",
  upstream: "Upstream",
  workspace: "Workspace",
};
const CATEGORY_ORDER = ["local-env", "project", "backend", "deployments", "upstream", "workspace"];

function renderHeader(report, write) {
  const parts = ["Synapse doctor"];
  if (report.env.synapseUrl) parts.push(colors.dim(`· ${report.env.synapseUrl}`));
  if (report.env.user) parts.push(colors.dim(`· ${report.env.user}`));
  write(parts.join(" ") + "\n\n");
}

// v1.8.5: inline-tag formatter for the fix hint. Mirrors the cyan-on-dim
// rest of the remediation line; falls back to plain text if colors.cyan
// isn't defined (the `colors` shim is a no-op on non-tty stdouts).
function fixableTag(r) {
  if (!r.fixable) return "";
  if (r.fixedBy) return ""; // already fixed; no nudge needed
  const text = r.fixable === "auto"
    ? " [run `synapse doctor --fix`]"
    : " [run `synapse doctor --fix --yes`]";
  return colors.cyan ? colors.cyan(text) : text;
}

function renderCheck(r, { verbose }, write) {
  const sym = TONE[r.status](SYMBOL[r.status]);
  write(`    ${sym} ${r.title}`);
  if (r.summary) write(colors.dim(` — ${r.summary}`));
  if (r.fixedBy) write(`  ${colors.cyan ? colors.cyan("↻ " + r.fixedBy) : "↻ " + r.fixedBy}`);
  write("\n");
  if (r.remediation && (r.status === "issue" || r.status === "warn")) {
    write(colors.dim(`        → ${r.remediation}`));
    write(fixableTag(r));
    write("\n");
  }
  if (verbose && r.detail) {
    write(colors.dim(`        ${r.detail.replace(/\n/g, "\n        ")}\n`));
  }
}

function renderReport(report, { stdout, verbose = false } = {}) {
  const write = (s) => stdout.write(s);
  renderHeader(report, write);

  const byCategory = new Map();
  for (const r of report.results) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }

  for (const cat of CATEGORY_ORDER) {
    const rows = byCategory.get(cat);
    if (!rows || rows.length === 0) continue;
    write(`  ${colors.bold(CATEGORY_TITLE[cat] ?? cat)}\n`);
    for (const r of rows) renderCheck(r, { verbose }, write);
    write("\n");
  }

  // Categories outside the canonical order (defensive — keeps the
  // report honest if a check is added without updating CATEGORY_ORDER).
  for (const [cat, rows] of byCategory) {
    if (CATEGORY_ORDER.includes(cat)) continue;
    write(`  ${colors.bold(cat)}\n`);
    for (const r of rows) renderCheck(r, { verbose }, write);
    write("\n");
  }

  const t = report.totals;
  const summary = [
    t.ok > 0 ? colors.green(`${t.ok} ok`) : null,
    t.warn > 0 ? colors.yellow(`${t.warn} warn`) : null,
    t.issue > 0 ? colors.red(`${t.issue} issue${t.issue > 1 ? "s" : ""}`) : null,
    t.skipped > 0 ? colors.dim(`${t.skipped} skipped`) : null,
    t.fixed > 0 ? colors.cyan ? colors.cyan(`${t.fixed} fixed`) : `${t.fixed} fixed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  write(`  ${summary} · ${report.durationMs}ms\n`);
  if (report.exitCode !== 0) {
    write(`  ${colors.dim("exit " + report.exitCode)}\n`);
  }

  // v1.8.5: actionable tip footer. Surfaces the right `--fix` invocation
  // for whichever class of fixable issues remains, so an operator who
  // just sees a wall of `! ...` warnings knows exactly which command
  // would clean them up — no need to memorise the auto-vs-prompt split.
  const autoCount = t.fixableAuto || 0;
  const promptCount = t.fixablePrompt || 0;
  const tip = (msg) =>
    `  ${colors.cyan ? colors.cyan("💡 Tip:") : "Tip:"} ${msg}\n`;
  if (autoCount + promptCount > 0) {
    write("\n");
    if (autoCount > 0 && promptCount > 0) {
      write(tip(
        `${autoCount} auto-fixable + ${promptCount} prompt-fixable — run \`synapse doctor --fix --yes\` to apply both.`,
      ));
    } else if (autoCount > 0) {
      write(tip(
        `${autoCount} ${autoCount === 1 ? "issue is" : "issues are"} auto-fixable — run \`synapse doctor --fix\`.`,
      ));
    } else {
      write(tip(
        `${promptCount} ${promptCount === 1 ? "issue needs" : "issues need"} confirmation — run \`synapse doctor --fix --yes\`.`,
      ));
    }
  } else if (t.warn + t.issue === 0 && t.ok > 0) {
    // Clean bill of health → point at the next step. Operators who run
    // doctor first thing after `synapse select` shouldn't have to wonder
    // what's next.
    write("\n");
    write(tip(
      "everything healthy — run `synapse dev` to start working, or `synapse status` to list deployments.",
    ));
  }
}

module.exports = { renderReport };
