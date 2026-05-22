// `synapse https doctor [domain]` — read-only sanity checks that
// tell the operator WHAT to fix without changing anything. This
// mirrors `synapse doctor` but is scoped to the HTTPS-dev surface.
//
// Useful when an operator runs the wizard and the dev server still
// doesn't work — `doctor` re-scans + flags every drift from the
// expected state.

const colors = require("../colors");
const { extractFlags } = require("./_resource");
const detectMod = require("../https/detect");
const plannerMod = require("../https/planner");

module.exports = {
  name: "https doctor",
  summary: "Diagnose local-HTTPS setup without changing anything.",
  usage: "synapse https doctor [domain] [--json]",
  description: `Runs the same detection as \`https setup\` but in read-only mode. Prints the plan that WOULD run, plus any warnings (legacy certs in cwd, NSS missing, etc).`,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: [],
      boolean: ["json"],
    });
    const domain = rest[0];
    if (rest.length > 1) {
      throw new Error(`Unexpected positional: ${rest[1]}.`);
    }
    if (!domain) {
      throw new Error(
        "Usage: synapse https doctor <domain>\n\nExample: synapse https doctor dev.myproject.com",
      );
    }
    const detection = await detectMod.scan({ domain, cwd: ctx.cwd });
    const steps = plannerMod.plan(detection, {});
    const blocker = steps.find((s) => s.kind === "blocker");
    const warnings = steps.filter((s) => s.kind === "warn");
    const willExec = steps.filter((s) => s.kind === "exec");
    const willSkip = steps.filter((s) => s.kind === "skip");
    const summary = {
      domain,
      platform: detection.platform.id,
      blocker: blocker ? blocker.blocker || blocker.reason : null,
      warnings: warnings.map((w) => ({ id: w.id, reason: w.reason, hint: w.skipReason })),
      wouldExec: willExec.map((s) => ({ id: s.id, title: s.title, reason: s.reason })),
      skipped: willSkip.map((s) => ({ id: s.id, title: s.title, reason: s.reason })),
    };
    ctx.out.result(summary, (s, { stdout }) => {
      stdout.write(`${colors.bold("HTTPS doctor")} ${colors.dim(`· ${s.domain} · ${s.platform}`)}\n\n`);
      if (s.blocker) {
        stdout.write(colors.red(`Blocker: ${s.blocker}\n`));
        return;
      }
      if (s.wouldExec.length === 0) {
        stdout.write(colors.green("Healthy. Nothing to do.\n"));
      } else {
        stdout.write(colors.yellow(`${s.wouldExec.length} step${s.wouldExec.length > 1 ? "s" : ""} would run:\n`));
        for (const x of s.wouldExec) {
          stdout.write(`  ${colors.cyan("●")} ${x.title}\n`);
          if (x.reason) stdout.write(colors.dim(`     ${x.reason}\n`));
        }
        stdout.write(colors.dim("\nRun `synapse https setup <domain>` to apply.\n"));
      }
      if (s.warnings.length > 0) {
        stdout.write(`\n${colors.yellow("Warnings:")}\n`);
        for (const w of s.warnings) {
          stdout.write(`  ${colors.yellow("!")} ${w.reason}\n`);
          if (w.hint) stdout.write(colors.dim(`     ${w.hint}\n`));
        }
      }
    });
  },
};
