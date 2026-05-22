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
  assert.deepEqual(t, {
    ok: 2,
    warn: 1,
    issue: 1,
    skipped: 1,
    fixed: 1,
    fixableAuto: 0,
    fixablePrompt: 0,
  });
});

test("totalize: counts fixableAuto + fixablePrompt for v1.8.5 tip footer", () => {
  const r = [
    { status: "warn", fixable: "auto" }, // auto-fixable → counted
    { status: "issue", fixable: "auto" }, // auto-fixable → counted
    { status: "issue", fixable: "prompt" }, // prompt-fixable → counted
    { status: "warn", fixable: null }, // not fixable → not counted
    { status: "warn", fixable: "auto", fixedBy: "applied" }, // already fixed → not counted
    { status: "ok", fixable: "auto" }, // ok → not counted
  ];
  const t = totalize(r);
  assert.equal(t.fixableAuto, 2);
  assert.equal(t.fixablePrompt, 1);
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

// ---- v1.8.1 Bug 3: --fix --yes remediates stale project.json -----

const { writeProjectConfig, readProjectConfig } = require("../lib/project");

function seedStaleProject(tmp, { teamSlug = "team-a", projectId = "OLD", projectSlug = "demo" } = {}) {
  writeProjectConfig(tmp, {
    synapseUrl: "https://x",
    team: { slug: teamSlug, name: "Team A", id: "team-a-id" },
    project: { id: projectId, slug: projectSlug, name: "Demo" },
    deployments: {},
  });
}

function stubApi({ teamsList, projectsByTeam }) {
  return {
    async teams() {
      return teamsList;
    },
    async projects(teamRef) {
      return projectsByTeam[teamRef] || [];
    },
    async me() {
      return { email: "ian@example.com" };
    },
  };
}

// Backend-reachable + a deployment check both use globalThis.fetch
// directly (not through ctx.api). Stub the global so we don't time out
// trying to reach the made-up baseUrl. Restore in afterEach.
function installFetchStub() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/v1/install_status")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "1.8.1", firstRun: false }),
      };
    }
    if (u.endsWith("/version")) {
      return { ok: true, status: 200, text: async () => "1.8.1" };
    }
    return { ok: false, status: 404, json: async () => ({ code: "unknown" }) };
  };
  return () => {
    globalThis.fetch = original;
  };
}

test("Bug 3 — heuristic B: --fix --yes re-links when slug is unambiguously in one other team", async () => {
  const tmp = mkTmp();
  const restore = installFetchStub();
  seedStaleProject(tmp, { teamSlug: "a", projectId: "OLD", projectSlug: "demo" });
  const teamsList = [
    { id: "a-id", slug: "a", name: "Team A" },
    { id: "b-id", slug: "b", name: "Team B" },
  ];
  const projectsByTeam = {
    a: [], // project was transferred away from A
    b: [{ id: "NEW", slug: "demo", name: "Demo" }],
  };
  const ctx = {
    cwd: tmp,
    env: {},
    cfg: { baseUrl: "https://x", accessToken: "t" },
    api: stubApi({ teamsList, projectsByTeam }),
    projectConfig: readProjectConfig(tmp),
    cfgPath: path.join(tmp, "config.json"),
    homedir: os.homedir(),
  };
  const report = await generateReport(ctx, { fix: true, allowPrompt: true });
  restore();
  const written = readProjectConfig(tmp);
  assert.equal(written.team.slug, "b");
  assert.equal(written.project.id, "NEW");
  const r = report.results.find((x) => x.id === "project-still-exists");
  assert.ok(r.fixedBy, "fixedBy populated");
  assert.match(r.fixedBy, /re-linked/);
  assert.ok(report.totals.fixed >= 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Bug 3 — fallback C: ambiguous match → marks project.json stale, preserves previous", async () => {
  const tmp = mkTmp();
  const restore = installFetchStub();
  seedStaleProject(tmp, { teamSlug: "a", projectId: "OLD", projectSlug: "demo" });
  // Two teams own a `demo` project; can't disambiguate → must fall back.
  const teamsList = [
    { id: "a-id", slug: "a", name: "Team A" },
    { id: "b-id", slug: "b", name: "Team B" },
    { id: "c-id", slug: "c", name: "Team C" },
  ];
  const projectsByTeam = {
    a: [],
    b: [{ id: "NEW1", slug: "demo", name: "Demo" }],
    c: [{ id: "NEW2", slug: "demo", name: "Demo" }],
  };
  const ctx = {
    cwd: tmp,
    env: {},
    cfg: { baseUrl: "https://x", accessToken: "t" },
    api: stubApi({ teamsList, projectsByTeam }),
    projectConfig: readProjectConfig(tmp),
    cfgPath: path.join(tmp, "config.json"),
    homedir: os.homedir(),
  };
  const report = await generateReport(ctx, { fix: true, allowPrompt: true });
  restore();
  const written = readProjectConfig(tmp);
  assert.equal(written.staleReason, "project-not-found");
  assert.ok(written.staleAt);
  assert.equal(written.previous.project.id, "OLD");
  assert.equal(written.project, undefined, "project block stripped");
  const r = report.results.find((x) => x.id === "project-still-exists");
  assert.match(r.fixedBy, /marked stale/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Bug 3 — --fix without --yes is a no-op (prompt class respects allowPrompt)", async () => {
  const tmp = mkTmp();
  const restore = installFetchStub();
  seedStaleProject(tmp, { teamSlug: "a", projectId: "OLD", projectSlug: "demo" });
  const teamsList = [{ id: "a-id", slug: "a", name: "Team A" }];
  const projectsByTeam = { a: [] };
  const ctx = {
    cwd: tmp,
    env: {},
    cfg: { baseUrl: "https://x", accessToken: "t" },
    api: stubApi({ teamsList, projectsByTeam }),
    projectConfig: readProjectConfig(tmp),
    cfgPath: path.join(tmp, "config.json"),
    homedir: os.homedir(),
  };
  const report = await generateReport(ctx, { fix: true, allowPrompt: false });
  restore();
  const written = readProjectConfig(tmp);
  // File should be untouched.
  assert.equal(written.project.id, "OLD");
  assert.equal(written.staleReason, undefined);
  const r = report.results.find((x) => x.id === "project-still-exists");
  assert.equal(r.fixedBy, undefined);
  assert.equal(r.status, "issue");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Bug 3 — stale marker is recognized by checkInProjectDir on subsequent runs", async () => {
  const tmp = mkTmp();
  // Write a marker directly (simulating "post-fix state").
  writeProjectConfig(tmp, {
    synapseUrl: "https://x",
    staleReason: "project-not-found",
    staleAt: "2026-05-22T12:00:00.000Z",
    previous: { team: { slug: "a" }, project: { id: "OLD", slug: "demo" } },
  });
  const ctx = {
    cwd: tmp,
    env: {},
    cfg: null,
    api: null,
    projectConfig: readProjectConfig(tmp),
    cfgPath: path.join(tmp, "config.json"),
    homedir: os.homedir(),
  };
  const report = await generateReport(ctx);
  const r = report.results.find((x) => x.id === "in-project-dir");
  assert.equal(r.status, "warn");
  assert.match(r.summary, /staleReason: project-not-found/);
  // project-still-exists should skip (no project.id).
  const pse = report.results.find((x) => x.id === "project-still-exists");
  assert.equal(pse.status, "skipped");
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
