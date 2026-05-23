// Skills installer + harness detection coverage. These tests run
// against the BUNDLED skills shipped in cli/skills/ so they exercise
// the real shape, not a mocked one — keeps drift between code and
// content honest.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  listBundledSkills,
  readBundledSkill,
  classifySkill,
  installSkills,
  listInstallation,
  removeInstall,
  linkOnly,
  readStamp,
  __testing__,
} = require("../lib/skills/installer");

const {
  HARNESSES,
  detectHarnesses,
  createSymlink,
  readSymlinkStatus,
  removeSymlink,
} = require("../lib/skills/harnesses");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "synapse-skills-test-"));
}

// ---------- bundled-skill contract -------------------------------

test("bundled skills: at least 6 ship, each with SKILL.md frontmatter", () => {
  const names = listBundledSkills();
  // We ship 6 in v1.9.0. If we add more, this test still passes.
  assert.ok(names.length >= 6, `expected ≥ 6 skills, got ${names.length}`);
  // Every skill name starts with synapse- so symlink dirs are
  // predictably scoped.
  for (const name of names) {
    assert.ok(
      name.startsWith("synapse-"),
      `${name} should start with "synapse-" so harness dirs stay scoped`,
    );
    const content = readBundledSkill(name);
    // Frontmatter contract: starts with ---, has name + description.
    assert.ok(content.startsWith("---\n"), `${name}: missing frontmatter`);
    assert.match(content, /\nname:/, `${name}: missing name in frontmatter`);
    assert.match(content, /\ndescription:/, `${name}: missing description`);
  }
});

test("bundled skills: canonical six names present", () => {
  const names = listBundledSkills();
  const expected = [
    "synapse-cli-reference",
    "synapse-debug",
    "synapse-deploy",
    "synapse-env",
    "synapse-multi-deployment",
    "synapse-overview",
  ];
  for (const e of expected) {
    assert.ok(names.includes(e), `missing skill: ${e}`);
  }
});

// ---------- hashContent normalisation ---------------------------

test("hashContent: ignores trailing whitespace + CRLF vs LF", () => {
  const a = "hello\nworld\n";
  const b = "hello   \nworld  \n";
  const c = "hello\r\nworld\r\n";
  assert.equal(__testing__.hashContent(a), __testing__.hashContent(b));
  assert.equal(__testing__.hashContent(a), __testing__.hashContent(c));
});

test("hashContent: different content → different hash", () => {
  assert.notEqual(
    __testing__.hashContent("alpha"),
    __testing__.hashContent("beta"),
  );
});

// ---------- install (fresh) ------------------------------------

test("installSkills (fresh): writes SKILL.md per skill + stamp + symlinks", () => {
  const tmp = mkTmp();
  // Marker for claude harness so it gets symlinked.
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });

  const result = installSkills(tmp);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.written.length >= 6);
  // Every "fresh" install marks every skill as "created" the first time.
  for (const w of result.written) {
    assert.equal(w.action, "created", `${w.name}: expected created`);
  }
  // .synapse/skills/<name>/SKILL.md present per skill.
  for (const name of listBundledSkills()) {
    const p = path.join(tmp, ".synapse/skills", name, "SKILL.md");
    assert.ok(fs.existsSync(p), `${p} should exist`);
  }
  // Stamp written.
  const stamp = readStamp(tmp);
  assert.ok(stamp);
  assert.ok(stamp.version);
  assert.equal(stamp.skills.length, listBundledSkills().length);
  // Symlinks under .claude/skills/.
  for (const name of listBundledSkills()) {
    const link = path.join(tmp, ".claude/skills", name);
    const stat = fs.lstatSync(link);
    assert.ok(stat.isSymbolicLink(), `${link}: expected symlink`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("installSkills: idempotent on re-run (no spurious updates)", () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  installSkills(tmp);
  const second = installSkills(tmp);
  // Second run: everything either "unchanged" or already-correct symlinks.
  for (const w of second.written) {
    assert.equal(
      w.action,
      "unchanged",
      `${w.name}: expected unchanged on re-run`,
    );
  }
  for (const s of second.symlinks) {
    assert.equal(s.kind, "already-correct");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- 3-state classification ----------------------------

test("classifySkill: detects customised vs pristine vs ok", () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  installSkills(tmp);
  const stamp = readStamp(tmp);
  // ok: untouched after install
  let cls = classifySkill(tmp, "synapse-overview", stamp);
  assert.equal(cls.status, "ok");
  // customised: operator edits
  const p = path.join(tmp, ".synapse/skills/synapse-overview/SKILL.md");
  fs.appendFileSync(p, "\n\nMy custom note.\n");
  cls = classifySkill(tmp, "synapse-overview", stamp);
  assert.equal(cls.status, "customised");
  // missing: skill folder removed entirely
  fs.rmSync(path.dirname(p), { recursive: true });
  cls = classifySkill(tmp, "synapse-overview", stamp);
  assert.equal(cls.status, "missing");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- update path -----------------------------------------

test("installSkills (with force): overwrites customised files", () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  installSkills(tmp);
  const p = path.join(tmp, ".synapse/skills/synapse-deploy/SKILL.md");
  const before = fs.readFileSync(p, "utf8");
  fs.appendFileSync(p, "\n# my edit\n");
  // Default re-install preserves edits.
  let r = installSkills(tmp);
  assert.ok(r.preserved.some((x) => x.name === "synapse-deploy"));
  assert.equal(fs.readFileSync(p, "utf8"), before + "\n# my edit\n");
  // --force overwrites them.
  r = installSkills(tmp, { force: true });
  assert.equal(r.preserved.length, 0);
  assert.equal(fs.readFileSync(p, "utf8"), before);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- listInstallation ------------------------------------

test("listInstallation: reports per-skill status + per-harness symlink state", () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  installSkills(tmp);
  const report = listInstallation(tmp);
  assert.equal(report.cwd, tmp);
  assert.ok(report.skills.length >= 6);
  for (const s of report.skills) {
    assert.equal(s.status, "ok");
    const claudeLink = s.links.find((l) => l.harness === "claude");
    assert.equal(claudeLink.state, "ok");
    // .agents/skills/ wasn't pre-created → marked missing here.
    const agentsLink = s.links.find((l) => l.harness === "agents");
    assert.equal(agentsLink.state, "missing");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- removeInstall ---------------------------------------

test("removeInstall: drops harness symlinks but keeps source dir by default", () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  installSkills(tmp);
  const r = removeInstall(tmp);
  assert.equal(r.ok, true);
  // Symlinks under .claude/skills/ should be removed.
  for (const name of listBundledSkills()) {
    const link = path.join(tmp, ".claude/skills", name);
    assert.equal(fs.existsSync(link), false, `${link} should be gone`);
  }
  // But .synapse/skills/ stays.
  assert.ok(fs.existsSync(path.join(tmp, ".synapse/skills")));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("removeInstall --purge: also drops .synapse/skills/", () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  installSkills(tmp);
  removeInstall(tmp, { purge: true });
  assert.equal(fs.existsSync(path.join(tmp, ".synapse/skills")), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- linkOnly --------------------------------------------

test("linkOnly: recreates harness symlinks without touching SKILL.md", () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  installSkills(tmp);
  // Simulate operator deleting .claude/skills/.
  fs.rmSync(path.join(tmp, ".claude/skills"), { recursive: true });
  const r = linkOnly(tmp);
  for (const s of r.symlinks) {
    assert.equal(s.kind, "created");
  }
  // SKILL.md still intact.
  assert.ok(
    fs.existsSync(path.join(tmp, ".synapse/skills/synapse-deploy/SKILL.md")),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- harness detection ----------------------------------

test("detectHarnesses: returns claude when .claude/ exists", () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, ".claude"));
  const found = detectHarnesses(tmp).map((h) => h.id);
  assert.deepEqual(found, ["claude"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("detectHarnesses: returns both when both markers exist", () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, ".claude"));
  fs.writeFileSync(path.join(tmp, "AGENTS.md"), "");
  const found = detectHarnesses(tmp).map((h) => h.id).sort();
  assert.deepEqual(found, ["agents", "claude"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("detectHarnesses: empty dir → no detection", () => {
  const tmp = mkTmp();
  assert.deepEqual(detectHarnesses(tmp), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- symlink helper: refuse to clobber non-symlinks ------

test("createSymlink: refuses to clobber a regular file at the link path", () => {
  const tmp = mkTmp();
  const target = path.join(tmp, "target-dir");
  const link = path.join(tmp, "link");
  fs.mkdirSync(target);
  fs.writeFileSync(link, "real file here");
  const r = createSymlink(target, link);
  assert.equal(r.kind, "failed");
  assert.match(r.reason, /regular file/);
  // Original file untouched.
  assert.equal(fs.readFileSync(link, "utf8"), "real file here");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("createSymlink: replaces wrong-target symlink only with --force", () => {
  const tmp = mkTmp();
  const target1 = path.join(tmp, "old-target");
  const target2 = path.join(tmp, "new-target");
  const link = path.join(tmp, "link");
  fs.mkdirSync(target1);
  fs.mkdirSync(target2);
  fs.symlinkSync(target1, link);
  // Without force: refused.
  let r = createSymlink(target2, link);
  assert.equal(r.kind, "failed");
  assert.match(r.reason, /Re-run with --force/);
  // With force: replaced.
  r = createSymlink(target2, link, { force: true });
  assert.equal(r.kind, "replaced");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("readSymlinkStatus: distinguishes ok / missing / wrong-target / not-a-symlink", () => {
  const tmp = mkTmp();
  const target = path.join(tmp, "target");
  const elsewhere = path.join(tmp, "elsewhere");
  fs.mkdirSync(target);
  fs.mkdirSync(elsewhere);

  // missing
  assert.equal(readSymlinkStatus(path.join(tmp, "nope"), target).state, "missing");
  // ok
  const goodLink = path.join(tmp, "good");
  fs.symlinkSync(target, goodLink);
  assert.equal(readSymlinkStatus(goodLink, target).state, "ok");
  // wrong-target
  const wrongLink = path.join(tmp, "wrong");
  fs.symlinkSync(elsewhere, wrongLink);
  assert.equal(readSymlinkStatus(wrongLink, target).state, "wrong-target");
  // not-a-symlink
  const realFile = path.join(tmp, "real");
  fs.writeFileSync(realFile, "x");
  assert.equal(readSymlinkStatus(realFile, target).state, "not-a-symlink");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("removeSymlink: refuses to drop a non-synapse symlink without --force", () => {
  const tmp = mkTmp();
  const target = path.join(tmp, "real");
  const expected = path.join(tmp, "expected");
  const link = path.join(tmp, "link");
  fs.mkdirSync(target);
  fs.mkdirSync(expected);
  fs.symlinkSync(target, link); // points elsewhere
  const r = removeSymlink(link, expected);
  assert.equal(r.kind, "skipped");
  assert.ok(fs.existsSync(link), "link should still be present");
  fs.rmSync(tmp, { recursive: true, force: true });
});
