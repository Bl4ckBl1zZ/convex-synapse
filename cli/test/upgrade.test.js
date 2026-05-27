// `synapse upgrade *` — check (with + without --refresh), run (TTY
// guards, --ref body, 503 surfacing), status (jobId query string).
// Confirmation gates: --yes bypasses the prompt; non-TTY without
// --yes hard-refuses; --json without --yes hard-refuses too.

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const { createOutput } = require("../lib/output");
const { SynapseAPI, SynapseAPIError } = require("../lib/api");
const upgrade = require("../lib/commands/upgrade");

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

function makeCtx({ json = false, api = {}, stdin } = {}) {
  const cap = capture(json);
  return {
    cap,
    ctx: {
      out: cap.out,
      cwd: process.cwd(),
      api,
      projectConfig: null,
      stdin: stdin || { isTTY: false },
    },
  };
}

// ---- API client wiring -------------------------------------------------

test("API: adminVersionCheck hits GET /version_check; --refresh swaps to POST /refresh", async () => {
  const calls = [];
  const api = new SynapseAPI({
    baseUrl: "https://s.test",
    accessToken: "tok",
    fetchImpl: async (url, opts) => {
      calls.push({ url: url.toString(), method: opts.method });
      return { ok: true, status: 200, json: async () => ({ current: "1.0.0" }) };
    },
  });
  await api.adminVersionCheck();
  await api.adminVersionCheck({ refresh: true });
  assert.match(calls[0].url, /\/v1\/admin\/version_check$/);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[1].url, /\/v1\/admin\/version_check\/refresh$/);
  assert.equal(calls[1].method, "POST");
});

test("API: adminUpgradeStatus encodes jobId into the query string", async () => {
  let captured = null;
  const api = new SynapseAPI({
    baseUrl: "https://s.test",
    accessToken: "tok",
    fetchImpl: async (url, opts) => {
      captured = { url: url.toString(), method: opts.method };
      return { ok: true, status: 200, json: async () => ({ state: "running" }) };
    },
  });
  await api.adminUpgradeStatus("job-abc");
  assert.equal(captured.method, "GET");
  assert.match(captured.url, /\/v1\/admin\/upgrade\/status\?jobId=job-abc$/);
});

// ---- upgrade check -----------------------------------------------------

test("upgrade check (no flag) renders 'Up to date' when no newer release", async () => {
  const { cap, ctx } = makeCtx({
    json: false,
    api: {
      adminVersionCheck: async (opts) => {
        assert.equal(opts.refresh, false);
        return { current: "1.0.0", latest: "1.0.0", updateAvailable: false, fromCache: true };
      },
    },
  });
  await cmd(upgrade, "upgrade check").run([], ctx);
  assert.match(cap.text().stdout, /Up to date/);
});

test("upgrade check --refresh forwards refresh:true to the API", async () => {
  let opts = null;
  const { ctx } = makeCtx({
    json: true,
    api: {
      adminVersionCheck: async (o) => {
        opts = o;
        return { current: "1.0.0", latest: "1.1.0", updateAvailable: true };
      },
    },
  });
  await cmd(upgrade, "upgrade check").run(["--refresh"], ctx);
  assert.equal(opts.refresh, true);
});

test("upgrade check shows the 'Update available' affordance when newer", async () => {
  const { cap, ctx } = makeCtx({
    json: false,
    api: {
      adminVersionCheck: async () => ({
        current: "1.0.0",
        latest: "1.1.0",
        updateAvailable: true,
        releaseUrl: "https://github.com/x/y/releases/v1.1.0",
      }),
    },
  });
  await cmd(upgrade, "upgrade check").run([], ctx);
  const out = cap.text().stdout;
  assert.match(out, /Update available/);
  assert.match(out, /1\.1\.0/);
  assert.match(out, /upgrade run --yes/);
});

// ---- upgrade run -------------------------------------------------------

test("upgrade run refuses in non-TTY contexts without --yes", async () => {
  const { ctx } = makeCtx({
    api: { adminUpgrade: async () => ({ started: true }) },
    stdin: { isTTY: false },
  });
  await assert.rejects(
    () => cmd(upgrade, "upgrade run").run([], ctx),
    /needs confirmation/i,
  );
});

test("upgrade run refuses in --json mode without --yes (CI must opt in explicitly)", async () => {
  const { ctx } = makeCtx({
    json: true,
    api: { adminUpgrade: async () => ({ started: true }) },
    stdin: { isTTY: true }, // even with a TTY, --json bypasses the prompt path
  });
  await assert.rejects(
    () => cmd(upgrade, "upgrade run").run([], ctx),
    /--json mode without --yes/,
  );
});

test("upgrade run --yes posts { ref } when --ref is set, {} otherwise", async () => {
  const bodies = [];
  const { ctx } = makeCtx({
    api: {
      adminUpgrade: async (body) => {
        bodies.push(body);
        return { started: true, ref: body.ref || "" };
      },
    },
  });
  await cmd(upgrade, "upgrade run").run(["--yes"], ctx);
  await cmd(upgrade, "upgrade run").run(["--yes", "--ref=v1.2.0"], ctx);
  assert.deepEqual(bodies[0], {});
  assert.deepEqual(bodies[1], { ref: "v1.2.0" });
});

test("upgrade run surfaces a friendly hint when the backend 503s with updater_unreachable", async () => {
  const { ctx } = makeCtx({
    api: {
      adminUpgrade: async () => {
        throw new SynapseAPIError(503, "updater_unreachable", "Self-update daemon unreachable");
      },
    },
  });
  await assert.rejects(
    () => cmd(upgrade, "upgrade run").run(["--yes"], ctx),
    (err) => {
      assert.match(err.message, /Updater daemon not installed/);
      assert.match(err.message, /setup\.sh --install-updater/);
      assert.equal(err.code, "updater_not_installed");
      return true;
    },
  );
});

// ---- upgrade status ----------------------------------------------------

test("upgrade status forwards the jobId positional to adminUpgradeStatus", async () => {
  let captured = null;
  const { ctx } = makeCtx({
    json: true,
    api: {
      adminUpgradeStatus: async (jobId) => {
        captured = jobId;
        return { jobId, status: "succeeded", logs: ["done"] };
      },
    },
  });
  await cmd(upgrade, "upgrade status").run(["job-abc"], ctx);
  assert.equal(captured, "job-abc");
});

test("upgrade status without a jobId still hits the bare /status endpoint", async () => {
  let captured = "not-set";
  const { ctx } = makeCtx({
    json: true,
    api: {
      adminUpgradeStatus: async (jobId) => {
        captured = jobId;
        return { state: "idle" };
      },
    },
  });
  await cmd(upgrade, "upgrade status").run([], ctx);
  assert.equal(captured, "");
});
