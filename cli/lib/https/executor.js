// Step executor. Runs the steps returned by planner.plan() in
// order, capturing per-step status + duration. Refuses to run if
// any step has `kind: blocker`.
//
// We INTENTIONALLY don't try to be transactional across steps —
// each step is independently idempotent, so re-running the wizard
// after a partial failure converges. The "transactional" guarantees
// live inside individual writers (hosts.js writes via tmp+rename,
// nextjs.js writes the full file atomically, mkcert.generateCert
// only chmods on success).

const colors = require("../colors");

async function execute(steps, { out, verbose = false } = {}) {
  const results = [];
  let executedAny = false;
  let failedAny = false;

  for (const step of steps) {
    if (step.kind === "blocker") {
      results.push({
        id: step.id,
        kind: "blocker",
        title: step.title,
        durationMs: 0,
        outcome: { blocker: step.blocker || step.reason },
      });
      continue;
    }
    if (step.kind === "skip" || step.kind === "warn") {
      results.push({
        id: step.id,
        kind: step.kind,
        title: step.title,
        durationMs: 0,
        outcome: { reason: step.reason, skipReason: step.skipReason },
      });
      continue;
    }
    // kind === "exec"
    if (!step.run || typeof step.run !== "function") {
      results.push({
        id: step.id,
        kind: "failed",
        title: step.title,
        durationMs: 0,
        outcome: { error: "step has no run() function (planner bug)" },
      });
      failedAny = true;
      continue;
    }
    if (out && !out.json) {
      out.info(`→ ${step.title}`);
    }
    const t0 = Date.now();
    try {
      const outcome = await step.run();
      const durationMs = Date.now() - t0;
      results.push({
        id: step.id,
        kind: "ok",
        title: step.title,
        durationMs,
        outcome: outcome || {},
      });
      executedAny = true;
      if (verbose && out && !out.json) {
        out.info(
          `  ${colors.dim(`done in ${durationMs}ms${outcome && outcome.reason ? ` · ${outcome.reason}` : ""}`)}`,
        );
      }
    } catch (err) {
      const durationMs = Date.now() - t0;
      results.push({
        id: step.id,
        kind: "failed",
        title: step.title,
        durationMs,
        outcome: {
          error: err && err.message ? err.message : String(err),
          kind: err && err.kind ? err.kind : undefined,
        },
      });
      failedAny = true;
      if (out && !out.json) {
        out.error(`step "${step.id}" failed: ${err.message}`);
      }
      // Stop on first failure — subsequent steps may depend on this
      // one (e.g. dev:https script needs the cert to exist). The
      // operator re-runs after fixing the cause.
      break;
    }
  }
  return { results, executedAny, failedAny };
}

// Returns true iff the plan contains at least one blocker.
function hasBlocker(steps) {
  return steps.some((s) => s.kind === "blocker");
}

module.exports = { execute, hasBlocker };
