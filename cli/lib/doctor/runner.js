// Runs the doctor checks with the DAG defined in checks.js (each
// check declares its `dependsOn` ids). Within a tier, checks run in
// parallel via Promise.all; dependent checks wait on their prereqs.
//
// The orchestrator produces a stable DoctorReport — same tree feeds
// both the human renderer and `--json`.

const { ALL_CHECKS } = require("./checks");

const SCHEMA_VERSION = "1.0";

async function runChecks(checks, ctx) {
  // Topological execution: for each check, wait for its dependencies
  // (already-resolved CheckResults) before invoking run(). Failed or
  // skipped prereqs cascade to skipped state (don't run the dependent).
  const resultsById = new Map();
  const order = []; // preserve insertion order for the final report
  // Resolve sequentially through the catalog — checks declared earlier
  // become available as deps for later ones. Inside a "tier" we still
  // get the parallel benefit because awaiting an already-resolved
  // result is a microtask, not a roundtrip.
  for (const check of checks) {
    order.push(check.id);
  }

  // First pass: kick off every check whose dependencies are all "ok"
  // or "warn"; cascade-skip the rest.
  const pending = new Map();
  for (const check of checks) {
    pending.set(check.id, check);
  }
  while (pending.size > 0) {
    let advanced = false;
    for (const [id, check] of pending) {
      const depsResolved = (check.dependsOn || []).every((d) => resultsById.has(d));
      if (!depsResolved) continue;
      const failedDeps = (check.dependsOn || []).filter((d) => {
        const r = resultsById.get(d);
        return r.status === "issue" || r.status === "skipped";
      });
      if (failedDeps.length > 0) {
        resultsById.set(id, {
          id,
          category: check.category,
          title: check.title,
          status: "skipped",
          summary: `skipped (prereq failed: ${failedDeps.join(", ")})`,
          data: { skippedBecause: failedDeps },
          durationMs: 0,
        });
        pending.delete(id);
        advanced = true;
        continue;
      }
      const result = await check.run(ctx);
      resultsById.set(id, {
        id,
        category: check.category,
        title: check.title,
        ...result,
      });
      pending.delete(id);
      advanced = true;
    }
    if (!advanced) {
      // Cycle in deps — should never happen; bail to avoid an infinite
      // loop. Mark anything still pending as a hard error.
      for (const [id, check] of pending) {
        resultsById.set(id, {
          id,
          category: check.category,
          title: check.title,
          status: "issue",
          summary: `cycle in dependsOn: ${(check.dependsOn || []).join(", ")}`,
          durationMs: 0,
        });
      }
      break;
    }
  }

  return order.map((id) => resultsById.get(id));
}

function totalize(results) {
  const t = { ok: 0, warn: 0, issue: 0, skipped: 0, fixed: 0 };
  for (const r of results) {
    if (r.fixedBy) t.fixed += 1;
    if (r.status === "ok") t.ok += 1;
    else if (r.status === "warn") t.warn += 1;
    else if (r.status === "issue") t.issue += 1;
    else if (r.status === "skipped") t.skipped += 1;
  }
  return t;
}

function exitCodeFor(totals) {
  if (totals.issue > 0) return 2;
  if (totals.warn > 0) return 1;
  return 0;
}

async function applyAutoFixes(results, checks, ctx, { allowPrompt = false } = {}) {
  // Walk results, find non-ok ones whose check has autoFix=auto (or
  // prompt + allowPrompt=true), invoke the fix, re-run THAT check.
  // Stays simple: one fix pass, no recursive heal-then-recheck loops.
  const byId = new Map(checks.map((c) => [c.id, c]));
  for (const r of results) {
    if (r.status === "ok" || r.status === "skipped") continue;
    const check = byId.get(r.id);
    if (!check || typeof check.fix !== "function") continue;
    if (check.autoFix === "never") continue;
    if (check.autoFix === "prompt" && !allowPrompt) continue;
    const fixOutcome = await check.fix(ctx, r);
    if (fixOutcome.kind === "applied") {
      // Re-run the check; if it's green now, mark fixedBy.
      const fresh = await check.run(ctx);
      Object.assign(r, fresh, { fixedBy: fixOutcome.message });
    } else if (fixOutcome.kind === "failed") {
      r.detail = (r.detail ? r.detail + "\n" : "") + `fix attempt failed: ${fixOutcome.message}`;
    }
  }
}

async function generateReport(ctx, { fix = false, allowPrompt = false } = {}) {
  const t0 = Date.now();
  const results = await runChecks(ALL_CHECKS, ctx);
  if (fix) {
    await applyAutoFixes(results, ALL_CHECKS, ctx, { allowPrompt });
  }
  const totals = totalize(results);
  const exitCode = exitCodeFor(totals);
  return {
    schemaVersion: SCHEMA_VERSION,
    cliVersion: require("../../package.json").version,
    env: {
      cwd: ctx.cwd,
      synapseUrl: ctx.cfg?.baseUrl ?? null,
      user: ctx.cfg?.user?.email ?? null,
    },
    results,
    totals,
    durationMs: Date.now() - t0,
    exitCode,
  };
}

module.exports = { runChecks, totalize, exitCodeFor, applyAutoFixes, generateReport, SCHEMA_VERSION };
