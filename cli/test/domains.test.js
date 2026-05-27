// `synapse domains *` — covers list rendering, --role validation, the
// 5 request shapes that hit the per-deployment endpoints, and one
// SynapseAPI round-trip to prove the URL + auth header land correctly.

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const { createOutput } = require("../lib/output");
const { SynapseAPI } = require("../lib/api");
const domains = require("../lib/commands/domains");

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

function makeCtx({ json = false, api = {} } = {}) {
  const cap = capture(json);
  return { cap, ctx: { out: cap.out, cwd: process.cwd(), api, projectConfig: null } };
}

// ---- API client wiring -------------------------------------------------

test("API: deploymentDomainsList unwraps the { domains: [...] } envelope", async () => {
  const calls = [];
  const api = new SynapseAPI({
    baseUrl: "https://s.test",
    accessToken: "tok",
    fetchImpl: async (url, opts) => {
      calls.push({ url: url.toString(), method: opts.method, auth: opts.headers.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({ domains: [{ id: "d1", domain: "api.example.com", role: "api", status: "active" }] }),
      };
    },
  });
  const rows = await api.deploymentDomainsList("brave-dolphin-1060");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, "api.example.com");
  assert.match(calls[0].url, /\/v1\/deployments\/brave-dolphin-1060\/domains$/);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].auth, "Bearer tok");
});

test("API: deploymentDomainDelete sends DELETE and tolerates a 204", async () => {
  let captured = null;
  const api = new SynapseAPI({
    baseUrl: "https://s.test",
    accessToken: "tok",
    fetchImpl: async (url, opts) => {
      captured = { url: url.toString(), method: opts.method };
      return { ok: true, status: 204, json: async () => { throw new Error("no body"); } };
    },
  });
  const res = await api.deploymentDomainDelete("dep-1", "d1");
  assert.equal(res, null);
  assert.equal(captured.method, "DELETE");
  assert.match(captured.url, /\/v1\/deployments\/dep-1\/domains\/d1$/);
});

// ---- domains list ------------------------------------------------------

test("domains list calls deploymentDomainsList and renders table rows", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    api: {
      deploymentDomainsList: async (name) => {
        assert.equal(name, "dep-1");
        return [
          { id: "d1", domain: "api.example.com", role: "api", status: "active" },
          { id: "d2", domain: "actions.example.com", role: "site", status: "pending" },
        ];
      },
    },
  });
  await cmd(domains, "domains list").run(["dep-1"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.kind, "domains");
  assert.equal(parsed.count, 2);
  assert.equal(parsed.deployment, "dep-1");
  assert.equal(parsed.domains[1].role, "site");
});

test("domains list requires a deployment positional", async () => {
  const { ctx } = makeCtx({ api: { deploymentDomainsList: async () => [] } });
  await assert.rejects(
    () => cmd(domains, "domains list").run([], ctx),
    /Missing <deployment>/,
  );
});

// ---- domains add -------------------------------------------------------

test("domains add validates --role against api|site|dashboard", async () => {
  const { ctx } = makeCtx({ api: { deploymentDomainCreate: async () => ({}) } });
  await assert.rejects(
    () => cmd(domains, "domains add").run(
      ["dep-1", "--domain=api.example.com", "--role=bogus"],
      ctx,
    ),
    /Invalid --role: bogus/,
  );
});

test("domains add posts { domain, role } to the backend", async () => {
  let captured = null;
  const { cap, ctx } = makeCtx({
    json: false,
    api: {
      deploymentDomainCreate: async (name, body) => {
        captured = { name, body };
        return { id: "d1", domain: body.domain, role: body.role, status: "pending" };
      },
    },
  });
  await cmd(domains, "domains add").run(
    ["dep-1", "--domain=api.example.com", "--role=api"],
    ctx,
  );
  assert.equal(captured.name, "dep-1");
  assert.deepEqual(captured.body, { domain: "api.example.com", role: "api" });
  const out = cap.text().stdout;
  assert.match(out, /Added domain/);
  assert.match(out, /api\.example\.com/);
  assert.match(out, /synapse domains verify/);
});

test("domains add accepts --role=site (for HTTP actions)", async () => {
  let body = null;
  const { ctx } = makeCtx({
    api: {
      deploymentDomainCreate: async (_n, b) => { body = b; return { id: "d1", ...b, status: "pending" }; },
    },
  });
  await cmd(domains, "domains add").run(
    ["dep-1", "--domain=actions.example.com", "--role=site"],
    ctx,
  );
  assert.equal(body.role, "site");
});

// ---- domains verify ----------------------------------------------------

test("domains verify calls deploymentDomainVerify with the deployment + id", async () => {
  let captured = null;
  const { cap, ctx } = makeCtx({
    json: true,
    api: {
      deploymentDomainVerify: async (name, id) => {
        captured = { name, id };
        return { id, domain: "api.example.com", status: "active", deploymentRestartTriggered: true };
      },
    },
  });
  await cmd(domains, "domains verify").run(
    ["dep-1", "--domain-id=d1"],
    ctx,
  );
  assert.deepEqual(captured, { name: "dep-1", id: "d1" });
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.status, "active");
});

// ---- domains delete ----------------------------------------------------

test("domains delete sends through deploymentDomainDelete", async () => {
  let captured = null;
  const { cap, ctx } = makeCtx({
    json: false,
    api: {
      deploymentDomainDelete: async (name, id) => {
        captured = { name, id };
        return null;
      },
    },
  });
  await cmd(domains, "domains delete").run(
    ["dep-1", "--domain-id=d1"],
    ctx,
  );
  assert.deepEqual(captured, { name: "dep-1", id: "d1" });
  assert.match(cap.text().stdout, /Deleted/);
});

// ---- domains auto-configure -------------------------------------------

test("domains auto-configure routes to deploymentDomainAutoConfigure", async () => {
  let captured = null;
  const { cap, ctx } = makeCtx({
    json: true,
    api: {
      deploymentDomainAutoConfigure: async (name, id) => {
        captured = { name, id };
        return { success: true, domain: "api.example.com", zone: "example.com" };
      },
    },
  });
  await cmd(domains, "domains auto-configure").run(
    ["dep-1", "--domain-id=d1"],
    ctx,
  );
  assert.deepEqual(captured, { name: "dep-1", id: "d1" });
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.success, true);
  assert.equal(parsed.zone, "example.com");
});
