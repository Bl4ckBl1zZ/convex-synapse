// `synapse deployment status <name> [--watch[=interval]] [--json]`
//
// Single-deployment snapshot. Hits GET /v1/deployments/{name}/ +
// /backend_version (best-effort). `--watch` polls every 2s by default
// (configurable via --watch=<seconds>) until either:
//   - the deployment reaches a terminal state (running / failed / deleted)
//   - the operator hits Ctrl+C
//   - --json mode is enabled (then we emit ONE snapshot, no polling)

const colors = require("../colors");
const { extractFlags } = require("./_resource");
const { SynapseAPIError } = require("../api");

const TERMINAL_STATES = new Set(["running", "failed", "errored", "deleted", "stopped"]);

async function fetchSnapshot(api, name) {
  const dep = await api.getDeployment(name);
  let backendVersion = null;
  // Backend version is only meaningful once the container is running.
  // We don't await this on every poll if we already saw a transient
  // 503 — it's not load-bearing for the status check.
  if (dep.status === "running") {
    try {
      const v = await api.getDeploymentBackendVersion(name);
      backendVersion = v.version || null;
    } catch {
      backendVersion = null;
    }
  }
  return { dep, backendVersion };
}

function renderSnapshot(snap, { stdout }) {
  const { dep, backendVersion } = snap;
  const type = (dep.deploymentType || dep.type || "?").toUpperCase();
  const status = dep.status || "?";
  stdout.write(
    `${colors.bold(dep.name)}  ${colors.dim(type)}  ${colors.statusBadge(status)}\n`,
  );
  if (dep.deploymentUrl || dep.url) {
    stdout.write(`  URL: ${dep.deploymentUrl || dep.url}\n`);
  }
  if (dep.haEnabled) {
    stdout.write(
      `  HA:  enabled${dep.replicaCount ? ` (${dep.replicaCount} replicas)` : ""}\n`,
    );
  }
  if (backendVersion) {
    stdout.write(colors.dim(`  Convex backend: ${backendVersion}\n`));
  }
  if (dep.isDefault) {
    stdout.write(colors.dim(`  Default for the project.\n`));
  }
  if (dep.adopted) {
    stdout.write(colors.dim(`  Adopted (external — Synapse does not manage credentials).\n`));
  }
}

module.exports = {
  name: "deployment status",
  summary: "Show a single deployment's status, URL, and HA shape.",
  usage:
    "synapse deployment status <name> [--watch[=<seconds>]] [--json]",
  description: `Fetches GET /v1/deployments/{name} plus a best-effort backend_version probe. --watch polls until the deployment reaches a terminal state (running/failed/deleted/stopped).

Flags:
  --watch[=<seconds>]  Poll until terminal. Default interval: 2s.
  --json               One-shot snapshot, no polling.

Examples:
  synapse deployment status brave-dolphin-1060
  synapse deployment status fresh-newt-1234 --watch       # tail until ready
  synapse deployment status brave-dolphin-1060 --json | jq .dep.status`,

  // Re-exports for tests.
  fetchSnapshot,
  renderSnapshot,
  TERMINAL_STATES,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      // `--watch` alone → true (default interval); `--watch=5` → "5"
      // (string parsed to number below). Both work because the
      // boolean branch in extractFlags fires only for the no-`=` form.
      boolean: ["watch", "json"],
    });
    const name = rest[0];
    if (!name) {
      throw new Error("Usage: synapse deployment status <name> [--watch]");
    }
    if (rest.length > 1) {
      throw new Error(`Unexpected positional: ${rest[1]}.`);
    }

    const watch = flags.watch === true || flags.watch === "true"
      ? 2
      : typeof flags.watch === "string"
        ? Math.max(1, Number.parseInt(flags.watch, 10) || 2)
        : 0;

    // --json + --watch combination doesn't make sense (we'd emit a
    // never-ending stream of JSON objects). Fail closed.
    if (ctx.out.json && watch > 0) {
      throw new Error("--watch is incompatible with --json (would emit an unbounded stream).");
    }

    let snap;
    try {
      snap = await fetchSnapshot(ctx.api, name);
    } catch (err) {
      if (err instanceof SynapseAPIError && err.status === 404) {
        throw new Error(
          `Deployment "${name}" not found. Run \`synapse list deployments\` to see your deployments.`,
        );
      }
      throw err;
    }

    if (watch === 0) {
      ctx.out.result(snap, renderSnapshot);
      return;
    }

    // Watch mode (human only — we already barred --json above).
    renderSnapshot(snap, { stdout: ctx.out.stdout });
    while (!TERMINAL_STATES.has(snap.dep.status)) {
      await new Promise((resolve) => setTimeout(resolve, watch * 1000));
      try {
        snap = await fetchSnapshot(ctx.api, name);
      } catch (err) {
        if (err instanceof SynapseAPIError && err.status === 404) {
          ctx.out.info(`Deployment "${name}" disappeared mid-watch.`);
          break;
        }
        // Transient errors — log + continue. Operators see one stderr
        // line per blip; persistent failures escalate via process exit.
        ctx.out.warn(`probe failed (${err.message}); retrying`);
        continue;
      }
      renderSnapshot(snap, { stdout: ctx.out.stdout });
    }
  },
};
