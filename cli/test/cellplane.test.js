// Bloco 5 — Cell Control Plane CLI commands. Stub ctx.api per-call; capture
// stdout/stderr via PassThrough (same pattern as v187-control-plane.test.js).

const assert = require("node:assert/strict");
const test = require("node:test");
const { PassThrough } = require("node:stream");

const { createOutput } = require("../lib/output");
const { SynapseAPI } = require("../lib/api");
const { buildRegistry } = require("../lib/commands/_dispatcher");
const { redactJson, resolveScope } = require("../lib/commands/_cellplane");

const hostsMod = require("../lib/commands/cellplane-hosts");
const cellsMod = require("../lib/commands/cellplane-cells");
const linksMod = require("../lib/commands/cellplane-links");
const topoMod = require("../lib/commands/cellplane-topology");
const stateMod = require("../lib/commands/cellplane-state");
const opsMod = require("../lib/commands/cellplane-operations");

function cmd(mod, name) {
  const arr = Array.isArray(mod) ? mod : mod.commands || [mod];
  const found = arr.find((c) => c.name === name);
  if (!found) throw new Error(`command not found: ${name}`);
  return found;
}

function capture(json = false) {
  const outBuf = [];
  const errBuf = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => outBuf.push(c.toString("utf8")));
  stderr.on("data", (c) => errBuf.push(c.toString("utf8")));
  return {
    out: createOutput({ json, stdout, stderr }),
    text: () => ({ stdout: outBuf.join(""), stderr: errBuf.join("") }),
  };
}

function makeCtx({ json = false, api = {}, projectConfig = null } = {}) {
  const cap = capture(json);
  return { cap, ctx: { out: cap.out, cwd: process.cwd(), api, projectConfig } };
}

// ---- API client: path + auth header + dry-run body --------------------

test("API: driftRecompute POSTs the scoped path with the bearer", async () => {
  const calls = [];
  const api = new SynapseAPI({
    baseUrl: "https://s.test",
    accessToken: "tok",
    fetchImpl: async (url, opts) => {
      calls.push({ url: url.toString(), method: opts.method, auth: opts.headers.Authorization, body: opts.body });
      return { ok: true, status: 200, json: async () => ({ report: null, items: [] }) };
    },
  });
  await api.driftRecompute("projects", "p1");
  assert.match(calls[0].url, /\/v1\/projects\/p1\/drift\/recompute$/);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].auth, "Bearer tok");
});

test("API: reconcileDryRun sends an empty body (never apply:true)", async () => {
  let sentBody = null;
  const api = new SynapseAPI({
    baseUrl: "https://s.test",
    accessToken: "tok",
    fetchImpl: async (_url, opts) => {
      sentBody = opts.body;
      return { ok: true, status: 200, json: async () => ({ operationRun: {}, steps: [] }) };
    },
  });
  await api.reconcileDryRun("hosts", "h1");
  assert.equal(sentBody, "{}");
  assert.ok(!/apply/i.test(sentBody), "dry-run body must not mention apply");
});

// ---- hosts ------------------------------------------------------------

test("hosts list renders rows + JSON count", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    api: { hostsList: async () => [{ id: "h1", name: "vps-br-1", effectiveStatus: "online", region: "br" }] },
  });
  await cmd(hostsMod, "hosts list").run([], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.kind, "hosts");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.hosts[0].name, "vps-br-1");
});

test("hosts adoption-token prints joinCommand + token ONCE", async () => {
  const { cap, ctx } = makeCtx({
    json: false,
    api: {
      hostAdoptionToken: async (id) => {
        assert.equal(id, "h1");
        return { token: "syn_adopt_SECRET", joinCommand: "synapse-agent join --token syn_adopt_SECRET", id: "t1", hostId: "h1" };
      },
    },
  });
  await cmd(hostsMod, "hosts adoption-token").run(["h1"], ctx);
  const out = cap.text().stdout;
  assert.match(out, /shown once/i);
  assert.match(out, /syn_adopt_SECRET/);
  assert.match(out, /synapse-agent join/);
});

test("hosts create sends name + labels + provider", async () => {
  let body = null;
  const { ctx } = makeCtx({
    json: true,
    api: { hostCreate: async (b) => { body = b; return { id: "h1", name: b.name }; } },
  });
  await cmd(hostsMod, "hosts create").run(
    ["--name", "vps-br-1", "--provider", "hostinger", "--region", "br", "--label", "tier=prod", "--label", "owner=ian"],
    ctx,
  );
  assert.equal(body.name, "vps-br-1");
  assert.equal(body.provider, "hostinger");
  assert.deepEqual(body.labels, { tier: "prod", owner: "ian" });
});

test("agents rotate-token prints the new token once", async () => {
  const { cap, ctx } = makeCtx({
    json: false,
    api: { agentRotateToken: async () => ({ id: "a1", hostId: "h1", agentToken: "syn_agent_NEW" }) },
  });
  await cmd(hostsMod, "agents rotate-token").run(["a1"], ctx);
  assert.match(cap.text().stdout, /syn_agent_NEW/);
  assert.match(cap.text().stdout, /shown once/i);
});

// ---- cells ------------------------------------------------------------

test("cells list uses --project and renders", async () => {
  let gotProject = null;
  const { cap, ctx } = makeCtx({
    json: true,
    api: { cellsList: async (pid) => { gotProject = pid; return [{ id: "c1", name: "core-prod-br-1", kind: "core", environment: "prod", status: "active" }]; } },
  });
  await cmd(cellsMod, "cells list").run(["--project=p1"], ctx);
  assert.equal(gotProject, "p1");
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.cells[0].name, "core-prod-br-1");
});

test("cells create maps --env to environment + validates --kind", async () => {
  let body = null;
  const { ctx } = makeCtx({
    json: true,
    api: { cellCreate: async (_pid, b) => { body = b; return { id: "c1", name: b.name, kind: b.kind, environment: b.environment }; } },
  });
  await cmd(cellsMod, "cells create").run(
    ["--project=p1", "--name", "runtime-prod-br-1", "--kind", "runtime", "--env", "prod", "--region", "br"],
    ctx,
  );
  assert.equal(body.environment, "prod");
  assert.equal(body.kind, "runtime");

  const { ctx: ctx2 } = makeCtx({ json: true, api: { cellCreate: async () => assert.fail() } });
  await assert.rejects(
    () => cmd(cellsMod, "cells create").run(["--project=p1", "--name", "x", "--kind", "bogus"], ctx2),
    /Invalid --kind/,
  );
});

test("cells attach-deployment calls the endpoint with both positionals", async () => {
  let called = null;
  const { ctx } = makeCtx({
    json: true,
    api: { cellAttachDeployment: async (cell, dep) => { called = { cell, dep }; return { cell: { name: "core" }, placement: {} }; } },
  });
  await cmd(cellsMod, "cells attach-deployment").run(["c1", "lush-heron-4656"], ctx);
  assert.deepEqual(called, { cell: "c1", dep: "lush-heron-4656" });
});

// ---- cell links + service tokens -------------------------------------

test("cell-links create sends allowedCommands/allowedEvents + from/to", async () => {
  let body = null;
  const { ctx } = makeCtx({
    json: true,
    api: { cellLinkCreate: async (_pid, b) => { body = b; return { id: "l1", protocol: b.protocol, authMode: b.authMode }; } },
  });
  await cmd(linksMod, "cell-links create").run(
    ["--project=p1", "--from", "c-core", "--to", "c-runtime", "--protocol", "outbox", "--auth", "service_token",
     "--allow-command", "runtime.runAutomation", "--allow-event", "runtime.runCompleted"],
    ctx,
  );
  assert.equal(body.sourceCellId, "c-core");
  assert.equal(body.targetCellId, "c-runtime");
  assert.equal(body.protocol, "outbox");
  assert.equal(body.authMode, "service_token");
  assert.deepEqual(body.allowedCommands, ["runtime.runAutomation"]);
  assert.deepEqual(body.allowedEvents, ["runtime.runCompleted"]);
});

test("service-tokens create prints the token once; list never shows a token", async () => {
  const { cap, ctx } = makeCtx({
    json: false,
    api: { serviceTokenCreate: async (linkId, b) => { assert.equal(linkId, "l1"); return { id: "t1", token: "syn_svc_ONCE", scopes: b.scopes || ["discovery:read"] }; } },
  });
  await cmd(linksMod, "service-tokens create").run(["l1", "--name", "core->runtime", "--scope", "discovery:read"], ctx);
  assert.match(cap.text().stdout, /syn_svc_ONCE/);
  assert.match(cap.text().stdout, /shown once/i);

  // list returns metadata only (backend never sends the plaintext/hash).
  const { cap: cap2, ctx: ctx2 } = makeCtx({
    json: true,
    api: { serviceTokensList: async () => [{ id: "t1", name: "core->runtime", status: "active", effectiveStatus: "active", scopes: ["discovery:read"] }] },
  });
  await cmd(linksMod, "service-tokens list").run(["l1"], ctx2);
  const parsed = JSON.parse(cap2.text().stdout);
  assert.equal(parsed.serviceTokens[0].id, "t1");
  assert.ok(!("token" in parsed.serviceTokens[0]), "list must not include a token");
});

// ---- topology ---------------------------------------------------------

test("topology show renders Host -> Cell -> Deployment + warnings", async () => {
  const topo = {
    mode: "cell_control_plane",
    project: { id: "p1", name: "amagejumpy" },
    hosts: [{ id: "h1", name: "vps-br-1", effectiveStatus: "online" }],
    cells: [{ id: "c1", name: "core-prod-br-1", kind: "core", environment: "prod", status: "active", primaryHostId: "h1",
              deployments: [{ id: "d1", name: "lush-heron-4656", status: "running" }],
              outgoingLinks: [{ id: "l1", targetCellId: "c2", protocol: "outbox" }] }],
    unassignedDeployments: [],
    links: [],
    warnings: ["Cell runtime has no primary deployment"],
  };
  const { cap, ctx } = makeCtx({ json: false, api: { cellTopology: async () => topo } });
  await cmd(topoMod, "topology show").run(["--project=p1"], ctx);
  const out = cap.text().stdout;
  assert.match(out, /Project amagejumpy/);
  assert.match(out, /vps-br-1/);
  assert.match(out, /core-prod-br-1/);
  assert.match(out, /lush-heron-4656/);
  assert.match(out, /Warnings \(1\)/);
});

// ---- drift / dry-run --------------------------------------------------

test("drift latest renders summary + items (JSON)", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    api: {
      driftLatest: async (scope, id) => {
        assert.equal(scope, "projects");
        assert.equal(id, "p1");
        return {
          report: { id: "r1", status: "drifted", summary: { total: 2, missing: 1, drifted: 1, critical: 2 } },
          items: [
            { id: "i1", resourceKey: "convex_deployment:dep-a", driftStatus: "missing", severity: "critical", recommendedAction: "create", diff: { reason: "no container" } },
          ],
        };
      },
    },
  });
  await cmd(stateMod, "drift latest").run(["--project=p1"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.report.status, "drifted");
  assert.equal(parsed.items[0].driftStatus, "missing");
});

test("reconcile dry-run renders applyAllowed=false + willApply=false; no apply mutation", async () => {
  let called = false;
  const { cap, ctx } = makeCtx({
    json: false,
    api: {
      reconcileDryRun: async (scope, id) => {
        called = true;
        assert.equal(scope, "hosts");
        assert.equal(id, "h1");
        return {
          operationRun: { id: "run1", type: "reconcile_dry_run", status: "succeeded", plan: { mode: "dry-run", applyAllowed: false, summary: { planned: 1, dangerous: 1 } } },
          steps: [{ action: "remove", resourceType: "convex_deployment", resourceKey: "convex_deployment:dep-d", status: "planned", reason: "removal not implemented", willApply: false }],
        };
      },
    },
  });
  await cmd(stateMod, "reconcile dry-run").run(["--host=h1"], ctx);
  assert.equal(called, true);
  const out = cap.text().stdout;
  assert.match(out, /DRY-RUN ONLY/);
  assert.match(out, /applyAllowed=false/);
  assert.match(out, /would remove/);
  assert.match(out, /dangerous/);
});

test("reconcile dry-run --apply is rejected; there is no apply command", async () => {
  const { ctx } = makeCtx({ json: true, api: { reconcileDryRun: async () => assert.fail("must not call") } });
  await assert.rejects(
    () => cmd(stateMod, "reconcile dry-run").run(["--host=h1", "--apply"], ctx),
    /apply is not implemented/,
  );
  // No apply-style command is registered anywhere.
  const reg = buildRegistry();
  for (const name of reg.keys()) {
    assert.ok(!/\bapply\b/.test(name), `registry must not contain an apply command (found ${name})`);
  }
  assert.ok(!reg.has("reconcile apply"));
});

// ---- redaction --------------------------------------------------------

test("redactJson scrubs token/secret/password/key/env/admin/instance/database", () => {
  const out = redactJson({
    token: "t", secret: "s", password: "p", adminKey: "k", instanceSecret: "i",
    databaseUrl: "d", env: { X: 1 }, nested: { apiToken: "z", safe: "ok" }, keep: "value",
  });
  for (const k of ["token", "secret", "password", "adminKey", "instanceSecret", "databaseUrl", "env"]) {
    assert.equal(out[k], "[redacted]", `${k} should be redacted`);
  }
  assert.equal(out.nested.apiToken, "[redacted]");
  assert.equal(out.nested.safe, "ok");
  assert.equal(out.keep, "value");
});

test("drift items diffs are redacted before output", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    api: {
      driftLatest: async () => ({
        report: { id: "r1", status: "warning", summary: {} },
        items: [{ id: "i1", resourceKey: "x", driftStatus: "drifted", severity: "warning", recommendedAction: "investigate",
                  diff: { reason: "ok", adminKey: "LEAK", token: "LEAK2" } }],
      }),
    },
  });
  await cmd(stateMod, "drift latest").run(["--cell=c1"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.items[0].diff.reason, "ok");
  assert.equal(parsed.items[0].diff.adminKey, "[redacted]");
  assert.equal(parsed.items[0].diff.token, "[redacted]");
});

test("operations show redacts input/plan/result", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    api: {
      operationRunGet: async () => ({
        operationRun: { id: "run1", type: "reconcile_dry_run", status: "succeeded",
                        input: { password: "p" }, plan: { applyAllowed: false, secret: "s" }, result: {} },
        steps: [],
      }),
    },
  });
  await cmd(opsMod, "operations show").run(["run1"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.operationRun.input.password, "[redacted]");
  assert.equal(parsed.operationRun.plan.secret, "[redacted]");
  assert.equal(parsed.operationRun.plan.applyAllowed, false);
});

// ---- resolveScope -----------------------------------------------------

test("resolveScope: exactly one of host/cell/project; multiple errors", () => {
  assert.deepEqual(
    resolveScope({ projectConfig: null }, ["--host=h1"]),
    { scope: "hosts", id: "h1", source: "flag", rest: [] },
  );
  assert.deepEqual(
    resolveScope({ projectConfig: null }, ["--cell", "c1"]),
    { scope: "cells", id: "c1", source: "flag", rest: [] },
  );
  assert.throws(() => resolveScope({ projectConfig: null }, ["--host=h1", "--cell=c1"]), /only one of/);
  assert.throws(() => resolveScope({ projectConfig: null }, []), /Specify a scope/);
  // Linked project fallback.
  assert.deepEqual(
    resolveScope({ projectConfig: { project: { id: "p9" } } }, []),
    { scope: "projects", id: "p9", source: "linked", rest: [] },
  );
});
