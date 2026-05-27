// Root and per-command help rendering.
//
// `synapse help` and `synapse <cmd> --help` are routed here from the
// dispatcher; no parser library, no template engine. We group commands
// by their first space-delimited word so the root listing reads as
// "top-level shortcuts" + "deployment.*", "project.*", "team.*", etc.

const colors = require("../colors");

function renderRootHelp(registry, { stdout = process.stdout } = {}) {
  // Stable section order so the help page stays predictable across
  // releases. Groups not listed here fall to the bottom alphabetically.
  const SECTION_ORDER = [
    ["Session", ["login", "logout", "whoami"]],
    ["Project linking", ["select", "credentials"]],
    ["Day-to-day", ["dev", "deploy"]],
    ["Visibility", ["version", "status", "doctor", "open", "list", "logs"]],
    ["Deployments", "deployment"],
    ["Projects", "project"],
    ["Teams", "team"],
    ["Env vars", "env"],
    ["Custom domains", "domains"],
    ["Project members", "members"],
    ["Auto-update", "upgrade"],
    // Cell Control Plane (Bloco 5). Diagnose + plan only — no apply.
    ["Hosts", "hosts"],
    ["Agents", "agents"],
    ["Cells", "cells"],
    ["Cell links", "cell-links"],
    ["Service tokens", "service-tokens"],
    ["Topology", "topology"],
    ["Desired state", "desired"],
    ["Observed state", "observed"],
    ["Drift", "drift"],
    ["Reconcile (dry-run)", "reconcile"],
    ["Operations", "operations"],
    ["Local HTTPS dev", "https"],
    ["AI agent skills", "skills"],
    ["Escape hatch", ["convex"]],
  ];

  const used = new Set();
  const lines = [
    colors.bold("Synapse CLI") + colors.dim(" — manage Synapse-self-hosted Convex deployments"),
    "",
    "Usage:",
    "  " + colors.bold("synapse") + " <command> [...args] [--json] [--help]",
    "",
  ];

  for (const [title, spec] of SECTION_ORDER) {
    const cmds = [];
    if (Array.isArray(spec)) {
      // Explicit command names.
      for (const name of spec) {
        if (registry.has(name)) {
          cmds.push(registry.get(name));
          used.add(name);
        }
      }
    } else {
      // Prefix-match (every command whose name starts with `<spec> `).
      const prefix = spec + " ";
      for (const [name, cmd] of registry) {
        if (name.startsWith(prefix) && !used.has(name)) {
          cmds.push(cmd);
          used.add(name);
        }
      }
      cmds.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (cmds.length === 0) continue;
    lines.push(colors.dim(title));
    const widest = Math.max(...cmds.map((c) => c.name.length));
    for (const c of cmds) {
      lines.push("  " + colors.bold(c.name.padEnd(widest)) + "  " + (c.summary || ""));
    }
    lines.push("");
  }

  // Any leftover registered commands fall here — keeps the help honest
  // when someone adds a command without updating SECTION_ORDER.
  const leftover = [];
  for (const [name, cmd] of registry) {
    if (!used.has(name)) leftover.push(cmd);
  }
  if (leftover.length > 0) {
    lines.push(colors.dim("Other"));
    leftover.sort((a, b) => a.name.localeCompare(b.name));
    const widest = Math.max(...leftover.map((c) => c.name.length));
    for (const c of leftover) {
      lines.push("  " + colors.bold(c.name.padEnd(widest)) + "  " + (c.summary || ""));
    }
    lines.push("");
  }

  lines.push(
    "Run " + colors.bold("synapse <command> --help") + " for command-specific help.",
  );
  lines.push("");
  stdout.write(lines.join("\n"));
}

function renderCommandHelp(cmd, { stdout = process.stdout } = {}) {
  const lines = [];
  lines.push(colors.bold("synapse " + cmd.name));
  if (cmd.summary) {
    lines.push(colors.dim(cmd.summary));
  }
  lines.push("");
  lines.push("Usage:");
  lines.push("  " + (cmd.usage || `synapse ${cmd.name}`));
  if (cmd.description) {
    lines.push("");
    lines.push(cmd.description.trimEnd());
  }
  lines.push("");
  stdout.write(lines.join("\n"));
}

module.exports = { renderRootHelp, renderCommandHelp };
