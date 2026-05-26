// Shared helpers for the Cell Control Plane commands (Bloco 5).
//
// Renderers + redaction + scope parsing live here so the command files
// (cellplane-*.js) stay slim. Nothing here applies changes — these are
// pure formatting + safe-output helpers over read/plan API responses.
//
// Underscore prefix → the dispatcher skips this file when building the
// command registry (it's a helper, not a command).

const colors = require("../colors");

// ---- redaction --------------------------------------------------------
// Defense-in-depth: the API already keeps secrets out of diff/plan/result
// JSON, but the CLI scrubs again before printing so a token/secret that ever
// slipped through never lands on a terminal or in a piped --json stream.
const SENSITIVE = [
  "token",
  "secret",
  "password",
  "key",
  "env",
  "admin",
  "instance",
  "database",
];

function isSensitiveKey(k) {
  const lk = String(k).toLowerCase();
  return SENSITIVE.some((bad) => lk.includes(bad));
}

function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? "[redacted]" : redactJson(v);
    }
    return out;
  }
  return value;
}

// Returns a shallow copy of an OperationRun with the free-form input/plan/
// result blobs redacted. Leaves structured fields (type/status/scope) intact.
function redactOperationRun(run) {
  if (!run || typeof run !== "object") return run;
  const out = { ...run };
  if (out.input !== undefined) out.input = redactJson(out.input);
  if (out.plan !== undefined) out.plan = redactJson(out.plan);
  if (out.result !== undefined) out.result = redactJson(out.result);
  return out;
}

function redactDriftItems(items) {
  return (items || []).map((it) =>
    it && it.diff !== undefined ? { ...it, diff: redactJson(it.diff) } : it,
  );
}

// ---- flag / scope parsing --------------------------------------------

// Extracts `--name=value` / `--name value` (any position). Mirrors
// _resource.extractProjectFlag but for an arbitrary flag name.
function extractValueFlag(args, name) {
  const rest = [];
  let value = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === `--${name}`) {
      value = args[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith(`--${name}=`)) {
      value = a.slice(name.length + 3);
      continue;
    }
    rest.push(a);
  }
  return { value, rest };
}

// Collects every occurrence of a repeatable `--name=value` / `--name value`
// flag into an array (used by --allow-command / --allow-event / --label).
function collectValueFlag(args, name) {
  const rest = [];
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === `--${name}`) {
      if (args[i + 1] !== undefined) {
        values.push(args[i + 1]);
        i += 1;
      }
      continue;
    }
    if (a.startsWith(`--${name}=`)) {
      values.push(a.slice(name.length + 3));
      continue;
    }
    rest.push(a);
  }
  return { values, rest };
}

// Resolve a host/cell/project scope for drift / reconcile / desired-list.
// Exactly one of --host / --cell / --project; falls back to the linked
// project when none is given. Returns { scope, id, source, rest } where
// scope is the path segment "hosts" | "cells" | "projects".
function resolveScope(ctx, args) {
  let rest = args;
  const host = extractValueFlag(rest, "host");
  rest = host.rest;
  const cell = extractValueFlag(rest, "cell");
  rest = cell.rest;
  const project = extractValueFlag(rest, "project");
  rest = project.rest;

  const provided = [
    ["hosts", host.value],
    ["cells", cell.value],
    ["projects", project.value],
  ].filter(([, v]) => v);

  if (provided.length > 1) {
    throw new Error("Pass only one of --host=<id>, --cell=<id>, or --project=<id>.");
  }
  if (provided.length === 1) {
    return { scope: provided[0][0], id: provided[0][1], source: "flag", rest };
  }
  const linked = ctx.projectConfig;
  if (linked && linked.project && linked.project.id) {
    return { scope: "projects", id: linked.project.id, source: "linked", rest };
  }
  throw new Error(
    "Specify a scope: --host=<id>, --cell=<id>, or --project=<id> (or run `synapse select` to link a project).",
  );
}

// ---- phrasing ---------------------------------------------------------
// Drift recommended actions + dry-run step actions are rendered as
// recommendations/intent — never imperatives. "create" → "would create".
function actionPhrase(action) {
  switch (action) {
    case "create":
      return "would create";
    case "restart":
      return "would restart";
    case "stop":
      return "would stop";
    case "remove":
      return "would remove";
    case "update":
      return "would update";
    case "investigate":
      return "investigate";
    case "no_op":
    case "none":
      return "no-op";
    default:
      return String(action || "");
  }
}

function severityColor(sev) {
  if (sev === "critical") return colors.red;
  if (sev === "warning") return colors.yellow;
  return colors.dim;
}

function statusColor(status) {
  switch (status) {
    case "clean":
    case "succeeded":
    case "online":
    case "active":
    case "running":
      return colors.green;
    case "warning":
    case "stale":
    case "draining":
    case "running ":
    case "queued":
      return colors.yellow;
    case "drifted":
    case "failed":
    case "offline":
      return colors.red;
    default:
      return colors.dim;
  }
}

// ---- renderers (human mode) ------------------------------------------
// Each takes the shared `out` (for .stdout / .table) + the already-redacted
// data the command also emits as JSON.

const DRY_RUN_FOOTER = [
  "",
  "DRY-RUN ONLY",
  "No changes were applied.",
  "Agent remains observe-only.",
  "applyAllowed=false",
];

function summarizeLine(summary) {
  const s = summary || {};
  const n = (k) => s[k] ?? 0;
  return (
    `in_sync ${n("inSync")} · missing ${n("missing")} · drifted ${n("drifted")} · ` +
    `unmanaged ${n("unmanaged")} · orphaned ${n("orphaned")} · host_unreachable ${n("hostUnreachable")} · ignored ${n("ignored")}`
  );
}

function severityLine(summary) {
  const s = summary || {};
  const n = (k) => s[k] ?? 0;
  return `critical ${n("critical")} · warning ${n("warning")} · info ${n("info")}`;
}

function renderDrift(out, data) {
  const w = out.stdout;
  const { scope, id, report, items } = data;
  if (!report) {
    w.write(
      colors.dim(`No drift report yet for ${scope} ${id}. Run \`synapse drift recompute\`.\n`),
    );
    return;
  }
  w.write(
    `Drift ${colors.dim(scope + " " + id)}  ${statusColor(report.status)(report.status)}\n`,
  );
  if (report.summary) {
    w.write(colors.dim("  " + summarizeLine(report.summary) + "\n"));
    w.write(colors.dim("  " + severityLine(report.summary) + "\n"));
  }
  if (!items || items.length === 0) {
    w.write(colors.dim("  (no drift items)\n"));
    return;
  }
  w.write("\n");
  for (const it of items) {
    const sev = severityColor(it.severity);
    const dangerous = it.recommendedAction === "remove" ? colors.red("  [dangerous]") : "";
    w.write(
      `  ${sev("[" + it.severity + "]")} ${colors.bold(it.driftStatus.padEnd(16))} ` +
        `${it.resourceKey}  ${colors.dim("→ " + actionPhrase(it.recommendedAction))}${dangerous}\n`,
    );
    const note = driftNote(it);
    if (note) w.write(colors.dim("      " + note + "\n"));
  }
}

function driftNote(it) {
  const diff = it.diff || {};
  if (it.driftStatus === "host_unreachable") {
    return "Observation cannot be trusted. Investigate host / agent / docker scan.";
  }
  if (it.recommendedAction === "remove") {
    return "Dry-run only. Removal is not implemented.";
  }
  if (typeof diff.reason === "string") return diff.reason;
  return null;
}

function renderDryRun(out, data) {
  const w = out.stdout;
  const { scope, id, operationRun, steps } = data;
  const plan = (operationRun && operationRun.plan) || {};
  const sum = plan.summary || {};
  w.write(
    `Reconcile plan ${colors.dim(scope + " " + id)}  ${statusColor(operationRun.status)(operationRun.status)}\n`,
  );
  w.write(
    colors.dim(
      `  planned ${sum.planned ?? 0} · no-op ${sum.noOp ?? 0} · skipped ${sum.skipped ?? 0} · ` +
        `investigate ${sum.investigate ?? 0} · dangerous ${sum.dangerous ?? 0}\n`,
    ),
  );
  if (!steps || steps.length === 0) {
    w.write(colors.dim("  (no steps — nothing to reconcile)\n"));
  } else {
    w.write("\n");
    steps.forEach((st, i) => {
      const dangerous = st.action === "remove" ? colors.red("  [dangerous]") : "";
      w.write(
        `  ${colors.dim("#" + i)} ${colors.bold(actionPhrase(st.action).padEnd(14))} ` +
          `${colors.dim(st.status.padEnd(8))} ${st.resourceKey}${dangerous}\n`,
      );
      if (st.reason) w.write(colors.dim("      " + st.reason + "\n"));
    });
  }
  for (const line of DRY_RUN_FOOTER) {
    w.write((line ? colors.dim(line) : "") + "\n");
  }
}

function renderOperationRun(out, data) {
  const w = out.stdout;
  const run = data.operationRun;
  const steps = data.steps || [];
  w.write(`Operation ${colors.bold(run.type)}  ${statusColor(run.status)(run.status)}\n`);
  w.write(colors.dim(`  scope: ${scopeLabel(run)}\n`));
  if (run.startedAt) w.write(colors.dim(`  started: ${run.startedAt}\n`));
  if (run.finishedAt) w.write(colors.dim(`  finished: ${run.finishedAt}\n`));
  if (run.error) w.write(colors.red(`  error: ${run.error}\n`));
  if (steps.length > 0) {
    w.write(colors.dim(`  steps (${steps.length}):\n`));
    for (const st of steps) {
      w.write(
        colors.dim(
          `    #${st.stepIndex} ${actionPhrase(st.action)} ${st.status} ${st.resourceKey}` +
            (st.reason ? ` — ${st.reason}` : "") +
            "\n",
        ),
      );
    }
  }
  // Redacted blobs, compact, only when present.
  for (const key of ["plan", "result"]) {
    if (run[key] && Object.keys(run[key]).length > 0) {
      w.write(colors.dim(`  ${key}: ${JSON.stringify(run[key])}\n`));
    }
  }
}

function scopeLabel(run) {
  if (run.hostId) return `host ${String(run.hostId).slice(0, 8)}`;
  if (run.cellId) return `cell ${String(run.cellId).slice(0, 8)}`;
  if (run.deploymentId) return `deployment ${String(run.deploymentId).slice(0, 8)}`;
  if (run.projectId) return "project";
  return "—";
}

function renderTopology(out, topo) {
  const w = out.stdout;
  const cellName = new Map((topo.cells || []).map((c) => [c.id, c.name]));
  const nameOf = (cid) => cellName.get(cid) || String(cid).slice(0, 8);
  w.write(`Project ${colors.bold(topo.project ? topo.project.name : "—")}`);
  w.write(colors.dim(`  [${topo.mode}]\n`));

  if (topo.warnings && topo.warnings.length > 0) {
    w.write(colors.yellow(`Warnings (${topo.warnings.length}):\n`));
    for (const warn of topo.warnings) w.write(colors.yellow(`  • ${warn}\n`));
  }

  const placedHostIds = new Set((topo.hosts || []).map((h) => h.id));
  const cellsByHost = new Map();
  const unplaced = [];
  for (const c of topo.cells || []) {
    if (c.primaryHostId && placedHostIds.has(c.primaryHostId)) {
      const arr = cellsByHost.get(c.primaryHostId) || [];
      arr.push(c);
      cellsByHost.set(c.primaryHostId, arr);
    } else {
      unplaced.push(c);
    }
  }

  for (const host of topo.hosts || []) {
    w.write(
      `Host ${colors.bold(host.name)} ${statusColor(host.effectiveStatus)("[" + host.effectiveStatus + "]")}\n`,
    );
    const cells = cellsByHost.get(host.id) || [];
    if (cells.length === 0) w.write(colors.dim("  (no cells on this host)\n"));
    for (const c of cells) renderTopoCell(w, c, nameOf);
  }
  if (unplaced.length > 0) {
    w.write(colors.dim("Unplaced cells (no host):\n"));
    for (const c of unplaced) renderTopoCell(w, c, nameOf);
  }
  if (topo.unassignedDeployments && topo.unassignedDeployments.length > 0) {
    w.write(colors.dim("Unassigned deployments (no cell):\n"));
    for (const d of topo.unassignedDeployments) {
      w.write(`  ${d.name} ${statusColor(d.status)("[" + d.status + "]")}\n`);
    }
  }
}

function renderTopoCell(w, c, nameOf) {
  w.write(`  Cell ${colors.bold(c.name)} ${colors.dim(`[${c.kind}/${c.environment}]`)} ${statusColor(c.status)("[" + c.status + "]")}\n`);
  for (const d of c.deployments || []) {
    w.write(`    Deployment ${d.name} ${statusColor(d.status)("[" + d.status + "]")}\n`);
  }
  if (c.deployments && c.deployments.length === 0) {
    w.write(colors.dim("    (no deployment attached)\n"));
  }
  const links = c.outgoingLinks || [];
  if (links.length > 0) {
    w.write(colors.dim("    Links:\n"));
    for (const l of links) {
      w.write(colors.dim(`      -> ${nameOf(l.targetCellId)} [${l.protocol}]\n`));
    }
  }
}

module.exports = {
  isSensitiveKey,
  redactJson,
  redactOperationRun,
  redactDriftItems,
  extractValueFlag,
  collectValueFlag,
  resolveScope,
  actionPhrase,
  renderDrift,
  renderDryRun,
  renderOperationRun,
  renderTopology,
};
