const { spawn } = require("node:child_process");
const { readProjectEnv } = require("./env-file");

function envFromCredentials(credentials) {
  if (!credentials) {
    return {};
  }
  return {
    CONVEX_SELF_HOSTED_URL: credentials.convexUrl,
    CONVEX_SELF_HOSTED_ADMIN_KEY: credentials.adminKey,
  };
}

function buildConvexEnv(source = process.env, projectEnv = {}, overrides = {}) {
  const env = { ...source };
  for (const key of ["CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"]) {
    if (!env[key] && projectEnv[key]) {
      env[key] = projectEnv[key];
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value) {
      env[key] = value;
    }
  }
  if (env.CONVEX_SELF_HOSTED_URL && env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    delete env.CONVEX_DEPLOYMENT;
  }
  return env;
}

// Node 18.20.0+, 20.12.0+, 22.0.0+ refuse to spawn `.cmd`/`.bat` shims on
// Windows without `shell: true` (CVE-2024-27980 mitigation). `npx` on Windows
// is `npx.cmd`, so without this flag every `synapse convex …` invocation
// dies with `spawn EINVAL`. Safe to enable because the argv is controlled
// by us — `"convex"` is literal and the remaining args come from the user's
// CLI line, which `child_process` quotes when handing them to `cmd.exe`.
function shouldUseShell(platform = process.platform) {
  return platform === "win32";
}

function runConvex(args, {
  env = process.env,
  stdio = "inherit",
  credentials = null,
  spawnImpl = spawn,
  platform = process.platform,
} = {}) {
  const executable = platform === "win32" ? "npx.cmd" : "npx";
  const projectEnv = readProjectEnv(process.cwd());
  const child = spawnImpl(executable, ["convex", ...args], {
    env: buildConvexEnv(env, projectEnv, envFromCredentials(credentials)),
    stdio,
    shell: shouldUseShell(platform),
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

module.exports = {
  buildConvexEnv,
  envFromCredentials,
  runConvex,
  shouldUseShell,
};
