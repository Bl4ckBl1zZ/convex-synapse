// Harness detection + symlink targets.
//
// A "harness" is an AI agent tool that reads project-level skills —
// Claude Code reads `.claude/skills/<name>/SKILL.md`, the Agent SDK
// reads `.agents/skills/<name>/SKILL.md`. Synapse's bundled skills
// live ONCE in `.synapse/skills/<name>/` and we symlink each
// detected harness's skill directory to it. Same content, multiple
// harnesses see it.
//
// v1.9.0 supports `claude` and `agents`. Cursor / Continue / Aider
// use different formats (Cursor's .mdc has YAML-ish frontmatter
// patterns, Continue uses .continue/ tree) and would need format
// conversion, not symlinks — out of scope for now.

const fs = require("node:fs");
const path = require("node:path");

// HARNESSES lists every harness we know about. `marker` is a path
// that, when present in the project, hints the operator uses that
// harness. `targetDir` is where the symlinks land. New harnesses
// can be added by appending to this list — install / update /
// remove / list iterate uniformly over it.
const HARNESSES = [
  {
    id: "claude",
    name: "Claude Code",
    // Claude Code projects either have a `.claude/` dir already
    // (created by `claude` running in this dir) or a CLAUDE.md
    // at the project root. Either is a strong signal.
    marker: (cwd) =>
      fs.existsSync(path.join(cwd, ".claude")) ||
      fs.existsSync(path.join(cwd, "CLAUDE.md")),
    targetDir: (cwd) => path.join(cwd, ".claude", "skills"),
  },
  {
    id: "agents",
    name: "Agents (Agent SDK convention)",
    // The `.agents/` convention is emerging across multiple agent
    // SDKs (Anthropic's, others). An `AGENTS.md` at root is a
    // related signal.
    marker: (cwd) =>
      fs.existsSync(path.join(cwd, ".agents")) ||
      fs.existsSync(path.join(cwd, "AGENTS.md")),
    targetDir: (cwd) => path.join(cwd, ".agents", "skills"),
  },
];

// detectHarnesses returns the subset of HARNESSES whose marker hits
// in `cwd`. If nothing is detected, install still works against ALL
// harnesses — operators who haven't initialised `.claude/` yet
// still get the symlink tree pre-created.
function detectHarnesses(cwd) {
  return HARNESSES.filter((h) => h.marker(cwd));
}

// allHarnesses returns the full catalogue regardless of detection —
// used when --all is passed or when nothing was detected (we still
// want to create the symlink dirs so they're ready).
function allHarnesses() {
  return HARNESSES.slice();
}

// createSymlink creates a symlink from `link` → `target`. Returns
// { kind: "created" | "already-correct" | "replaced" | "failed", ... }.
//
// Cross-platform notes:
//   - Linux/macOS: `fs.symlinkSync(target, link)` works directly.
//   - Windows: needs Developer Mode OR admin OR junction (`mklink /J`).
//     fs.symlinkSync with type "junction" is the most portable option
//     for directories; we use that on Windows.
//
// If a NON-symlink path exists at `link`, we don't clobber — return
// `failed` with a hint and let the caller decide (rename, prompt, …).
function createSymlink(target, link, { force = false } = {}) {
  const linkDir = path.dirname(link);
  try {
    fs.mkdirSync(linkDir, { recursive: true });
  } catch (err) {
    return { kind: "failed", reason: `mkdir ${linkDir}: ${err.message}` };
  }

  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch {
    stat = null;
  }

  if (stat) {
    if (stat.isSymbolicLink()) {
      let current;
      try {
        current = fs.readlinkSync(link);
      } catch {
        current = null;
      }
      // Resolve relative-vs-absolute by comparing absolute paths.
      const currentAbs = current
        ? path.resolve(linkDir, current)
        : null;
      if (currentAbs === path.resolve(target)) {
        return { kind: "already-correct", path: link };
      }
      // Existing symlink points elsewhere. Replace IF force, else fail.
      if (!force) {
        return {
          kind: "failed",
          reason: `symlink at ${link} points to ${current ?? "?"} (expected ${target}). Re-run with --force to replace.`,
        };
      }
      try {
        fs.unlinkSync(link);
      } catch (err) {
        return { kind: "failed", reason: `unlink ${link}: ${err.message}` };
      }
    } else {
      // Existing real file/dir — refuse to clobber even with --force,
      // because there's no way to be sure it was synapse-managed.
      return {
        kind: "failed",
        reason: `${link} exists as a regular ${stat.isDirectory() ? "directory" : "file"} (not a symlink). Move/delete it manually.`,
      };
    }
  }

  // Use relative target if both paths share a common ancestor — keeps
  // the symlink portable across machines where the project might be
  // checked out at different absolute paths.
  const relTarget = path.relative(linkDir, target);

  try {
    if (process.platform === "win32") {
      // "junction" only works on directories but skill dirs ARE
      // directories. Falls back gracefully — Windows operators in
      // Developer Mode get "dir" type which works for files too.
      fs.symlinkSync(target, link, "junction");
    } else {
      fs.symlinkSync(relTarget, link);
    }
    return { kind: stat ? "replaced" : "created", path: link, target };
  } catch (err) {
    return { kind: "failed", reason: `symlink: ${err.message}` };
  }
}

// readSymlinkStatus reports the current state of a single symlink
// without modifying anything. Used by `synapse skills list`.
function readSymlinkStatus(link, expectedTarget) {
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch {
    return { state: "missing" };
  }
  if (!stat.isSymbolicLink()) {
    return { state: "not-a-symlink" };
  }
  let current;
  try {
    current = fs.readlinkSync(link);
  } catch {
    return { state: "broken" };
  }
  const currentAbs = path.resolve(path.dirname(link), current);
  if (currentAbs === path.resolve(expectedTarget)) {
    return { state: "ok", points_to: current };
  }
  return { state: "wrong-target", points_to: current };
}

// removeSymlink deletes a symlink if it points where we expect (or
// unconditionally with force). Refuses to touch non-symlinks.
function removeSymlink(link, expectedTarget, { force = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch {
    return { kind: "missing", path: link };
  }
  if (!stat.isSymbolicLink()) {
    return { kind: "skipped", reason: "not a symlink", path: link };
  }
  if (!force) {
    let current;
    try {
      current = fs.readlinkSync(link);
    } catch {
      return { kind: "skipped", reason: "could not read symlink", path: link };
    }
    const currentAbs = path.resolve(path.dirname(link), current);
    if (currentAbs !== path.resolve(expectedTarget)) {
      return {
        kind: "skipped",
        reason: `points to ${current} (not ${expectedTarget}); use --force`,
        path: link,
      };
    }
  }
  try {
    fs.unlinkSync(link);
  } catch (err) {
    return { kind: "failed", reason: err.message, path: link };
  }
  return { kind: "removed", path: link };
}

module.exports = {
  HARNESSES,
  detectHarnesses,
  allHarnesses,
  createSymlink,
  readSymlinkStatus,
  removeSymlink,
};
