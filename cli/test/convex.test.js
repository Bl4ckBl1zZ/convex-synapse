const assert = require("node:assert/strict");
const test = require("node:test");

const { buildConvexEnv, runConvex, shouldUseShell } = require("../lib/convex");

test("removes CONVEX_DEPLOYMENT when self-hosted credentials are present", () => {
  const env = buildConvexEnv({
    CONVEX_DEPLOYMENT: "dev:cloud-cat",
    CONVEX_SELF_HOSTED_URL: "https://happy-cat.convex.example.com",
    CONVEX_SELF_HOSTED_ADMIN_KEY: "dev:happy-cat|secret",
  });
  assert.equal(env.CONVEX_DEPLOYMENT, undefined);
  assert.equal(env.CONVEX_SELF_HOSTED_URL, "https://happy-cat.convex.example.com");
});

test("uses project .env.local self-hosted credentials to clean child env", () => {
  const env = buildConvexEnv(
    { CONVEX_DEPLOYMENT: "dev:cloud-cat" },
    {
      CONVEX_SELF_HOSTED_URL: "https://happy-cat.convex.example.com",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "dev:happy-cat|secret",
    },
  );
  assert.equal(env.CONVEX_DEPLOYMENT, undefined);
  assert.equal(env.CONVEX_SELF_HOSTED_URL, "https://happy-cat.convex.example.com");
  assert.equal(env.CONVEX_SELF_HOSTED_ADMIN_KEY, "dev:happy-cat|secret");
});

test("runtime credentials override shell and project self-hosted env", () => {
  const env = buildConvexEnv(
    {
      CONVEX_DEPLOYMENT: "dev:cloud-cat",
      CONVEX_SELF_HOSTED_URL: "https://old.example.com",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "dev:old|secret",
    },
    {
      CONVEX_SELF_HOSTED_URL: "https://project.example.com",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "dev:project|secret",
    },
    {
      CONVEX_SELF_HOSTED_URL: "https://target.example.com",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "prod:target|secret",
    },
  );
  assert.equal(env.CONVEX_DEPLOYMENT, undefined);
  assert.equal(env.CONVEX_SELF_HOSTED_URL, "https://target.example.com");
  assert.equal(env.CONVEX_SELF_HOSTED_ADMIN_KEY, "prod:target|secret");
});

test("leaves CONVEX_DEPLOYMENT alone without complete self-hosted credentials", () => {
  const env = buildConvexEnv({
    CONVEX_DEPLOYMENT: "dev:cloud-cat",
    CONVEX_SELF_HOSTED_URL: "https://happy-cat.convex.example.com",
  });
  assert.equal(env.CONVEX_DEPLOYMENT, "dev:cloud-cat");
});

test("shouldUseShell is true only on win32", () => {
  assert.equal(shouldUseShell("win32"), true);
  assert.equal(shouldUseShell("linux"), false);
  assert.equal(shouldUseShell("darwin"), false);
  assert.equal(shouldUseShell("freebsd"), false);
});

test("runConvex spawns npx.cmd with shell:true on Windows", async () => {
  const calls = [];
  const fakeSpawn = (executable, args, opts) => {
    calls.push({ executable, args, opts });
    return makeFakeChild(0);
  };

  const exit = await runConvex(["dev", "--once"], {
    spawnImpl: fakeSpawn,
    platform: "win32",
    env: {},
    credentials: { convexUrl: "https://x.example.com", adminKey: "k|s" },
  });

  assert.equal(exit, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "npx.cmd");
  assert.deepEqual(calls[0].args, ["convex", "dev", "--once"]);
  assert.equal(calls[0].opts.shell, true);
  assert.equal(calls[0].opts.env.CONVEX_SELF_HOSTED_URL, "https://x.example.com");
  assert.equal(calls[0].opts.env.CONVEX_SELF_HOSTED_ADMIN_KEY, "k|s");
});

test("runConvex spawns npx with shell:false on POSIX", async () => {
  const calls = [];
  const fakeSpawn = (executable, args, opts) => {
    calls.push({ executable, args, opts });
    return makeFakeChild(0);
  };

  const exit = await runConvex(["deploy"], {
    spawnImpl: fakeSpawn,
    platform: "linux",
    env: {},
    credentials: { convexUrl: "https://x.example.com", adminKey: "k|s" },
  });

  assert.equal(exit, 0);
  assert.equal(calls[0].executable, "npx");
  assert.deepEqual(calls[0].args, ["convex", "deploy"]);
  assert.equal(calls[0].opts.shell, false);
});

test("runConvex resolves with 1 when the child reports a terminating signal", async () => {
  const fakeSpawn = () => makeFakeChild(null, "SIGTERM");
  const exit = await runConvex(["dev"], { spawnImpl: fakeSpawn, platform: "linux", env: {} });
  assert.equal(exit, 1);
});

// Minimal fake of the ChildProcess subset runConvex uses (just `once`).
function makeFakeChild(code, signal = null) {
  const handlers = new Map();
  const child = {
    once(event, handler) {
      handlers.set(event, handler);
      return child;
    },
  };
  // Defer until the next tick so callers can register both handlers before
  // either fires — mirrors the real spawn timing.
  setImmediate(() => {
    const close = handlers.get("close");
    if (close) close(code, signal);
  });
  return child;
}
