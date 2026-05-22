const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { generateReport, runChecks, totalize, exitCodeFor } = require("../lib/doctor/runner");
const { isBrowserReachable, cmpVer } = require("../lib/doctor/checks");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doctor-test-"));
}

test("isBrowserReachable: custom-domain URL", () => {
  assert.equal(isBrowserReachable("https://api.client.com"), true);
});
test("isBrowserReachable: wildcard subdomain", () => {
  assert.equal(isBrowserReachable("https://foo.app.example.com"), true);
});
test("isBrowserReachable: localhost any port", () => {
  assert.equal(isBrowserReachable("http://localhost:3210"), true);
  assert.equal(isBrowserReachable("http://127.0.0.1:9999"), true);
});
test("isBrowserReachable: host:dynamic-port form is NOT reachable", () => {
  assert.equal(isBrowserReachable("https://synapsepanel.com:3213"), false);
});
test("isBrowserReachable: unparseable URL → false", () => {
  assert.equal(isBrowserReachable("not-a-url"), false);
  assert.equal(isBrowserReachable(""), false);
  assert.equal(isBrowserReachable(undefined), false);
});

test("cmpVer: basic ordering", () => {
  assert.equal(cmpVer("v18.17.0", "18.17.0"), 0);
  assert.equal(cmpVer("18.16.0", "18.17.0"), -1);
  assert.equal(cmpVer("19.0.0", "18.17.0"), 1);
  assert.equal(cmpVer("20.10.0", "20.5.5"), 1);
});

test("totalize: counts by status + fixed", () => {
  const r = [
    { status: "ok" },
    { status: "ok" },
    { status: "warn" },
    { status: "issue", fixedBy: "auto" },
    { status: "skipped" },
  ];
  const t = totalize(r);
  assert.deepEqual(t, { ok: 2, warn: 1, issue: 1, skipped: 1, fixed: 1 });
});

test("exitCodeFor: 0/1/2 mapping", () => {
  assert.equal(exitCodeFor({ ok: 5, warn: 0, issue: 0, skipped: 0 }), 0);
  assert.equal(exitCodeFor({ ok: 5, warn: 1, issue: 0, skipped: 0 }), 1);
  assert.equal(exitCodeFor({ ok: 5, warn: 1, issue: 2, skipped: 0 }), 2);
  // Skipped alone doesn't trigger warn — operator wasn't logged in,
  // doctor reports informational result with exit 0.
  assert.equal(exitCodeFor({ ok: 0, warn: 0, issue: 0, skipped: 5 }), 0);
});

test("runChecks: cascades skipped through unmet dependsOn", async () => {
  const fakeChecks = [
    {
      id: "a",
      category: "test",
      title: "always issue",
      dependsOn: [],
      run: async () => ({ status: "issue", summary: "boom" }),
    },
    {
      id: "b",
      category: "test",
      title: "depends on a",
      dependsOn: ["a"],
      run: async () => {
        throw new Error("must not run when a failed");
      },
    },
  ];
  const ctx = {};
  const results = await runChecks(fakeChecks, ctx);
  assert.equal(results.length, 2);
  assert.equal(results[0].status, "issue");
  assert.equal(results[1].status, "skipped");
  assert.match(results[1].summary, /prereq failed: a/);
});

test("runChecks: independent checks run in declaration order, return correct status", async () => {
  const fakeChecks = [
    {
      id: "one",
      category: "test",
      title: "one",
      dependsOn: [],
      run: async () => ({ status: "ok", summary: "yep" }),
    },
    {
      id: "two",
      category: "test",
      title: "two",
      dependsOn: [],
      run: async () => ({ status: "warn", summary: "meh" }),
    },
  ];
  const results = await runChecks(fakeChecks, {});
  assert.equal(results[0].id, "one");
  assert.equal(results[0].status, "ok");
  assert.equal(results[1].id, "two");
  assert.equal(results[1].status, "warn");
});

test("generateReport: schemaVersion + totals + exitCode all populated on a minimal ctx", async () => {
  const tmp = mkTmp();
  const cfgPath = path.join(tmp, "config.json");
  // No saved session → backend checks skip.
  const ctx = {
    cwd: tmp,
    env: {},
    cfg: null,
    api: null,
    projectConfig: null,
    cfgPath,
    homedir: os.homedir(),
  };
  const report = await generateReport(ctx);
  assert.equal(report.schemaVersion, "1.0");
  assert.ok(report.cliVersion);
  assert.equal(report.env.cwd, tmp);
  assert.equal(report.env.synapseUrl, null);
  assert.ok(Array.isArray(report.results));
  assert.ok(report.results.length > 0);
  assert.ok(report.totals.ok + report.totals.warn + report.totals.issue + report.totals.skipped === report.results.length);
  // No session → some warn (gitignore, no config) and skipped (backend), no hard issues.
  assert.equal(report.exitCode, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("generateReport --fix: gitignore auto-fix appends missing entries", async () => {
  const tmp = mkTmp();
  // Pre-create an empty gitignore so the check fires its WARN path.
  fs.writeFileSync(path.join(tmp, ".gitignore"), "node_modules\n");
  const ctx = {
    cwd: tmp,
    env: {},
    cfg: null,
    api: null,
    projectConfig: null,
    cfgPath: path.join(tmp, "config.json"),
    homedir: os.homedir(),
  };
  const report = await generateReport(ctx, { fix: true });
  const giFinal = fs.readFileSync(path.join(tmp, ".gitignore"), "utf8");
  assert.match(giFinal, /\.env\.local/);
  assert.match(giFinal, /\.synapse\//);
  // The corresponding check should now be ok + fixedBy populated.
  const gi = report.results.find((r) => r.id === "gitignore-protects-env");
  assert.equal(gi.status, "ok");
  assert.ok(gi.fixedBy);
  fs.rmSync(tmp, { recursive: true, force: true });
});
