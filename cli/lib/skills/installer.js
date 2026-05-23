// Skill installer — copies bundled SKILL.md files from the npm
// package's `cli/skills/` into the operator's project's
// `.synapse/skills/`, plus the symlink dance into each detected
// harness's skill directory.
//
// Update semantics (industry-standard 3-state):
//   - "pristine": the local file matches the version we last
//     installed → safe to overwrite with new bundled content.
//   - "customised": the local file diverges from what we wrote → we
//     preserve it and report the divergence to the operator.
//   - "missing": local skill folder doesn't exist → fresh install.
//
// The bundled-version stamp lives at `.synapse/skills/.bundled` (JSON)
// — { "version": "1.9.0", "skills": ["synapse-overview", …] }. It
// tells us WHICH version of the skill contents we last wrote, so a
// future `synapse skills update` can do the right 3-way comparison.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  HARNESSES,
  detectHarnesses,
  createSymlink,
  readSymlinkStatus,
  removeSymlink,
} = require("./harnesses");

const STAMP_FILE = ".bundled";

// bundledRoot returns the absolute path to the directory inside this
// npm package that holds the SKILL.md sources. Bundled at publish time
// via the `files` whitelist in package.json.
function bundledRoot() {
  return path.resolve(__dirname, "..", "..", "skills");
}

// projectSkillRoot returns `.synapse/skills/` under cwd. We don't
// create it here — that's the install step's responsibility.
function projectSkillRoot(cwd) {
  return path.join(cwd, ".synapse", "skills");
}

// listBundledSkills returns the names of every shipped skill (each
// is a subdirectory of bundledRoot containing a SKILL.md). The
// directory layout doubles as the contract — adding a new skill is
// just adding a new dir + SKILL.md, no code changes.
function listBundledSkills() {
  const root = bundledRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => fs.existsSync(path.join(root, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

// readBundledSkill returns the SKILL.md content for one bundled skill.
function readBundledSkill(name) {
  return fs.readFileSync(path.join(bundledRoot(), name, "SKILL.md"), "utf8");
}

// hashContent — sha256 of normalised content. Used to detect drift
// vs the bundled version. Normalisation strips trailing whitespace on
// each line so editors that auto-strip don't show as "customised".
function hashContent(s) {
  const normalised = String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n");
  return crypto.createHash("sha256").update(normalised).digest("hex");
}

// readStamp reads `.synapse/skills/.bundled` and returns { version,
// hashes: { [skill]: sha256 } }. Returns null when stamp doesn't
// exist (fresh install case).
function readStamp(cwd) {
  const p = path.join(projectSkillRoot(cwd), STAMP_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeStamp(cwd, stamp) {
  const dir = projectSkillRoot(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, STAMP_FILE),
    JSON.stringify(stamp, null, 2) + "\n",
  );
}

// cliVersion reads package.json's version. Lives in the bundled
// installation, so the version returned is the one shipped with the
// CLI binary the operator ran.
function cliVersion() {
  try {
    return require("../../package.json").version;
  } catch {
    return "unknown";
  }
}

// classifySkill compares a local skill file vs the bundled version
// and the stamp:
//   - "missing"     → no local file at all
//   - "pristine"    → local matches bundled OR matches stamp-recorded hash
//   - "customised"  → local diverges from both
//   - "ok"          → local matches bundled (current install is up-to-date)
function classifySkill(cwd, name, stamp) {
  const localPath = path.join(projectSkillRoot(cwd), name, "SKILL.md");
  if (!fs.existsSync(localPath)) return { status: "missing" };
  const local = fs.readFileSync(localPath, "utf8");
  const bundled = readBundledSkill(name);
  const localHash = hashContent(local);
  const bundledHash = hashContent(bundled);
  if (localHash === bundledHash) return { status: "ok", local, bundled };
  const stampedHash = stamp && stamp.hashes ? stamp.hashes[name] : null;
  if (stampedHash && localHash === stampedHash) {
    // Local matches what we last wrote → safe to overwrite (operator
    // didn't touch it, bundled just changed).
    return { status: "pristine", local, bundled };
  }
  // Diverged from BOTH bundled-now and stamp-snapshot → operator edited.
  return { status: "customised", local, bundled };
}

// installSkills — the install / update path. Writes each bundled
// skill to `.synapse/skills/<name>/SKILL.md`, creates symlinks under
// each detected harness's skill dir, writes the stamp.
//
// Options:
//   force        — overwrite even customised files
//   skip         — array of skill names to skip
//   targetAll    — symlink into all harnesses (not only detected ones)
//   forceLinks   — overwrite existing symlinks that point elsewhere
function installSkills(cwd, opts = {}) {
  const force = !!opts.force;
  const skip = new Set(opts.skip || []);
  const targetAll = !!opts.targetAll;
  const forceLinks = !!opts.forceLinks;

  const bundled = listBundledSkills();
  if (bundled.length === 0) {
    return { ok: false, error: "no bundled skills found in CLI package" };
  }

  const stamp = readStamp(cwd) || {};
  const previousHashes = (stamp && stamp.hashes) || {};

  const root = projectSkillRoot(cwd);
  fs.mkdirSync(root, { recursive: true });

  const written = [];
  const preserved = [];
  const errors = [];

  for (const name of bundled) {
    if (skip.has(name)) continue;
    const skillDir = path.join(root, name);
    fs.mkdirSync(skillDir, { recursive: true });

    const cls = classifySkill(cwd, name, { hashes: previousHashes });

    if (cls.status === "customised" && !force) {
      preserved.push({ name, reason: "customised" });
      continue;
    }

    if (cls.status === "ok") {
      // No-op — content already matches.
      written.push({ name, action: "unchanged" });
      continue;
    }

    try {
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), readBundledSkill(name));
      written.push({
        name,
        action: cls.status === "missing" ? "created" : "updated",
      });
    } catch (err) {
      errors.push({ name, error: err.message });
    }
  }

  // Symlink fan-out. Pick harnesses based on detection unless --all.
  const harnessTargets = targetAll
    ? HARNESSES.slice()
    : detectHarnesses(cwd);

  // If NO harness detected, still default to claude — operators using
  // `claude` from a fresh dir without ever having ran it before should
  // get the link pre-created.
  const effectiveHarnesses =
    harnessTargets.length > 0
      ? harnessTargets
      : HARNESSES.filter((h) => h.id === "claude");

  const symlinks = [];
  for (const h of effectiveHarnesses) {
    const targetDir = h.targetDir(cwd);
    for (const name of bundled) {
      if (skip.has(name)) continue;
      const link = path.join(targetDir, name);
      const target = path.join(root, name);
      const result = createSymlink(target, link, { force: forceLinks });
      symlinks.push({ harness: h.id, name, ...result });
    }
  }

  // Build the new stamp — hashes reflect what we just wrote.
  const newHashes = {};
  for (const name of bundled) {
    if (skip.has(name)) continue;
    const localPath = path.join(root, name, "SKILL.md");
    if (fs.existsSync(localPath)) {
      newHashes[name] = hashContent(fs.readFileSync(localPath, "utf8"));
    }
  }
  writeStamp(cwd, {
    version: cliVersion(),
    written_at: new Date().toISOString(),
    skills: Object.keys(newHashes).sort(),
    hashes: newHashes,
  });

  return {
    ok: errors.length === 0,
    written,
    preserved,
    symlinks,
    errors,
    harnesses: effectiveHarnesses.map((h) => h.id),
  };
}

// listInstallation produces a report of every bundled skill + its
// local status + symlink status per harness. Drives `synapse skills
// list`.
function listInstallation(cwd) {
  const stamp = readStamp(cwd);
  const bundled = listBundledSkills();
  const root = projectSkillRoot(cwd);
  const harnesses = HARNESSES.slice();

  const skills = bundled.map((name) => {
    const cls = classifySkill(cwd, name, stamp || { hashes: {} });
    const localPath = path.join(root, name, "SKILL.md");
    const links = harnesses.map((h) => ({
      harness: h.id,
      link_path: path.join(h.targetDir(cwd), name),
      ...readSymlinkStatus(path.join(h.targetDir(cwd), name), path.join(root, name)),
    }));
    return {
      name,
      status: cls.status, // missing / pristine / ok / customised
      local_path: localPath,
      links,
    };
  });

  return {
    cwd,
    cli_version: cliVersion(),
    stamp_version: stamp ? stamp.version : null,
    stamp_written_at: stamp ? stamp.written_at : null,
    skills_root: root,
    skills,
  };
}

// removeInstall — undo: removes all symlinks pointing at our skill
// dirs. Optionally purges `.synapse/skills/` itself.
function removeInstall(cwd, { purge = false } = {}) {
  const bundled = listBundledSkills();
  const root = projectSkillRoot(cwd);
  const results = [];

  for (const h of HARNESSES) {
    for (const name of bundled) {
      const link = path.join(h.targetDir(cwd), name);
      const expected = path.join(root, name);
      results.push({
        harness: h.id,
        name,
        ...removeSymlink(link, expected),
      });
    }
  }

  if (purge && fs.existsSync(root)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      results.push({ kind: "purged-skills-root", path: root });
    } catch (err) {
      results.push({ kind: "failed", reason: err.message, path: root });
    }
  }
  return { ok: true, results };
}

// linkOnly — re-create symlinks without touching the SKILL.md files.
// For the operator who already has `.synapse/skills/` checked in from
// git and just needs the local `.claude/skills/` and `.agents/skills/`
// trees recreated.
function linkOnly(cwd, { targetAll = false, force = false } = {}) {
  const bundled = listBundledSkills();
  const root = projectSkillRoot(cwd);
  const harnesses = targetAll ? HARNESSES.slice() : detectHarnesses(cwd);
  const effective =
    harnesses.length > 0 ? harnesses : HARNESSES.filter((h) => h.id === "claude");

  const symlinks = [];
  for (const h of effective) {
    for (const name of bundled) {
      const link = path.join(h.targetDir(cwd), name);
      const target = path.join(root, name);
      symlinks.push({
        harness: h.id,
        name,
        ...createSymlink(target, link, { force }),
      });
    }
  }
  return { ok: true, symlinks, harnesses: effective.map((h) => h.id) };
}

module.exports = {
  bundledRoot,
  projectSkillRoot,
  listBundledSkills,
  readBundledSkill,
  classifySkill,
  installSkills,
  listInstallation,
  removeInstall,
  linkOnly,
  readStamp,
  // Exposed for tests.
  __testing__: { hashContent, writeStamp, cliVersion, STAMP_FILE },
};
