// Smoke tests for the four new v1.8.0 commands: version, status,
// open, doctor. Heavier integration is in the doctor.test.js suite;
// this file covers each command's parsing surface + the stuff that
// breaks if a renderer/JSON shape ever drifts.

const assert = require("node:assert/strict");
const test = require("node:test");
const { PassThrough } = require("node:stream");

const versionCmd = require("../lib/commands/version");
const statusCmd = require("../lib/commands/status");
const openCmd = require("../lib/commands/open");

function capture() {
  const stdoutBuf = [];
  const stderrBuf = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => stdoutBuf.push(c.toString("utf8")));
  stderr.on("data", (c) => stderrBuf.push(c.toString("utf8")));
  return {
    stdout,
    stderr,
    out: { stdout, stderr, json: false },
    text: () => ({ stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") }),
  };
}

function mockOut(json = false) {
  const cap = capture();
  const { createOutput } = require("../lib/output");
  return {
    cap,
    out: createOutput({ json, stdout: cap.stdout, stderr: cap.stderr }),
  };
}

// ---- version -------------------------------------------------------

test("version: each command module shape is well-formed", () => {
  for (const cmd of [versionCmd, statusCmd, openCmd]) {
    assert.ok(cmd.name, `missing name in ${JSON.stringify(cmd)}`);
    assert.ok(cmd.summary);
    assert.ok(cmd.usage);
    assert.equal(typeof cmd.run, "function");
  }
});

test("version: emits cli/node/platform even without a session", async () => {
  const { cap, out } = mockOut(false);
  const ctx = { out, cfgOrNull: null };
  await versionCmd.run([], ctx);
  const txt = cap.text().stdout;
  assert.match(txt, /^cli\s+\d+\.\d+\.\d+/m);
  assert.match(txt, /^node\s+v\d+/m);
  assert.match(txt, /^platform/m);
  assert.match(txt, /not logged in/);
});

test("version --json: stable schema with cli/backend/node/platform keys", async () => {
  const { cap, out } = mockOut(true);
  const ctx = { out, cfgOrNull: null };
  await versionCmd.run([], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.ok(parsed.cli);
  assert.equal(parsed.backend, null);
  assert.match(parsed.backendError, /not logged in/);
  assert.ok(parsed.node);
  assert.ok(parsed.platform);
});

// ---- status --------------------------------------------------------

test("status: urlForm classifies the four shapes correctly", () => {
  const f = statusCmd.urlForm;
  assert.equal(f("https://api.client.com", "https://synapsepanel.com"), "custom");
  assert.equal(f("https://foo.app.example.com", "https://example.com"), "wildcard");
  assert.equal(f("https://synapsepanel.com/d/x", "https://synapsepanel.com"), "path");
  assert.equal(f("https://synapsepanel.com:3210", "https://synapsepanel.com"), "host");
  assert.equal(f("", "https://x"), "unknown");
  assert.equal(f("not-a-url", "https://x"), "unknown");
});

test("status --json: emits {projectId, project, deployments[]} with urlForm per row", async () => {
  const { cap, out } = mockOut(true);
  const ctx = {
    out,
    cwd: process.cwd(),
    cfg: { baseUrl: "https://synapsepanel.com" },
    requireProject: () => ({
      project: { id: "proj-id", name: "My App", slug: "my-app" },
    }),
    api: {
      async deployments(_projectId) {
        return [
          {
            name: "wise-otter-1",
            deploymentType: "dev",
            status: "running",
            deploymentUrl: "https://synapsepanel.com/d/wise-otter-1",
            isDefault: true,
          },
          {
            name: "sharp-fox-2",
            deploymentType: "prod",
            status: "running",
            deploymentUrl: "https://synapsepanel.com:3215",
          },
        ];
      },
    },
  };
  await statusCmd.run([], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.projectId, "proj-id");
  assert.equal(parsed.deployments.length, 2);
  assert.equal(parsed.deployments[0].urlForm, "path");
  assert.equal(parsed.deployments[1].urlForm, "host");
});

// ---- open ----------------------------------------------------------

test("open: buildUrl maps each target to the right URL", () => {
  const projectConfig = {
    team: { slug: "amage" },
    project: { id: "abc-123" },
  };
  const cfg = { baseUrl: "https://synapsepanel.com" };
  assert.equal(
    openCmd.buildUrl(undefined, [], { cfg, projectConfig }),
    "https://synapsepanel.com/teams/amage/abc-123",
  );
  assert.equal(
    openCmd.buildUrl("dashboard", [], { cfg, projectConfig }),
    "https://synapsepanel.com/teams/amage/abc-123",
  );
  assert.equal(
    openCmd.buildUrl("docs", [], { cfg, projectConfig }),
    "https://docs.convex.dev",
  );
  assert.equal(
    openCmd.buildUrl("deployment", ["lush-otter-1"], { cfg, projectConfig }),
    "https://synapsepanel.com/embed/lush-otter-1",
  );
  assert.equal(openCmd.buildUrl("url", [], { cfg, projectConfig }), "https://synapsepanel.com");
});

test("open: missing deployment name throws helpfully", () => {
  assert.throws(
    () => openCmd.buildUrl("deployment", [], { cfg: { baseUrl: "x" } }),
    /synapse open deployment <name>/,
  );
});

test("open: unknown target throws with a hint list", () => {
  assert.throws(
    () => openCmd.buildUrl("invalid", [], { cfg: {} }),
    /Try: dashboard \| docs \| deployment <name> \| url/,
  );
});

test("open: dashboard fallback to /teams when no project linked", () => {
  assert.equal(
    openCmd.buildUrl("dashboard", [], { cfg: { baseUrl: "https://x" }, projectConfig: null }),
    "https://x/teams",
  );
});

test("open: launcher picks correct binary per platform", () => {
  assert.equal(openCmd.launcher("darwin").cmd, "open");
  assert.equal(openCmd.launcher("linux").cmd, "xdg-open");
  assert.equal(openCmd.launcher("win32").cmd, "start");
  assert.equal(openCmd.launcher("freebsd").cmd, "xdg-open");
});
