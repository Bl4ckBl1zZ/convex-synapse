// v1.8.10 — Windows DNS-flush bug found on Matheus's machine.
//
// Symptom: `synapse https setup` writes hosts file successfully but
// Windows DNS Client (Dnscache) keeps returning NXDOMAIN, so Node's
// dns.lookup + `next dev` both fail with ENOTFOUND.
//
// Fixes covered:
//   1. writeHosts on Windows runs `ipconfig /flushdns` after the
//      write (both direct and elevated paths).
//   2. writeHosts on Windows normalises line endings to CRLF.
//   3. Planner: when hosts file has the entry but resolution still
//      fails, that's an "exec" step (not "skip"), labelled "Refresh
//      DNS cache".
//   4. https setup post-execute verifies dns.lookup AFTER everything
//      and surfaces a yellow warning + remediation if it still fails.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const hostsMod = require("../lib/https/hosts");
const plannerMod = require("../lib/https/planner");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "synapse-windns-test-"));
}

// ---- (1) ipconfig /flushdns fires on Windows after a hosts write --

test("writeHosts on Windows triggers `ipconfig /flushdns` after direct write", () => {
  const tmp = mkTmp();
  try {
    const hostsPath = path.join(tmp, "hosts");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n");
    const execCalls = [];
    const fakeExec = (cmd, args) => {
      execCalls.push({ cmd, args });
    };
    const result = hostsMod.writeHosts(hostsPath, "127.0.0.1\tlocalhost\r\n127.0.0.1\tdev.foo.com\r\n", {
      platform: "win32",
      execImpl: fakeExec,
    });
    assert.equal(result.method, "direct");
    assert.equal(result.dnsFlushed, true);
    assert.ok(
      execCalls.some((c) => c.cmd === "ipconfig" && c.args[0] === "/flushdns"),
      `expected ipconfig /flushdns; got: ${JSON.stringify(execCalls)}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeHosts on Linux does NOT call ipconfig /flushdns", () => {
  const tmp = mkTmp();
  try {
    const hostsPath = path.join(tmp, "hosts");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n");
    const execCalls = [];
    const fakeExec = (cmd, args) => execCalls.push({ cmd, args });
    const result = hostsMod.writeHosts(hostsPath, "127.0.0.1\tlocalhost\n", {
      platform: "linux",
      execImpl: fakeExec,
    });
    assert.equal(result.method, "direct");
    assert.equal(result.dnsFlushed, undefined, "no DNS flush on Linux");
    assert.equal(execCalls.length, 0, "no exec on direct-write Linux path");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("flushDnsCacheIfWindows is a no-op on non-windows platforms", () => {
  const r = hostsMod.flushDnsCacheIfWindows({ platform: "linux", execImpl: () => assert.fail("should not call") });
  assert.equal(r.ran, false);
});

test("flushDnsCacheIfWindows returns ran:true on win32 with success", () => {
  let called = false;
  const r = hostsMod.flushDnsCacheIfWindows({
    platform: "win32",
    execImpl: (cmd, args) => {
      called = true;
      assert.equal(cmd, "ipconfig");
      assert.deepEqual(args, ["/flushdns"]);
    },
  });
  assert.equal(called, true);
  assert.equal(r.ran, true);
});

test("flushDnsCacheIfWindows captures the error reason when exec throws", () => {
  const r = hostsMod.flushDnsCacheIfWindows({
    platform: "win32",
    execImpl: () => {
      throw new Error("EPERM: not allowed");
    },
  });
  assert.equal(r.ran, false);
  assert.match(r.reason, /EPERM/);
});

// ---- (2) CRLF line-ending normalization on Windows ----------------

test("writeHosts on Windows writes CRLF line endings", () => {
  const tmp = mkTmp();
  try {
    const hostsPath = path.join(tmp, "hosts");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n");
    // Pass LF-only content; the writer must normalise to CRLF on Win32.
    const lfContent = "127.0.0.1\tlocalhost\n127.0.0.1\tdev.foo.com\n";
    hostsMod.writeHosts(hostsPath, lfContent, {
      platform: "win32",
      execImpl: () => {}, // swallow ipconfig
    });
    const onDisk = fs.readFileSync(hostsPath, "utf8");
    assert.match(onDisk, /\r\n/, "must contain CRLF line endings");
    assert.doesNotMatch(onDisk, /[^\r]\n/, "no bare LF left over");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeHosts on Linux preserves LF line endings", () => {
  const tmp = mkTmp();
  try {
    const hostsPath = path.join(tmp, "hosts");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n");
    hostsMod.writeHosts(hostsPath, "127.0.0.1\tlocalhost\n", {
      platform: "linux",
    });
    const onDisk = fs.readFileSync(hostsPath, "utf8");
    assert.doesNotMatch(onDisk, /\r/, "Linux must use bare LF, no CR injected");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- (3) Planner: "hosts has entry + DNS doesn't resolve" → exec --

function syntheticDetection(overrides = {}) {
  const domain = overrides.domain || "dev.foo.com";
  return {
    domain,
    cwd: "/tmp/x",
    platform: { id: "windows", node: "win32" },
    packageManagers: ["choco"],
    mkcert: { present: true, version: "v1.4.4", caroot: "C:\\Users\\m\\AppData" },
    caTrusted: true,
    hasCertutil: true,
    validation: { ok: true },
    resolution: { resolvesToLoopback: false, source: "none", got: [] },
    hosts: {
      path: "C:\\Windows\\System32\\drivers\\etc\\hosts",
      exists: true,
      readable: true,
      writable: true,
      matches: [{ line: "127.0.0.1 dev.foo.com", address: "127.0.0.1", hostnames: [domain] }],
      allLines: [],
    },
    wslWindowsHosts: null,
    pkg: { path: "/tmp/x/package.json", present: true, parsed: { name: "x" }, hasNext: true, existingDevHttps: null },
    existingCerts: { dir: "/c", certPath: "/c/x.pem", keyPath: "/c/x-key.pem", present: true },
    legacyCerts: [],
    certStoreClash: false,
    sudoCached: false,
    windowsAdmin: true,
    ...overrides,
  };
}

test("planner: Windows hosts entry present + resolution fails → exec 'Refresh DNS cache' (v1.8.10 fix)", () => {
  const steps = plannerMod.plan(syntheticDetection({}));
  const hosts = steps.find((s) => s.id === "hosts");
  assert.ok(hosts);
  assert.equal(hosts.kind, "exec", "must be EXEC, not skip — this was the Matheus bug");
  assert.match(hosts.title, /Refresh DNS cache for dev\.foo\.com/);
  assert.match(hosts.reason, /Windows DNS cache is stale/);
});

test("planner: Linux hosts entry present + resolution fails → also exec, with Linux-shaped message", () => {
  const steps = plannerMod.plan(
    syntheticDetection({ platform: { id: "linux", node: "linux" }, hosts: { ...syntheticDetection().hosts, path: "/etc/hosts" } }),
  );
  const hosts = steps.find((s) => s.id === "hosts");
  assert.equal(hosts.kind, "exec");
  assert.match(hosts.reason, /resolution still fails/);
  assert.doesNotMatch(hosts.reason, /Windows DNS cache/);
});

test("planner: hosts entry present + resolution OK → skip with 'cache fresh' reason", () => {
  const steps = plannerMod.plan(
    syntheticDetection({
      resolution: { resolvesToLoopback: true, source: "hosts", got: ["127.0.0.1"] },
    }),
  );
  const hosts = steps.find((s) => s.id === "hosts");
  assert.equal(hosts.kind, "skip");
  assert.match(hosts.reason, /resolution works/);
});

// ---- (4) Setup post-verify (sanity that the flow exists) ----------

test("https-setup module exports renderResults so the post-verify path can pretty-print", () => {
  const setup = require("../lib/commands/https-setup");
  assert.equal(typeof setup.renderResults, "function");
  assert.equal(typeof setup.renderPlan, "function");
});

// ---- (5) Idempotent re-run on freshly-flushed cache --------------

test("planner: after a hosts-cache-fix run (resolution now works), re-running is a skip", () => {
  // First pass — resolution still failing.
  const det1 = syntheticDetection({});
  const steps1 = plannerMod.plan(det1);
  assert.equal(steps1.find((s) => s.id === "hosts").kind, "exec");

  // Imagine the fix ran successfully and DNS now resolves. Re-scan
  // would produce a new detection with resolvesToLoopback: true.
  const det2 = syntheticDetection({
    resolution: { resolvesToLoopback: true, source: "hosts", got: ["127.0.0.1"] },
  });
  const steps2 = plannerMod.plan(det2);
  assert.equal(steps2.find((s) => s.id === "hosts").kind, "skip", "second pass must be no-op");
});
