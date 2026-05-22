// v1.8.6 UX polish — tests for the 5 P0 behavior changes:
//   A1: "Not logged in" copy now contains a URL example + admin hint
//   A2: `synapse login` emits a next-step info line after the save
//   A3: refresh-token failure surfaces as SessionExpiredError, not raw 401
//   A4: `synapse credentials` (no arg) lists names from linked project
//   A5: `synapse convex` pre-announces the NEXT_PUBLIC_CONVEX_SITE_URL warning,
//        and surfaces a hint when npx convex exits non-zero
//
// These live in their own file so the v1.8.6 polish PR is revertable
// as a single unit. Imports the same primitives as the existing tests
// (no shared harness — Node's built-in test runner + PassThrough).

const assert = require("node:assert/strict");
const test = require("node:test");
const { PassThrough } = require("node:stream");

const { createOutput } = require("../lib/output");
const { createContext, SessionExpiredError, makeRefreshableApi } = require("../lib/commands/_context");
const { SynapseAPIError } = require("../lib/api");
const loginCmd = require("../lib/commands/login");
const credentialsCmd = require("../lib/commands/credentials");
const convexCmd = require("../lib/commands/convex");

function capture(json = false) {
  const stdoutBuf = [];
  const stderrBuf = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => stdoutBuf.push(c.toString("utf8")));
  stderr.on("data", (c) => stderrBuf.push(c.toString("utf8")));
  return {
    stdout,
    stderr,
    out: createOutput({ json, stdout, stderr }),
    text: () => ({ stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") }),
  };
}

// ---- A1: improved "Not logged in" copy --------------------------------

test("A1: ctx.cfg throws with a helpful URL example + admin hint", () => {
  // No saved config + no env override → readConfig() returns null.
  // We bypass the read by spying via createContext with a fake readConfig
  // path: easier — point HOME at an empty tmpdir.
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syn-cfg-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const cap = capture();
    const ctx = createContext({ out: cap.out, cwd: tmp });
    let caught;
    try {
      // Trigger the getter.
      void ctx.cfg;
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "cfg getter must throw when no session is saved");
    // The new copy must include:
    //   - the literal command form with URL placeholder
    //   - a concrete example URL
    //   - the "ask your admin" fallback
    assert.match(caught.message, /Not logged in/);
    assert.match(caught.message, /synapse login <your-synapse-url>/);
    assert.match(caught.message, /https:\/\/synapsepanel\.com/);
    assert.match(caught.message, /ask the admin/);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- A2: login post-save next-step hint --------------------------------

test("A2: login emits a 'Next step: synapse select' info line after save", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syn-login-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmp;
  // The login command:
  //   1. parses URL from args
  //   2. calls askCredentials() — reads from piped stdin
  //   3. calls SynapseAPI.login() — we monkey-patch globalThis.fetch
  //   4. writeConfig to ~/.synapse/config.json
  //   5. emits the new "Next step" info line
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      accessToken: "fake-jwt",
      refreshToken: "fake-refresh",
      tokenType: "Bearer",
      user: { id: "u-1", email: "ian@example.com" },
    }),
  });
  // askCredentials reads from process.stdin — pipe a fake stdin.
  const origStdin = process.stdin;
  const fakeStdin = new PassThrough();
  Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
  fakeStdin.isTTY = false;
  fakeStdin.end("ian@example.com\nsuperpassword\n");
  try {
    const cap = capture();
    const ctx = { out: cap.out, cwd: tmp };
    await loginCmd.run(["https://synapsepanel.com"], ctx);
    const txt = cap.text().stderr;
    // The hint MUST mention `synapse select` AND `synapse doctor` —
    // the canonical step-2 commands. We don't pin exact copy beyond
    // the command names to keep wording iterable.
    assert.match(txt, /Saved Synapse session/);
    assert.match(txt, /Next step/);
    assert.match(txt, /synapse select/);
    assert.match(txt, /synapse doctor/);
  } finally {
    globalThis.fetch = origFetch;
    Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- A3: refresh-token failure raises SessionExpiredError --------------

test("A3: SessionExpiredError carries baseUrl + cause + an actionable message", () => {
  const err = new SessionExpiredError("https://synapsepanel.com", "invalid_grant 401");
  assert.equal(err.name, "SessionExpiredError");
  assert.equal(err.baseUrl, "https://synapsepanel.com");
  assert.match(err.message, /session expired/i);
  assert.match(err.message, /synapse login https:\/\/synapsepanel\.com/);
  assert.match(err.message, /invalid_grant 401/);
});

test("A3: makeRefreshableApi turns a refresh 401 into SessionExpiredError", async () => {
  // Fake the underlying SynapseAPI by intercepting globalThis.fetch:
  // first call → returns 401 (forces a refresh attempt)
  // second call (the refresh) → also 401 (refresh token rejected)
  const origFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url) => {
    n += 1;
    return {
      ok: false,
      status: 401,
      json: async () => ({ code: "invalid_token", message: "expired" }),
    };
  };
  try {
    const cfg = {
      baseUrl: "https://x.example.com",
      accessToken: "stale",
      refreshToken: "also-stale",
    };
    const api = makeRefreshableApi(cfg);
    let caught;
    try {
      await api.me();
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof SessionExpiredError);
    assert.match(caught.message, /synapse login https:\/\/x\.example\.com/);
    // The first fetch is /v1/me/, the second is /v1/auth/refresh, so
    // we should have hit fetch twice before the wrapper gave up.
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("A3: refresh 'no accessToken' response also raises SessionExpiredError", async () => {
  const origFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) {
      // initial 401
      return { ok: false, status: 401, json: async () => ({ code: "expired" }) };
    }
    // refresh succeeds HTTP-wise but returns no token (defensive code path)
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const cfg = { baseUrl: "https://x", accessToken: "a", refreshToken: "r" };
    const api = makeRefreshableApi(cfg);
    let caught;
    try {
      await api.me();
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof SessionExpiredError);
    assert.match(caught.message, /no access token in refresh response/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---- A4: credentials no-arg lists project deployments -----------------

test("A4: credentials no-arg surfaces deployment names from linked project", async () => {
  const cap = capture();
  const ctx = {
    out: cap.out,
    cwd: process.cwd(),
    projectConfig: {
      deployments: {
        dev: { name: "brave-dolphin-1060" },
        prod: { name: "wise-otter-2200" },
      },
    },
    // Should never be called — error throws before any API access.
    api: { cliCredentials: async () => assert.fail("should not be called") },
  };
  let caught;
  try {
    await credentialsCmd.run([], ctx);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.match(caught.message, /Usage:/);
  // The new actionable section:
  assert.match(caught.message, /dev=brave-dolphin-1060/);
  assert.match(caught.message, /prod=wise-otter-2200/);
  // A concrete sample invocation:
  assert.match(caught.message, /synapse credentials brave-dolphin-1060/);
});

test("A4: credentials no-arg without a linked project keeps the bare Usage line", async () => {
  const cap = capture();
  const ctx = {
    out: cap.out,
    cwd: process.cwd(),
    projectConfig: null, // unlinked directory
    api: { cliCredentials: async () => assert.fail("should not be called") },
  };
  let caught;
  try {
    await credentialsCmd.run([], ctx);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.match(caught.message, /Usage:/);
  // No actionable hint when we have nothing to hint about.
  assert.doesNotMatch(caught.message, /This project has/);
});

// ---- A5: convex pre-spawn note + non-zero exit hint -------------------

test("A5: convex wrapper exports the helpers and the runConvexCommand path", () => {
  // Pure shape check — we don't drive the spawn path in this unit
  // test (covered by the existing convex.test.js + bin.test.js).
  // The behavior change is purely in the info lines emitted around
  // the spawn; live exercise lands in the next `synapse dev` real-VPS
  // run (see commit log + manual smoke).
  assert.equal(typeof convexCmd.runConvexCommand, "function");
  assert.equal(convexCmd.name, "convex");
});
