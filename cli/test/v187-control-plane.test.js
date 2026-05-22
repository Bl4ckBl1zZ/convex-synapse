// v1.8.7 control-plane commands — unit tests for the 6 new commands:
//   list, deployment create/delete/status/rotate-key, env list/set/unset/pull/push
//
// Strategy: stub ctx.api with a method-per-call so we don't hit a
// real backend. Capture stdout/stderr via the same PassThrough
// pattern the other test files use.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { PassThrough } = require("node:stream");

const { createOutput } = require("../lib/output");
const listCmd = require("../lib/commands/list");
const deploymentCreateCmd = require("../lib/commands/deployment-create");
const deploymentDeleteCmd = require("../lib/commands/deployment-delete");
const deploymentStatusCmd = require("../lib/commands/deployment-status");
const deploymentRotateKeyCmd = require("../lib/commands/deployment-rotate-key");
const envListCmd = require("../lib/commands/env-list");
const envSetCmd = require("../lib/commands/env-set");
const envUnsetCmd = require("../lib/commands/env-unset");
const envPullCmd = require("../lib/commands/env-pull");
const envPushCmd = require("../lib/commands/env-push");
const { SynapseAPIError } = require("../lib/api");
const { extractFlags, extractProjectFlag, extractTeamFlag } = require("../lib/commands/_resource");

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

function makeCtx({ json = false, api = {}, projectConfig = null, cwd = process.cwd() } = {}) {
  const cap = capture(json);
  return {
    cap,
    ctx: {
      out: cap.out,
      cwd,
      api,
      projectConfig,
    },
  };
}

// ---- _resource flag parsing ------------------------------------------

test("extractFlags with {string,boolean} spec: booleans never consume next token", () => {
  const { flags, rest } = extractFlags(
    ["--type=prod", "--ha", "--default", "value-stays", "--project", "abc"],
    { string: ["type", "project"], boolean: ["ha", "default"] },
  );
  assert.equal(flags.type, "prod");
  assert.equal(flags.ha, true);
  assert.equal(flags.default, true);
  assert.equal(flags.project, "abc");
  assert.deepEqual(rest, ["value-stays"]);
});

test("extractFlags with legacy array spec: every flag treated as string-or-true", () => {
  const { flags, rest } = extractFlags(
    ["--type=prod", "--ha", "--project", "abc"],
    ["type", "ha", "project"],
  );
  assert.equal(flags.type, "prod");
  // Legacy behaviour: --ha followed by --project consumes nothing (next is a flag).
  assert.equal(flags.ha, true);
  assert.equal(flags.project, "abc");
  assert.deepEqual(rest, []);
});

test("extractFlags --boolean=value form is still accepted (value carried verbatim)", () => {
  const { flags } = extractFlags(["--watch=5"], { boolean: ["watch"] });
  assert.equal(flags.watch, "5");
});

test("extractFlags leaves unknown flags in rest", () => {
  const { flags, rest } = extractFlags(["--type=dev", "--foo=bar"], { string: ["type"] });
  assert.equal(flags.type, "dev");
  assert.deepEqual(rest, ["--foo=bar"]);
});

test("extractProjectFlag + extractTeamFlag", () => {
  assert.deepEqual(extractProjectFlag(["--project=abc"]), { projectId: "abc", rest: [] });
  assert.deepEqual(extractProjectFlag(["--project", "abc"]), { projectId: "abc", rest: [] });
  assert.deepEqual(extractTeamFlag(["--team=t1"]), { teamRef: "t1", rest: [] });
});

// ---- list ------------------------------------------------------------

test("list teams: emits the team rows and count in JSON mode", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    api: {
      teams: async () => [
        { id: "t1", slug: "amage", name: "amage.ia" },
        { id: "t2", slug: "tests", name: "Tests" },
      ],
    },
  });
  await listCmd.run(["teams"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.kind, "teams");
  assert.equal(parsed.count, 2);
  assert.equal(parsed.teams[0].slug, "amage");
});

test("list projects with linked team uses ctx.projectConfig.team", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    projectConfig: { team: { slug: "amage" }, project: { id: "p1" } },
    api: {
      projects: async (ref) => {
        assert.equal(ref, "amage");
        return [{ id: "p1", slug: "demo", name: "Demo" }];
      },
    },
  });
  await listCmd.run(["projects"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.team, "amage");
  assert.equal(parsed.teamSource, "linked");
  assert.equal(parsed.count, 1);
});

test("list deployments without linked or --project errors clearly", async () => {
  const { ctx } = makeCtx({ json: true, api: { deployments: async () => [] } });
  await assert.rejects(
    () => listCmd.run(["deployments"], ctx),
    /No linked project/,
  );
});

test("list rejects unknown kinds with the option list", async () => {
  const { ctx } = makeCtx();
  await assert.rejects(
    () => listCmd.run(["foobar"], ctx),
    /Unknown list kind.*deployments \| projects \| teams/,
  );
});

// ---- deployment create -----------------------------------------------

test("deployment create with --type=dev fires without confirmation", async () => {
  let called = null;
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      createDeployment: async (projectId, body) => {
        called = { projectId, body };
        return { name: "brave-otter-1", deploymentType: "dev", status: "provisioning" };
      },
    },
  });
  await deploymentCreateCmd.run(["--type=dev"], ctx);
  assert.equal(called.projectId, "p1");
  assert.deepEqual(called.body, { type: "dev" });
});

test("deployment create with --type=prod refuses --json without --yes", async () => {
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: { createDeployment: async () => assert.fail("should not call") },
  });
  await assert.rejects(
    () => deploymentCreateCmd.run(["--type=prod"], ctx),
    /Refusing to create a prod deployment.*--yes/,
  );
});

test("deployment create --type=prod --yes flows through in JSON mode", async () => {
  let body;
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      createDeployment: async (_pid, b) => {
        body = b;
        return { name: "wise-fox-1", deploymentType: "prod" };
      },
    },
  });
  await deploymentCreateCmd.run(["--type=prod", "--yes"], ctx);
  assert.equal(body.type, "prod");
});

test("deployment create + --ha sets ha:true in the body", async () => {
  let body;
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      createDeployment: async (_pid, b) => {
        body = b;
        return { name: "x", deploymentType: "dev" };
      },
    },
  });
  await deploymentCreateCmd.run(["--ha"], ctx);
  assert.equal(body.ha, true);
});

test("deployment create rejects invalid --type", async () => {
  const { ctx } = makeCtx({
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: { createDeployment: async () => assert.fail() },
  });
  await assert.rejects(
    () => deploymentCreateCmd.run(["--type=staging"], ctx),
    /Invalid --type/,
  );
});

// ---- deployment delete -----------------------------------------------

test("deployment delete on prod refuses --json without --confirm", async () => {
  const { ctx } = makeCtx({
    json: true,
    api: {
      getDeployment: async () => ({ name: "wise-otter-1", deploymentType: "prod" }),
      deleteDeployment: async () => assert.fail("should not call"),
    },
  });
  await assert.rejects(
    () => deploymentDeleteCmd.run(["wise-otter-1"], ctx),
    /Refusing to delete prod.*--confirm=wise-otter-1/,
  );
});

test("deployment delete on prod with matching --confirm proceeds", async () => {
  let deletedName = null;
  const { ctx } = makeCtx({
    json: true,
    api: {
      getDeployment: async (n) => ({ name: n, deploymentType: "prod" }),
      deleteDeployment: async (n) => {
        deletedName = n;
      },
    },
  });
  await deploymentDeleteCmd.run(["wise-otter-1", "--confirm=wise-otter-1"], ctx);
  assert.equal(deletedName, "wise-otter-1");
});

test("deployment delete with --confirm mismatch aborts", async () => {
  const { ctx } = makeCtx({
    json: true,
    api: {
      getDeployment: async (n) => ({ name: n, deploymentType: "prod" }),
      deleteDeployment: async () => assert.fail("should not call"),
    },
  });
  await deploymentDeleteCmd.run(["wise-otter-1", "--confirm=WRONG"], ctx);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0; // reset
});

test("deployment delete 404 surfaces a clear 'not found' message", async () => {
  const { ctx } = makeCtx({
    json: true,
    api: {
      getDeployment: async () => {
        throw new SynapseAPIError(404, "deployment_not_found", "not found");
      },
    },
  });
  await assert.rejects(
    () => deploymentDeleteCmd.run(["nope"], ctx),
    /not found.*synapse list deployments/,
  );
});

// ---- deployment status -----------------------------------------------

test("deployment status returns the snapshot in JSON mode", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    api: {
      getDeployment: async () => ({
        name: "brave-dolphin-1060",
        deploymentType: "dev",
        status: "running",
        deploymentUrl: "https://brave-dolphin-1060.example.com",
      }),
      getDeploymentBackendVersion: async () => ({ version: "1.39.1" }),
    },
  });
  await deploymentStatusCmd.run(["brave-dolphin-1060"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.dep.name, "brave-dolphin-1060");
  assert.equal(parsed.backendVersion, "1.39.1");
});

test("deployment status --watch is incompatible with --json", async () => {
  const { ctx } = makeCtx({ json: true, api: {} });
  await assert.rejects(
    () => deploymentStatusCmd.run(["x", "--watch"], ctx),
    /--watch is incompatible with --json/,
  );
});

test("deployment status 404 surfaces a clear error", async () => {
  const { ctx } = makeCtx({
    json: true,
    api: {
      getDeployment: async () => {
        throw new SynapseAPIError(404, "deployment_not_found", "not found");
      },
    },
  });
  await assert.rejects(
    () => deploymentStatusCmd.run(["nope"], ctx),
    /not found/,
  );
});

// ---- deployment rotate-key -------------------------------------------

test("rotate-key on adopted deployment refuses with a clear error", async () => {
  const { ctx } = makeCtx({
    json: true,
    api: {
      getDeployment: async () => ({
        name: "external-1",
        deploymentType: "prod",
        adopted: true,
      }),
      reissueAdminKey: async () => assert.fail("should not call"),
    },
  });
  await assert.rejects(
    () => deploymentRotateKeyCmd.run(["external-1", "--confirm=external-1"], ctx),
    /adopted.*re-adopt/,
  );
});

test("rotate-key on prod requires --confirm in --json mode", async () => {
  const { ctx } = makeCtx({
    json: true,
    api: {
      getDeployment: async () => ({ name: "wise-otter-1", deploymentType: "prod" }),
      reissueAdminKey: async () => assert.fail("should not call"),
    },
  });
  await assert.rejects(
    () => deploymentRotateKeyCmd.run(["wise-otter-1"], ctx),
    /Refusing to rotate prod key.*--confirm=wise-otter-1/,
  );
});

test("rotate-key happy path returns the new key + prefix", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    api: {
      getDeployment: async () => ({ name: "brave-dolphin-1060", deploymentType: "dev" }),
      reissueAdminKey: async () => ({
        deploymentName: "brave-dolphin-1060",
        adminKey: "brave-dolphin-1060|NEWNEWNEW",
        prefix: "brave-do",
      }),
    },
  });
  await deploymentRotateKeyCmd.run(["brave-dolphin-1060", "--yes"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.rotated, true);
  assert.equal(parsed.adminKey, "brave-dolphin-1060|NEWNEWNEW");
  assert.equal(parsed.prefix, "brave-do");
});

// ---- env list --------------------------------------------------------

test("env list returns sorted configs; --mask redacts values", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      listProjectEnvVars: async () => ({
        configs: [
          { name: "BAR", value: "v2", deploymentTypes: ["dev"] },
          { name: "AAA", value: "secret", deploymentTypes: ["dev", "prod"] },
        ],
      }),
    },
  });
  await envListCmd.run(["--mask"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.configs[0].name, "AAA"); // sorted
  assert.equal(parsed.configs[0].value, "******"); // 6 chars, all *
  assert.equal(parsed.masked, true);
});

test("env list --for=prod filters by deploymentTypes", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      listProjectEnvVars: async () => ({
        configs: [
          { name: "DEV_ONLY", value: "x", deploymentTypes: ["dev"] },
          { name: "PROD_ONLY", value: "y", deploymentTypes: ["prod"] },
        ],
      }),
    },
  });
  await envListCmd.run(["--for=prod"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.configs[0].name, "PROD_ONLY");
});

// ---- env set ---------------------------------------------------------

test("env set parses NAME=value pairs and sends a batch", async () => {
  let sent;
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      updateProjectEnvVars: async (pid, changes) => {
        sent = { pid, changes };
      },
    },
  });
  await envSetCmd.run(["FOO=bar", "BAZ=qux=with=equals"], ctx);
  assert.equal(sent.pid, "p1");
  assert.equal(sent.changes.length, 2);
  assert.deepEqual(sent.changes[0], { op: "set", name: "FOO", value: "bar" });
  assert.deepEqual(sent.changes[1], { op: "set", name: "BAZ", value: "qux=with=equals" });
});

test("env set --for=dev,prod stamps deploymentTypes on each change", async () => {
  let sent;
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      updateProjectEnvVars: async (_pid, changes) => {
        sent = changes;
      },
    },
  });
  await envSetCmd.run(["FOO=bar", "--for=dev,prod"], ctx);
  assert.deepEqual(sent[0].deploymentTypes, ["dev", "prod"]);
});

test("env set rejects malformed pairs and invalid names", () => {
  assert.throws(() => envSetCmd.parsePair("="), /Invalid env assignment/);
  assert.throws(() => envSetCmd.parsePair("noeq"), /Invalid env assignment/);
  assert.throws(() => envSetCmd.parsePair("lower=ok"), /Invalid env name/);
  assert.throws(() => envSetCmd.parsePair("1FOO=x"), /Invalid env name/);
});

test("env set --for=staging is rejected with the valid list", () => {
  assert.throws(() => envSetCmd.parseFor("staging,dev"), /Invalid --for entry: staging/);
});

// ---- env unset -------------------------------------------------------

test("env unset sends op=delete for each name", async () => {
  let sent;
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      updateProjectEnvVars: async (_pid, changes) => {
        sent = changes;
      },
    },
  });
  await envUnsetCmd.run(["FOO", "BAR"], ctx);
  assert.deepEqual(sent, [
    { op: "delete", name: "FOO" },
    { op: "delete", name: "BAR" },
  ]);
});

test("env unset validates name shape", async () => {
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: { updateProjectEnvVars: async () => assert.fail() },
  });
  await assert.rejects(() => envUnsetCmd.run(["lower"], ctx), /Invalid env name/);
});

// ---- env pull --------------------------------------------------------

test("env pull formats as .env text with header + sorted names", async () => {
  const { cap, ctx } = makeCtx({
    json: false,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      listProjectEnvVars: async () => ({
        configs: [
          { name: "BBB", value: "two", deploymentTypes: ["dev"] },
          { name: "AAA", value: "one", deploymentTypes: ["dev"] },
        ],
      }),
    },
  });
  await envPullCmd.run([], ctx);
  const out = cap.text().stdout;
  assert.match(out, /^# Synapse-managed project-default env vars$/m);
  // AAA before BBB (sorted).
  const aIdx = out.indexOf("AAA=");
  const bIdx = out.indexOf("BBB=");
  assert.ok(aIdx >= 0 && bIdx > aIdx, "AAA must come before BBB");
});

test("env pull --out=<path> writes file with mode 0600", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-pull-"));
  const out = path.join(tmp, "envfile");
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      listProjectEnvVars: async () => ({
        configs: [{ name: "AAA", value: "x", deploymentTypes: ["dev"] }],
      }),
    },
  });
  try {
    await envPullCmd.run([`--out=${out}`], ctx);
    assert.ok(fs.existsSync(out));
    if (process.platform !== "win32") {
      const mode = fs.statSync(out).mode & 0o777;
      assert.equal(mode, 0o600);
    }
    assert.match(fs.readFileSync(out, "utf8"), /AAA="x"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- env push --------------------------------------------------------

test("env push --dry-run shows the diff and does NOT call updateProjectEnvVars", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-push-"));
  const file = path.join(tmp, ".env");
  fs.writeFileSync(file, "NEW_KEY=newvalue\nEXISTING=changed\n");
  let updateCalled = false;
  const { cap, ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      listProjectEnvVars: async () => ({
        configs: [{ name: "EXISTING", value: "old", deploymentTypes: ["dev"] }],
      }),
      updateProjectEnvVars: async () => {
        updateCalled = true;
      },
    },
  });
  try {
    await envPushCmd.run([`--from=${file}`, "--dry-run"], ctx);
    assert.equal(updateCalled, false);
    const parsed = JSON.parse(cap.text().stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.added.length, 1);
    assert.equal(parsed.changed.length, 1);
    assert.equal(parsed.added[0].name, "NEW_KEY");
    assert.equal(parsed.changed[0].name, "EXISTING");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("env push refuses CONVEX_SELF_HOSTED_* (deny list)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-push-"));
  const file = path.join(tmp, ".env");
  fs.writeFileSync(file, "OK_VAR=ok\nCONVEX_SELF_HOSTED_ADMIN_KEY=leak\n");
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      listProjectEnvVars: async () => ({ configs: [] }),
      updateProjectEnvVars: async () => assert.fail("should not call"),
    },
  });
  try {
    await assert.rejects(
      () => envPushCmd.run([`--from=${file}`, "--yes"], ctx),
      /Refusing to push.*CONVEX_SELF_HOSTED_ADMIN_KEY/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("env push refuses non-existent file with a clear error", async () => {
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: { listProjectEnvVars: async () => ({ configs: [] }) },
  });
  await assert.rejects(
    () => envPushCmd.run(["--from=/nonexistent/.env"], ctx),
    /File not found.*synapse env pull/,
  );
});

test("env push diffEnv classifies added vs changed vs unchanged", () => {
  const current = [
    { name: "SAME", value: "v" },
    { name: "CHANGE_ME", value: "old" },
  ];
  const parsed = { SAME: "v", CHANGE_ME: "new", NEW_KEY: "x" };
  const diff = envPushCmd.diffEnv(current, parsed);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].name, "NEW_KEY");
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].name, "CHANGE_ME");
  assert.equal(diff.changed[0].from, "old");
  assert.equal(diff.unchanged.length, 1);
});

test("env push --yes happy path posts changes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-push-"));
  const file = path.join(tmp, ".env");
  fs.writeFileSync(file, "FOO=bar\n");
  let sent;
  const { ctx } = makeCtx({
    json: true,
    projectConfig: { project: { id: "p1" }, team: { slug: "t" } },
    api: {
      listProjectEnvVars: async () => ({ configs: [] }),
      updateProjectEnvVars: async (_pid, changes) => {
        sent = changes;
      },
    },
  });
  try {
    await envPushCmd.run([`--from=${file}`, "--yes"], ctx);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { op: "set", name: "FOO", value: "bar" });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
