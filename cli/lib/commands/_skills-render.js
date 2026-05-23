// Shared human-mode renderers for the `synapse skills` verbs. Kept
// in `_`-prefixed file so the dispatcher's command auto-loader
// ignores it (the prefix is the dispatcher's "internal module"
// convention; see _dispatcher.js).

const path = require("node:path");
const os = require("node:os");
const colors = require("../colors");

function exitCodeFor(result) {
  if (result.ok === false) return 1;
  if (result.errors && result.errors.length > 0) return 1;
  return 0;
}

function renderInstall(r, cwd, stdout, { verb = "Install" } = {}) {
  stdout.write(`${colors.bold(verb)} — .synapse/skills/ in ${shortPath(cwd)}\n\n`);

  if (r.written && r.written.length > 0) {
    stdout.write(`  ${colors.green("✓")} Skills written:\n`);
    for (const w of r.written) {
      const label =
        w.action === "created"
          ? colors.green("created")
          : w.action === "updated"
          ? colorise("updated", colors.cyan)
          : colors.dim("unchanged");
      stdout.write(`    ${label}  ${w.name}\n`);
    }
    stdout.write("\n");
  }

  if (r.preserved && r.preserved.length > 0) {
    stdout.write(
      `  ${colors.yellow("!")} Preserved (you customised these — re-run with --force to overwrite):\n`,
    );
    for (const p of r.preserved) {
      stdout.write(`    ${colors.yellow("kept")}  ${p.name}\n`);
    }
    stdout.write("\n");
  }

  if (r.symlinks && r.symlinks.length > 0) {
    const detected = (r.harnesses || []).join(", ") || "none detected";
    stdout.write(`  ${colors.green("✓")} Symlinks (harnesses: ${detected}):\n`);
    for (const s of r.symlinks) {
      const label = symLabel(s);
      const relPath = s.path
        ? `.${path.sep}${path.relative(cwd, s.path)}`
        : `(${s.harness}/${s.name})`;
      stdout.write(`    ${label}  ${relPath}`);
      if (s.kind === "failed" && s.reason) stdout.write(`  ${colors.dim("— " + s.reason)}`);
      stdout.write("\n");
    }
    stdout.write("\n");
  }

  if (r.errors && r.errors.length > 0) {
    stdout.write(`  ${colors.red("✗")} Errors:\n`);
    for (const e of r.errors) {
      stdout.write(`    ${colors.red("fail")}  ${e.name}: ${e.error}\n`);
    }
    stdout.write("\n");
  }

  // Footer tips
  const anyLinkFailure =
    r.symlinks && r.symlinks.some((s) => s.kind === "failed");
  if (anyLinkFailure) {
    stdout.write(
      `  ${colors.dim("Tip: retry with --force-links to replace symlinks that point elsewhere.")}\n`,
    );
  }
  if (r.preserved && r.preserved.length > 0 && verb !== "Update") {
    stdout.write(
      `  ${colors.dim("Tip: after a CLI version bump, prefer `synapse skills update` (clearer intent).")}\n`,
    );
  }
}

function renderList(report, stdout) {
  stdout.write(`${colors.bold("Synapse skills")} — ${shortPath(report.cwd)}\n`);
  const stampLine = report.stamp_version
    ? `CLI ${report.cli_version} · last written by ${report.stamp_version} at ${report.stamp_written_at}`
    : `CLI ${report.cli_version} · never installed`;
  stdout.write(`  ${colors.dim(stampLine)}\n\n`);

  for (const s of report.skills) {
    const statusBadge = statusToBadge(s.status);
    stdout.write(`  ${s.name}  ${statusBadge}\n`);
    for (const lnk of s.links) {
      const sym = linkStateSymbol(lnk.state);
      stdout.write(
        `    ${sym} ${lnk.harness.padEnd(8)} ${colors.dim(lnk.state.padEnd(14))} ${colors.dim(shortPath(lnk.link_path))}\n`,
      );
    }
    stdout.write("\n");
  }

  const anyMissing = report.skills.some((s) =>
    s.links.some((l) => l.state === "missing"),
  );
  if (anyMissing) {
    stdout.write(
      `  ${colors.dim("Tip: run `synapse skills link` to (re)create missing symlinks.")}\n`,
    );
  }
  const anyCustom = report.skills.some((s) => s.status === "customised");
  if (anyCustom) {
    stdout.write(
      `  ${colors.dim("Tip: customised skills are preserved on `synapse skills update` — pass --force to overwrite.")}\n`,
    );
  }
}

function renderRemove(r, stdout) {
  stdout.write(`${colors.bold("Remove")} — skill symlinks\n\n`);
  for (const x of r.results) {
    const sym = removeStateSymbol(x);
    const where = x.harness ? `[${x.harness}] ` : "";
    stdout.write(`  ${sym}  ${where}${shortPath(x.path)}\n`);
  }
}

function renderLink(r, stdout) {
  const detected = (r.harnesses || []).join(", ") || "(none detected)";
  stdout.write(`${colors.bold("Link")} — symlinks to .synapse/skills/  ${colors.dim(`harnesses: ${detected}`)}\n\n`);
  for (const s of r.symlinks) {
    const sym = symLabel(s);
    stdout.write(`  ${sym}  [${s.harness}] ${s.name}`);
    if (s.kind === "failed" && s.reason) stdout.write(`  ${colors.dim("— " + s.reason)}`);
    stdout.write("\n");
  }
}

// --- helpers ------------------------------------------------------

function colorise(text, fn) {
  return typeof fn === "function" ? fn(text) : text;
}

function symLabel(s) {
  switch (s.kind) {
    case "created":
      return colors.green("linked");
    case "replaced":
      return colorise("replaced", colors.cyan);
    case "already-correct":
      return colors.dim("ok");
    case "failed":
      return colors.red("fail");
    default:
      return colors.dim(s.kind || "?");
  }
}

function statusToBadge(status) {
  switch (status) {
    case "ok":
      return colors.green("✓ ok");
    case "pristine":
      return colors.dim("· pristine (update available)");
    case "customised":
      return colors.yellow("! customised");
    case "missing":
      return colors.red("✗ missing");
    default:
      return colors.dim(status);
  }
}

function linkStateSymbol(state) {
  switch (state) {
    case "ok":
      return colors.green("↪");
    case "missing":
      return colors.dim("·");
    default:
      return colors.yellow("⚠");
  }
}

function removeStateSymbol(x) {
  switch (x.kind) {
    case "removed":
      return colors.green("✓ removed");
    case "missing":
      return colors.dim("· missing (already gone)");
    case "skipped":
      return colors.yellow(`! skipped (${x.reason})`);
    case "purged-skills-root":
      return colors.green("✓ purged source dir");
    case "failed":
      return colors.red(`✗ failed${x.reason ? " — " + x.reason : ""}`);
    default:
      return colors.dim(x.kind);
  }
}

function shortPath(p) {
  if (!p) return "(none)";
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

module.exports = {
  exitCodeFor,
  renderInstall,
  renderList,
  renderRemove,
  renderLink,
  // exposed for tests
  __testing__: { symLabel, statusToBadge, linkStateSymbol, removeStateSymbol, shortPath },
};
