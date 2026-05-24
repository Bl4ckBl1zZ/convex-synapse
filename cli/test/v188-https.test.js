// v1.8.8 — `synapse https` command family.
//
// Coverage:
//   - Pure functions (detect.validateDomain, hosts.planAddEntry,
//     planner.plan, nextjs.setDevHttpsScript) tested directly
//   - Executor + integration via a tmp HOME so we exercise the
//     real mkcert path without polluting the operator's ~/.config

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { PassThrough } = require("node:stream");

const detectMod = require("../lib/https/detect");
const plannerMod = require("../lib/https/planner");
const executorMod = require("../lib/https/executor");
const hostsMod = require("../lib/https/hosts");
const nextjsMod = require("../lib/https/nextjs");
const { createOutput } = require("../lib/output");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "synapse-https-test-"));
}

function capture(json = false) {
  const stdoutBuf = [];
  const stderrBuf = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => stdoutBuf.push(c.toString("utf8")));
  stderr.on("data", (c) => stderrBuf.push(c.toString("utf8")));
  return {
    out: createOutput({ json, stdout, stderr }),
    text: () => ({ stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") }),
  };
}

// ---- detect.validateDomain --------------------------------------------

test("validateDomain accepts dev.foo.com / multi-label / punycode", () => {
  assert.equal(detectMod.validateDomain("dev.foo.com").ok, true);
  assert.equal(detectMod.validateDomain("dev.foo.bar.baz.test").ok, true);
  assert.equal(detectMod.validateDomain("xn--ng-mia.com").ok, true);
});

test("validateDomain rejects empty / IP / localhost / single-label / bad chars", () => {
  assert.equal(detectMod.validateDomain("").ok, false);
  assert.equal(detectMod.validateDomain("   ").ok, false);
  assert.equal(detectMod.validateDomain("localhost").ok, false);
  assert.equal(detectMod.validateDomain("foo.localhost").ok, false);
  assert.equal(detectMod.validateDomain("1.2.3.4").ok, false);
  assert.equal(detectMod.validateDomain("::1").ok, false);
  assert.equal(detectMod.validateDomain("singlelabel").ok, false);
  assert.equal(detectMod.validateDomain("-leading.dash.com").ok, false);
  assert.equal(detectMod.validateDomain("trailing-.dash.com").ok, false);
  const longLabel = "a".repeat(64);
  assert.equal(detectMod.validateDomain(`${longLabel}.com`).ok, false);
});

// ---- detect.findCertPairsInDir ---------------------------------------

test("findCertPairsInDir matches both -key.pem and .key.pem conventions", () => {
  const tmp = mkTmp();
  try {
    fs.writeFileSync(path.join(tmp, "dev.foo.com.pem"), "x");
    fs.writeFileSync(path.join(tmp, "dev.foo.com-key.pem"), "x");
    fs.writeFileSync(path.join(tmp, "dev.bar.com.pem"), "x");
    fs.writeFileSync(path.join(tmp, "dev.bar.com.key.pem"), "x");
    fs.writeFileSync(path.join(tmp, "orphan.pem"), "x");
    const pairs = detectMod.findCertPairsInDir(tmp);
    const byDomain = Object.fromEntries(pairs.map((p) => [p.domain, p]));
    assert.equal(byDomain["dev.foo.com"].keyShape, "dash");
    assert.equal(byDomain["dev.bar.com"].keyShape, "dot");
    assert.ok(!byDomain["orphan"], "orphan .pem must NOT be reported");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- detect.devHttpsScriptsEqual --------------------------------------

test("devHttpsScriptsEqual is whitespace-insensitive", () => {
  assert.equal(
    detectMod.devHttpsScriptsEqual("next dev   --turbopack", "next dev --turbopack"),
    true,
  );
  assert.equal(
    detectMod.devHttpsScriptsEqual("next dev --turbopack", "next start"),
    false,
  );
});

// ---- hosts.planAddEntry ----------------------------------------------

test("planAddEntry adds a managed block on a fresh file", () => {
  const initial = "127.0.0.1\tlocalhost\n";
  const plan = hostsMod.planAddEntry(initial, "dev.foo.com");
  assert.equal(plan.changed, true);
  const joined = plan.lines.join("\n");
  assert.match(joined, /synapse https setup — managed entries/);
  assert.match(joined, /127\.0\.0\.1\tdev\.foo\.com/);
});

test("planAddEntry is idempotent inside the managed block", () => {
  const initial = [
    "127.0.0.1\tlocalhost",
    "",
    hostsMod.MANAGED_BLOCK_START,
    "127.0.0.1\tdev.foo.com",
    hostsMod.MANAGED_BLOCK_END,
    "",
  ].join("\n");
  const plan = hostsMod.planAddEntry(initial, "dev.foo.com");
  assert.equal(plan.changed, false);
});

test("planAddEntry supersedes a non-loopback row by commenting it out", () => {
  const initial = "10.0.0.1 dev.foo.com\n127.0.0.1 localhost\n";
  const plan = hostsMod.planAddEntry(initial, "dev.foo.com");
  assert.equal(plan.changed, true);
  const joined = plan.lines.join("\n");
  assert.match(joined, /# 10\.0\.0\.1 dev\.foo\.com\s+# synapse: superseded/);
  assert.match(joined, /127\.0\.0\.1\tdev\.foo\.com/);
});

test("planAddEntry: domain already mapped to loopback outside managed block is idempotent", () => {
  const initial = "127.0.0.1\tdev.foo.com\n";
  const plan = hostsMod.planAddEntry(initial, "dev.foo.com");
  assert.equal(plan.changed, false);
});

// ---- hosts.planRemoveEntry -------------------------------------------

test("planRemoveEntry removes only the matching row inside the managed block", () => {
  const initial = [
    "127.0.0.1\tlocalhost",
    hostsMod.MANAGED_BLOCK_START,
    "127.0.0.1\tdev.foo.com",
    "127.0.0.1\tdev.bar.com",
    hostsMod.MANAGED_BLOCK_END,
    "",
  ].join("\n");
  const plan = hostsMod.planRemoveEntry(initial, "dev.foo.com");
  assert.equal(plan.changed, true);
  const joined = plan.lines.join("\n");
  assert.doesNotMatch(joined, /dev\.foo\.com/);
  assert.match(joined, /dev\.bar\.com/);
});

test("planRemoveEntry strips the managed block when it becomes empty", () => {
  const initial = [
    "127.0.0.1\tlocalhost",
    hostsMod.MANAGED_BLOCK_START,
    "127.0.0.1\tdev.foo.com",
    hostsMod.MANAGED_BLOCK_END,
    "",
  ].join("\n");
  const plan = hostsMod.planRemoveEntry(initial, "dev.foo.com");
  assert.equal(plan.changed, true);
  assert.doesNotMatch(plan.lines.join("\n"), /managed entries/);
});

test("planRemoveEntry never touches mappings OUTSIDE the managed block", () => {
  const initial = "127.0.0.1 dev.foo.com   # operator's own row\n";
  const plan = hostsMod.planRemoveEntry(initial, "dev.foo.com");
  assert.equal(plan.changed, false);
});

// ---- nextjs.setDevHttpsScript ----------------------------------------

test("setDevHttpsScript writes the command + preserves indent + trailing newline", () => {
  const tmp = mkTmp();
  try {
    const pkg = path.join(tmp, "package.json");
    fs.writeFileSync(pkg, JSON.stringify({ name: "x", scripts: { dev: "next" } }, null, 4) + "\n");
    const r = nextjsMod.setDevHttpsScript(pkg, "next dev --experimental-https");
    assert.equal(r.changed, true);
    const after = fs.readFileSync(pkg, "utf8");
    assert.match(after, /"dev:https":\s+"next dev --experimental-https"/);
    assert.match(after, /\n    "name":/);
    assert.ok(after.endsWith("\n"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("setDevHttpsScript is idempotent when script already matches (whitespace-normalised)", () => {
  const tmp = mkTmp();
  try {
    const pkg = path.join(tmp, "package.json");
    fs.writeFileSync(
      pkg,
      JSON.stringify(
        { name: "x", scripts: { "dev:https": "next dev --turbopack" } },
        null,
        2,
      ) + "\n",
    );
    const r = nextjsMod.setDevHttpsScript(pkg, "next  dev  --turbopack");
    assert.equal(r.changed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("removeDevHttpsScript deletes the key + is idempotent", () => {
  const tmp = mkTmp();
  try {
    const pkg = path.join(tmp, "package.json");
    fs.writeFileSync(
      pkg,
      JSON.stringify({ scripts: { dev: "x", "dev:https": "y" } }, null, 2) + "\n",
    );
    const r1 = nextjsMod.removeDevHttpsScript(pkg);
    assert.equal(r1.changed, true);
    const after = JSON.parse(fs.readFileSync(pkg, "utf8"));
    assert.equal(after.scripts["dev:https"], undefined);
    assert.equal(after.scripts.dev, "x");
    const r2 = nextjsMod.removeDevHttpsScript(pkg);
    assert.equal(r2.changed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- planner.plan ----------------------------------------------------

function syntheticDetection(overrides = {}) {
  const domain = overrides.domain || "dev.foo.com";
  return {
    domain,
    cwd: "/tmp/x",
    platform: { id: "linux", node: "linux" },
    packageManagers: ["apt-get"],
    mkcert: { present: true, version: "v1.4.4", caroot: "/tmp/ca" },
    caTrusted: true,
    hasCertutil: true,
    validation: { ok: true },
    resolution: { resolvesToLoopback: false, source: "none", got: [] },
    hosts: {
      path: "/etc/hosts",
      exists: true,
      readable: true,
      writable: false,
      matches: [],
      allLines: ["127.0.0.1 localhost"],
    },
    wslWindowsHosts: null,
    pkg: { path: "/tmp/x/package.json", present: true, parsed: { name: "x" }, hasNext: true, existingDevHttps: null },
    existingCerts: { dir: "/.config/dev-certs/" + domain, certPath: "/.../" + domain + ".pem", keyPath: "/.../" + domain + "-key.pem", present: false },
    legacyCerts: [],
    certStoreClash: false,
    sudoCached: false,
    windowsAdmin: false,
    ...overrides,
  };
}

test("planner: mkcert missing → blocker with package manager hint", () => {
  const steps = plannerMod.plan(
    syntheticDetection({ mkcert: { present: false, version: null, caroot: null } }),
  );
  const blocker = steps.find((s) => s.kind === "blocker");
  assert.ok(blocker);
  assert.match(blocker.blocker, /mkcert is required/);
  assert.match(blocker.blocker, /apt-get install mkcert libnss3-tools/);
});

test("planner: invalid domain → blocker propagates the reason", () => {
  const steps = plannerMod.plan(
    syntheticDetection({ validation: { ok: false, reason: "Domain must include a dot" } }),
  );
  const blocker = steps.find((s) => s.kind === "blocker");
  assert.match(blocker.blocker, /must include a dot/);
});

test("planner: caTrusted=false → schedules mkcert -install", () => {
  const steps = plannerMod.plan(syntheticDetection({ caTrusted: false }));
  assert.equal(steps.find((s) => s.id === "ca-install").kind, "exec");
});

test("planner: DNS resolves to loopback → skip hosts step", () => {
  const steps = plannerMod.plan(
    syntheticDetection({
      resolution: { resolvesToLoopback: true, source: "dns", got: ["127.0.0.1"] },
    }),
  );
  const step = steps.find((s) => s.id === "hosts");
  assert.equal(step.kind, "skip");
  assert.match(step.reason, /via public DNS/);
});

test("planner: hosts entry present AND resolution works → skip hosts step", () => {
  // v1.8.10: the planner now requires BOTH conditions to skip — if
  // hosts file has the entry but resolution still fails (Windows DNS
  // cache bug), we treat it as a fixable issue, not a skip.
  const steps = plannerMod.plan(
    syntheticDetection({
      hosts: {
        path: "/etc/hosts",
        exists: true,
        readable: true,
        writable: false,
        matches: [{ line: "127.0.0.1 dev.foo.com", address: "127.0.0.1", hostnames: ["dev.foo.com"] }],
        allLines: [],
      },
      resolution: { resolvesToLoopback: true, source: "hosts", got: ["127.0.0.1"] },
    }),
  );
  assert.equal(steps.find((s) => s.id === "hosts").kind, "skip");
});

test("planner: cert already present → skip; --force → exec", () => {
  const certs = { dir: "/c", certPath: "/c/x.pem", keyPath: "/c/x-key.pem", present: true };
  const skipSteps = plannerMod.plan(syntheticDetection({ existingCerts: certs }));
  assert.equal(skipSteps.find((s) => s.id === "cert-generate").kind, "skip");
  const forceSteps = plannerMod.plan(syntheticDetection({ existingCerts: certs }), { force: true });
  assert.equal(forceSteps.find((s) => s.id === "cert-generate").kind, "exec");
});

test("planner: package.json missing → script step is a skip with manual hint", () => {
  const steps = plannerMod.plan(
    syntheticDetection({
      pkg: { path: "/tmp/x/package.json", present: false, parsed: null, hasNext: false, existingDevHttps: null },
    }),
  );
  const step = steps.find((s) => s.id === "script");
  assert.equal(step.kind, "skip");
  assert.match(step.skipReason, /add manually/);
});

test("planner: existing dev:https matches canonical → idempotent skip", () => {
  const det = syntheticDetection();
  const command = plannerMod.devHttpsCommandFor(det, det.domain);
  det.pkg.existingDevHttps = command;
  const steps = plannerMod.plan(det);
  assert.equal(steps.find((s) => s.id === "script").kind, "skip");
});

test("planner: existing dev:https differs → exec with before/after in reason", () => {
  const det = syntheticDetection();
  det.pkg.existingDevHttps = "next dev --hostname old.com";
  const steps = plannerMod.plan(det);
  const step = steps.find((s) => s.id === "script");
  assert.equal(step.kind, "exec");
  assert.match(step.reason, /existing script differs/);
});

test("planner: WSL + missing public DNS + Windows hosts file present → warn step", () => {
  const det = syntheticDetection({
    platform: { id: "wsl", node: "linux" },
    wslWindowsHosts: {
      path: "/mnt/c/Windows/System32/drivers/etc/hosts",
      exists: true,
      readable: true,
      writable: false,
      matches: [],
      allLines: [],
    },
  });
  const steps = plannerMod.plan(det);
  const warn = steps.find((s) => s.id === "hosts-wsl");
  assert.ok(warn);
  assert.equal(warn.kind, "warn");
});

test("planner: legacy certs in cwd → warn with migrate hint", () => {
  const det = syntheticDetection({
    legacyCerts: [{ domain: "old.foo.com", cert: "/x/old.foo.com.pem", key: "/x/old.foo.com-key.pem" }],
  });
  const steps = plannerMod.plan(det);
  const warn = steps.find((s) => s.id === "legacy-warn");
  assert.match(warn.skipReason, /synapse https migrate/);
});

// ---- planner.planRemove ----------------------------------------------

test("planRemove: certs absent + hosts absent + script absent → all skip", () => {
  const det = syntheticDetection({
    existingCerts: { dir: "/d", certPath: "/d/x.pem", keyPath: "/d/x-key.pem", present: false },
  });
  det.hosts.matches = [];
  det.pkg.existingDevHttps = null;
  const steps = plannerMod.planRemove(det);
  for (const s of steps) assert.equal(s.kind, "skip", `${s.id} should be skip`);
});

test("planRemove: --keep-* flags suppress the corresponding step", () => {
  const det = syntheticDetection({
    existingCerts: { dir: "/d", certPath: "/d/x.pem", keyPath: "/d/x-key.pem", present: true },
  });
  det.hosts.matches = [{ line: "x", address: "127.0.0.1", hostnames: [det.domain] }];
  det.pkg.existingDevHttps = "next dev";
  const all = plannerMod.planRemove(det);
  assert.equal(all.find((s) => s.id === "cert-remove").kind, "exec");
  assert.equal(all.find((s) => s.id === "hosts-remove").kind, "exec");
  assert.equal(all.find((s) => s.id === "script-remove").kind, "exec");
  const keep = plannerMod.planRemove(det, { keepCerts: true, keepHosts: true, keepScript: true });
  assert.ok(!keep.find((s) => s.id === "cert-remove"));
  assert.ok(!keep.find((s) => s.id === "hosts-remove"));
  assert.ok(!keep.find((s) => s.id === "script-remove"));
});

// ---- executor --------------------------------------------------------

test("executor runs exec steps in order, skips others, stops on first failure", async () => {
  const cap = capture();
  const calls = [];
  const steps = [
    { id: "a", title: "a", kind: "exec", reason: "x", run: async () => { calls.push("a"); return {}; } },
    { id: "b", title: "b", kind: "skip", reason: "noop" },
    { id: "c", title: "c", kind: "exec", reason: "y", run: async () => { calls.push("c"); throw new Error("boom"); } },
    { id: "d", title: "d", kind: "exec", reason: "z", run: async () => { calls.push("d"); return {}; } },
  ];
  const { results, failedAny } = await executorMod.execute(steps, { out: cap.out });
  assert.equal(failedAny, true);
  assert.deepEqual(calls, ["a", "c"], "d should NOT run after c failed");
  assert.equal(results.find((r) => r.id === "a").kind, "ok");
  assert.equal(results.find((r) => r.id === "b").kind, "skip");
  assert.equal(results.find((r) => r.id === "c").kind, "failed");
});

test("executor.hasBlocker detects blocker steps", () => {
  assert.equal(
    executorMod.hasBlocker([{ id: "x", kind: "blocker", title: "x", blocker: "no" }]),
    true,
  );
  assert.equal(
    executorMod.hasBlocker([{ id: "x", kind: "exec", title: "x", run: async () => {} }]),
    false,
  );
});

// ---- Command module shape --------------------------------------------

test("https commands follow the dispatcher's two-word convention", () => {
  const setup = require("../lib/commands/https-setup");
  const status = require("../lib/commands/https-status");
  const doctor = require("../lib/commands/https-doctor");
  const remove = require("../lib/commands/https-remove");
  const migrate = require("../lib/commands/https-migrate");
  assert.equal(setup.name, "https setup");
  assert.equal(status.name, "https status");
  assert.equal(doctor.name, "https doctor");
  assert.equal(remove.name, "https remove");
  assert.equal(migrate.name, "https migrate");
});

// ---- Integration: live mkcert (skipped if mkcert absent) ------------

test("integration: setup → status → remove roundtrip (requires mkcert)", async (t) => {
  if (!detectMod.commandExists("mkcert")) {
    t.skip("mkcert not on PATH");
    return;
  }
  const domain = `dev.synapse-test-${Date.now()}.local`;
  const homedirOriginal = os.homedir;
  const tmpHome = mkTmp();
  os.homedir = () => tmpHome;
  try {
    const cwd = mkTmp();
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify(
        { name: "smoke", scripts: { dev: "next dev" }, dependencies: { next: "^16.0.0" } },
        null,
        2,
      ) + "\n",
    );
    const det = await detectMod.scan({ domain, cwd });
    const steps = plannerMod.plan(det, { skipHosts: true });
    const cap = capture();
    const { failedAny } = await executorMod.execute(steps, { out: cap.out });
    assert.equal(failedAny, false, `executor failed: ${cap.text().stderr}`);
    const certs = detectMod.certFilesFor(domain);
    assert.ok(fs.existsSync(certs.cert), "cert.pem written");
    assert.ok(fs.existsSync(certs.key), "key.pem written");
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    assert.match(pkg.scripts["dev:https"], new RegExp(domain));
    // Remove leg.
    const removeSteps = plannerMod.planRemove(
      await detectMod.scan({ domain, cwd }),
      { keepHosts: true },
    );
    const removeCap = capture();
    const { failedAny: removeFailed } = await executorMod.execute(removeSteps, { out: removeCap.out });
    assert.equal(removeFailed, false);
    assert.ok(!fs.existsSync(certs.cert), "cert deleted");
    const afterPkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    assert.equal(afterPkg.scripts["dev:https"], undefined);
    fs.rmSync(cwd, { recursive: true, force: true });
  } finally {
    os.homedir = homedirOriginal;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---- v1.9.3: BOM strip + force re-write + ACL/diagnosis --------------
// Windows hosts failures reported in the field: a UTF-8 BOM and a
// clobbered hosts ACL both make Windows ignore the entire hosts file,
// and the old code (a) preserved the BOM through read/write and (b)
// reset the ACL by Move-Item'ing a temp file over the original. These
// tests lock the cross-platform-observable behaviour (BOM strip, force
// re-write, no-BOM on disk). The Windows-only icacls/in-place specifics
// are exercised by the PowerShell script string, asserted below.

test("readHosts strips a leading UTF-8 BOM", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-bom-"));
  const p = path.join(dir, "hosts");
  // EF BB BF + content
  fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("127.0.0.1 dev.foo.com\n")]));
  const content = hostsMod.readHosts(p);
  assert.equal(content.charCodeAt(0), "1".charCodeAt(0), "BOM stripped — first char is the address digit");
  assert.ok(!content.includes("﻿"), "no U+FEFF anywhere");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hasUtf8Bom detects + rejects correctly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-bom2-"));
  const withBom = path.join(dir, "with");
  const without = path.join(dir, "without");
  fs.writeFileSync(withBom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")]));
  fs.writeFileSync(without, "127.0.0.1 dev.foo.com\n");
  assert.equal(hostsMod.hasUtf8Bom(withBom), true);
  assert.equal(hostsMod.hasUtf8Bom(without), false);
  assert.equal(hostsMod.hasUtf8Bom(path.join(dir, "nope")), false, "missing file → false");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeHosts (direct) never leaves a BOM on disk even if handed one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-bom3-"));
  const p = path.join(dir, "hosts");
  hostsMod.writeHosts(p, "﻿127.0.0.1\tdev.foo.com\n", { platform: "linux" });
  const raw = fs.readFileSync(p);
  assert.notDeepEqual([raw[0], raw[1], raw[2]], [0xef, 0xbb, 0xbf], "no BOM bytes at the head");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("addEntry force:true re-writes even when the entry already exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-force-"));
  const p = path.join(dir, "hosts");
  // Pre-seed with the entry already present (so planAddEntry is a no-op).
  fs.writeFileSync(p, [hostsMod.MANAGED_BLOCK_START, "127.0.0.1\tdev.foo.com", hostsMod.MANAGED_BLOCK_END, ""].join("\n"));
  let writes = 0;
  const writeImpl = (fp, content) => { writes += 1; fs.writeFileSync(fp, content); };

  // Without force: no write (idempotent).
  const r1 = hostsMod.addEntry(p, "dev.foo.com", { platform: "linux", writeImpl });
  assert.equal(r1.changed, false);
  assert.equal(writes, 0, "no write when content is unchanged and force is off");

  // With force: writes anyway (this is what triggers ACL regrant +
  // flushdns on the real Windows path).
  const r2 = hostsMod.addEntry(p, "dev.foo.com", { platform: "linux", writeImpl, force: true });
  assert.equal(r2.changed, false, "content didn't change");
  assert.equal(r2.forced, true, "but it was force-written");
  assert.equal(writes, 1, "exactly one forced write");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeHostsViaRunAs PowerShell: in-place WriteAllText + icacls regrant + no Move-Item", () => {
  let psArgs = null;
  const execImpl = (cmd, args) => {
    if (cmd === "powershell") psArgs = args.join(" ");
    // Simulate the elevated child having written the content so the
    // post-write verification (readHosts === content) passes.
    return Buffer.from("");
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-runas-"));
  const p = path.join(dir, "hosts");
  const content = "127.0.0.1\tdev.foo.com\n";
  // Seed the file so the verification read matches what we "wrote".
  fs.writeFileSync(p, content);
  try {
    hostsMod.writeHostsViaRunAs(p, content, { execImpl });
  } catch {
    // The verification may still throw in some environments; we only
    // assert on the generated script, captured before any throw.
  }
  assert.ok(psArgs, "powershell was invoked");
  assert.ok(psArgs.includes("WriteAllText"), "writes in place via .NET WriteAllText");
  assert.ok(psArgs.includes("UTF8Encoding"), "UTF-8 encoder (no-BOM constructor)");
  assert.ok(psArgs.includes("icacls"), "regrants ACL via icacls");
  assert.ok(psArgs.includes("S-1-5-20"), "grants NETWORK SERVICE (Dnscache) read");
  assert.ok(psArgs.includes("S-1-5-32-545"), "grants BUILTIN\\Users read");
  assert.ok(psArgs.includes("flushdns"), "flushes the DNS cache");
  assert.ok(!psArgs.includes("Move-Item"), "no Move-Item (would reset the ACL)");
  fs.rmSync(dir, { recursive: true, force: true });
});
