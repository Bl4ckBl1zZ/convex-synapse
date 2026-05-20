const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough } = require("node:stream");

const {
  clientFromConfig,
  deploy,
  dev,
  extractYesFlag,
  inferConvexTarget,
  main,
  parseConvexInvocation,
  resolveConvexInvocation,
} = require("../bin/synapse");
const config = require("../lib/config");
const projectConfig = require("../lib/project");

function makeStdin({ isTTY = true } = {}) {
  const stream = new PassThrough();
  Object.defineProperty(stream, "isTTY", { value: isTTY, configurable: true });
  return stream;
}

function makeStderr() {
  const buffer = [];
  const stream = new PassThrough();
  stream.on("data", (c) => buffer.push(c.toString("utf8")));
  return { stream, text: () => buffer.join("") };
}

test("clientFromConfig refreshes an expired access token and retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-bin-"));
  process.env.SYNAPSE_CLI_CONFIG = path.join(dir, "config.json");
  const originalFetch = global.fetch;
  const calls = [];
  try {
    config.writeConfig({
      baseUrl: "https://synapse.example.com",
      accessToken: "expired",
      refreshToken: "refresh",
    });
    global.fetch = async (url, init) => {
      calls.push({ path: url.pathname, auth: init.headers.Authorization });
      if (url.pathname === "/v1/me/" && init.headers.Authorization === "Bearer expired") {
        return new Response(JSON.stringify({ code: "invalid_token", message: "expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/v1/auth/refresh") {
        assert.equal(init.headers.Authorization, undefined);
        assert.deepEqual(JSON.parse(init.body), { refreshToken: "refresh" });
        return new Response(JSON.stringify({ accessToken: "fresh", refreshToken: "fresh-refresh" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/v1/me/" && init.headers.Authorization === "Bearer fresh") {
        return new Response(JSON.stringify({ email: "ian@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected call ${url.pathname}`);
    };

    const { api } = clientFromConfig();
    const me = await api.me();
    assert.equal(me.email, "ian@example.com");
    assert.deepEqual(calls.map((c) => c.path), ["/v1/me/", "/v1/auth/refresh", "/v1/me/"]);
    assert.equal(config.readConfig().accessToken, "fresh");
    assert.equal(config.readConfig().refreshToken, "fresh-refresh");
  } finally {
    global.fetch = originalFetch;
    delete process.env.SYNAPSE_CLI_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseConvexInvocation maps dev to dev, deploy to prod, and honors target override", () => {
  assert.equal(inferConvexTarget(["dev", "--once"]), "dev");
  assert.equal(inferConvexTarget(["deploy"]), "prod");
  assert.equal(inferConvexTarget(["run", "messages:list"]), "dev");

  assert.deepEqual(parseConvexInvocation(["dev", "--once"]), {
    explicitTarget: false,
    target: "dev",
    args: ["dev", "--once"],
  });
  assert.deepEqual(parseConvexInvocation(["--target", "prod", "dev", "--once"]), {
    explicitTarget: true,
    target: "prod",
    args: ["dev", "--once"],
  });
  assert.deepEqual(parseConvexInvocation(["--target=dev", "deploy"]), {
    explicitTarget: true,
    target: "dev",
    args: ["deploy"],
  });
  assert.throws(() => parseConvexInvocation(["--target", "preview", "dev"]), /--target must be dev or prod/);
  assert.throws(() => parseConvexInvocation(["--target"]), /--target requires dev or prod/);
});

test("resolveConvexInvocation fetches dev or prod credentials from project metadata", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-bin-project-"));
  try {
    projectConfig.writeProjectConfig(dir, {
      synapseUrl: "https://synapse.example.com",
      team: { id: "team-id", slug: "team", name: "Team" },
      project: { id: "project-id", slug: "app", name: "App" },
      deployments: {
        dev: { name: "dev-cat", deploymentType: "dev" },
        prod: { name: "prod-cat", deploymentType: "prod" },
      },
    });
    const requested = [];
    const api = {
      async cliCredentials(name) {
        requested.push(name);
        return {
          convexUrl: `https://${name}.example.com`,
          adminKey: `${name}|secret`,
        };
      },
    };
    const cfg = { baseUrl: "https://synapse.example.com" };

    const dev = await resolveConvexInvocation(["dev", "--once"], { cfg, api, projectDir: dir });
    assert.equal(dev.target, "dev");
    assert.equal(dev.deploymentName, "dev-cat");
    assert.equal(dev.credentials.convexUrl, "https://dev-cat.example.com");

    const prod = await resolveConvexInvocation(["deploy"], { cfg, api, projectDir: dir });
    assert.equal(prod.target, "prod");
    assert.equal(prod.deploymentName, "prod-cat");
    assert.equal(prod.credentials.adminKey, "prod-cat|secret");

    const override = await resolveConvexInvocation(["--target", "dev", "deploy"], { cfg, api, projectDir: dir });
    assert.equal(override.target, "dev");
    assert.equal(override.deploymentName, "dev-cat");
    assert.deepEqual(requested, ["dev-cat", "prod-cat", "dev-cat"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractYesFlag strips --yes / -y and keeps everything else", () => {
  assert.deepEqual(extractYesFlag([]), { yes: false, rest: [] });
  assert.deepEqual(extractYesFlag(["--yes"]), { yes: true, rest: [] });
  assert.deepEqual(extractYesFlag(["-y"]), { yes: true, rest: [] });
  assert.deepEqual(extractYesFlag(["--once", "--yes", "extra"]), {
    yes: true,
    rest: ["--once", "extra"],
  });
  // Synapse-level only; downstream --yes-foo flag must pass through untouched.
  assert.deepEqual(extractYesFlag(["--yes-typecheck"]), {
    yes: false,
    rest: ["--yes-typecheck"],
  });
});

test("synapse deploy aborts without calling convex when the user declines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-deploy-"));
  const previousCwd = process.cwd();
  process.env.SYNAPSE_CLI_CONFIG = path.join(dir, "config.json");
  try {
    config.writeConfig({ baseUrl: "https://synapse.example.com", accessToken: "tok" });
    projectConfig.writeProjectConfig(dir, {
      synapseUrl: "https://synapse.example.com",
      team: { id: "t", slug: "team", name: "Team" },
      project: { id: "p", slug: "app", name: "App" },
      deployments: {
        dev: { name: "dev-cat", deploymentType: "dev" },
        prod: { name: "prod-cat", deploymentType: "prod" },
      },
    });
    process.chdir(dir);

    let convexCalled = false;
    const out = makeStderr();
    await deploy([], {
      input: makeStdin({ isTTY: true }),
      output: out.stream,
      confirmImpl: async () => false,
      convexImpl: async () => {
        convexCalled = true;
      },
    });

    assert.equal(convexCalled, false);
    assert.match(out.text(), /Deploy cancelled/);
  } finally {
    process.chdir(previousCwd);
    delete process.env.SYNAPSE_CLI_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("synapse deploy --yes skips the confirmation entirely and forwards args to convex", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-deploy-yes-"));
  const previousCwd = process.cwd();
  process.env.SYNAPSE_CLI_CONFIG = path.join(dir, "config.json");
  try {
    config.writeConfig({ baseUrl: "https://synapse.example.com", accessToken: "tok" });
    projectConfig.writeProjectConfig(dir, {
      synapseUrl: "https://synapse.example.com",
      team: { id: "t", slug: "team", name: "Team" },
      project: { id: "p", slug: "app", name: "App" },
      deployments: { prod: { name: "prod-cat", deploymentType: "prod" } },
    });
    process.chdir(dir);

    let promptedDespiteYes = false;
    let forwardedArgs = null;
    await deploy(["--yes", "--debug-bundle-path", "/tmp/bundle"], {
      input: makeStdin({ isTTY: false }), // non-TTY still OK with --yes
      output: makeStderr().stream,
      confirmImpl: async () => {
        promptedDespiteYes = true;
        return true;
      },
      convexImpl: async (args) => {
        forwardedArgs = args;
      },
    });

    assert.equal(promptedDespiteYes, false, "confirm must not be invoked under --yes");
    assert.deepEqual(forwardedArgs, [
      "--target", "prod", "deploy", "--debug-bundle-path", "/tmp/bundle",
    ]);
  } finally {
    process.chdir(previousCwd);
    delete process.env.SYNAPSE_CLI_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("synapse deploy refuses when stdin is not a TTY and --yes is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-deploy-notty-"));
  const previousCwd = process.cwd();
  process.env.SYNAPSE_CLI_CONFIG = path.join(dir, "config.json");
  try {
    config.writeConfig({ baseUrl: "https://synapse.example.com", accessToken: "tok" });
    projectConfig.writeProjectConfig(dir, {
      synapseUrl: "https://synapse.example.com",
      team: { id: "t", slug: "team", name: "Team" },
      project: { id: "p", slug: "app", name: "App" },
      deployments: { prod: { name: "prod-cat", deploymentType: "prod" } },
    });
    process.chdir(dir);

    let convexCalled = false;
    await assert.rejects(
      () => deploy([], {
        input: makeStdin({ isTTY: false }),
        output: makeStderr().stream,
        convexImpl: async () => { convexCalled = true; },
      }),
      /Pass --yes to skip/,
    );
    assert.equal(convexCalled, false);
  } finally {
    process.chdir(previousCwd);
    delete process.env.SYNAPSE_CLI_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("synapse dev delegates straight to convex without any confirmation", async () => {
  let forwardedArgs = null;
  await dev(["--once"], {
    convexImpl: async (args) => {
      forwardedArgs = args;
    },
  });
  assert.deepEqual(forwardedArgs, ["--target", "dev", "dev", "--once"]);
});

test("synapse deploy without saved project metadata falls through to convex (which will error helpfully)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-deploy-noproj-"));
  const previousCwd = process.cwd();
  process.env.SYNAPSE_CLI_CONFIG = path.join(dir, "config.json");
  try {
    config.writeConfig({ baseUrl: "https://synapse.example.com", accessToken: "tok" });
    process.chdir(dir);
    let promptOpened = false;
    let convexArgs = null;
    await deploy([], {
      input: makeStdin({ isTTY: true }),
      output: makeStderr().stream,
      confirmImpl: async () => {
        promptOpened = true;
        return true;
      },
      convexImpl: async (args) => { convexArgs = args; },
    });
    // No project => we skip the confirmation entirely; convex() handles the
    // "run `synapse select`" guidance with its own clearer error.
    assert.equal(promptOpened, false);
    assert.deepEqual(convexArgs, ["--target", "prod", "deploy"]);
  } finally {
    process.chdir(previousCwd);
    delete process.env.SYNAPSE_CLI_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConvexInvocation falls back without metadata but rejects explicit target", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-bin-no-project-"));
  try {
    const fallback = await resolveConvexInvocation(["dev"], { projectDir: dir });
    assert.equal(fallback.target, null);
    assert.equal(fallback.credentials, null);
    assert.deepEqual(fallback.args, ["dev"]);

    await assert.rejects(
      () => resolveConvexInvocation(["--target", "prod", "deploy"], { projectDir: dir }),
      /Run `synapse select` first/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("synapse select saves dev and prod metadata without secrets and writes dev env", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-select-"));
  const previousCwd = process.cwd();
  const originalFetch = global.fetch;
  process.env.SYNAPSE_CLI_CONFIG = path.join(dir, "config.json");
  try {
    config.writeConfig({
      baseUrl: "https://synapse.example.com",
      accessToken: "access",
      refreshToken: "refresh",
    });
    process.chdir(dir);
    global.fetch = async (url, init) => {
      assert.equal(init.headers.Authorization, "Bearer access");
      const json = (body) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      switch (url.pathname) {
        case "/v1/teams/":
          return json([{ id: "team-id", slug: "team", name: "Team", accessToken: "team-secret" }]);
        case "/v1/teams/team/list_projects":
          return json([{ id: "project-id", slug: "app", name: "App", refreshToken: "project-secret" }]);
        case "/v1/projects/project-id/list_deployments":
          return json([
            {
              id: "dev-id",
              name: "dev-cat",
              deploymentType: "dev",
              status: "running",
              isDefault: true,
              adminKey: "dev-must-not-save",
            },
            {
              id: "prod-id",
              name: "prod-cat",
              deploymentType: "prod",
              status: "running",
              isDefault: true,
              adminKey: "prod-must-not-save",
            },
          ]);
        case "/v1/deployments/dev-cat/cli_credentials":
          return json({
            deploymentName: "dev-cat",
            convexUrl: "https://dev-cat.example.com",
            adminKey: "dev-admin-key",
          });
        default:
          throw new Error(`unexpected request ${url.pathname}`);
      }
    };

    await main(["select"]);

    const metadataRaw = fs.readFileSync(path.join(dir, ".synapse", "project.json"), "utf8");
    assert.equal(metadataRaw.includes("access"), false);
    assert.equal(metadataRaw.includes("refresh"), false);
    assert.equal(metadataRaw.includes("admin"), false);
    const metadata = JSON.parse(metadataRaw);
    assert.equal(metadata.synapseUrl, "https://synapse.example.com");
    assert.equal(metadata.deployments.dev.name, "dev-cat");
    assert.equal(metadata.deployments.prod.name, "prod-cat");

    const env = fs.readFileSync(path.join(dir, ".env.local"), "utf8");
    assert.match(env, /CONVEX_SELF_HOSTED_URL="https:\/\/dev-cat\.example\.com"/);
    assert.match(env, /CONVEX_SELF_HOSTED_ADMIN_KEY="dev-admin-key"/);
  } finally {
    global.fetch = originalFetch;
    process.chdir(previousCwd);
    delete process.env.SYNAPSE_CLI_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
