#!/usr/bin/env node

// Thin dispatcher. Every command's logic lives in lib/commands/*.js;
// this file's only jobs are:
//   1. Parse argv into (cmd, rest) via the two-then-one registry.
//   2. Short-circuit --help / help.
//   3. Construct the runtime ctx (output layer, lazy session+API).
//   4. Catch top-level errors and emit a consistent stderr message.
//
// Legacy named exports at the bottom are kept ONLY for backwards-
// compatibility with test/bin.test.js — production code paths never
// need to require this file as a library.

const { buildRegistry, resolve, wantsHelp } = require("../lib/commands/_dispatcher");
const { renderRootHelp, renderCommandHelp } = require("../lib/commands/_help");
const { createContext } = require("../lib/commands/_context");
const { createOutput, extractJsonFlag } = require("../lib/output");
const { SynapseAPIError } = require("../lib/api");

const REGISTRY = buildRegistry();

async function main(argv) {
  // Strip --json from any position so commands see clean positionals.
  const { json, rest: cleanArgv } = extractJsonFlag(argv);

  // help / no-args → root help.
  if (cleanArgv.length === 0 || cleanArgv[0] === "help" || cleanArgv[0] === "-h" || cleanArgv[0] === "--help") {
    return renderRootHelp(REGISTRY);
  }

  const { cmd, rest } = resolve(REGISTRY, cleanArgv);
  if (!cmd) {
    process.stderr.write(`Unknown command: ${cleanArgv.join(" ")}\n\nRun \`synapse help\` for the full list.\n`);
    process.exitCode = 1;
    return;
  }

  if (wantsHelp(rest)) {
    return renderCommandHelp(cmd);
  }

  const out = createOutput({ json });
  const ctx = createContext({ out });
  return await cmd.run(rest, ctx);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    if (err && err.code === "network_error") {
      process.stderr.write(
        "Hint: double-check the URL is reachable from this machine (try `curl <url>/v1/install_status`) and that the Synapse server is running.\n",
      );
    }
    process.exitCode = 1;
  });
}

// ---- Legacy exports (test/bin.test.js consumes these) --------------
//
// Re-export the helpers the existing tests already import. Adding new
// commands does NOT add to this list — new code lives in lib/commands/
// and is tested directly there.

const _convexCmd = require("../lib/commands/convex");
const _deployCmd = require("../lib/commands/deploy");
const _devCmd = require("../lib/commands/dev");
const _credentialsCmd = require("../lib/commands/credentials");
const _selectCmd = require("../lib/commands/select");
const _ctxModule = require("../lib/commands/_context");

// `clientFromConfig` was the pre-refactor entry point that returned
// { cfg, api } for any command that needed auth. Kept here as a thin
// shim around the same underlying helper so test/bin.test.js's
// "clientFromConfig refreshes an expired access token" still passes.
function clientFromConfig() {
  const { requireConfig } = require("../lib/config");
  const cfg = requireConfig();
  const api = _ctxModule.makeRefreshableApi(cfg);
  return { cfg, api };
}

module.exports = {
  main,
  clientFromConfig,
  // dev / deploy keep their pre-refactor signatures for test injectors.
  deploy: _deployCmd.deploy,
  dev: _devCmd.dev,
  extractYesFlag: _deployCmd.extractYesFlag,
  formatCredentials: _credentialsCmd.formatCredentials,
  parseFormat: _credentialsCmd.parseFormat,
  // convex command exposes the pure parsers used by tests.
  inferConvexTarget: _convexCmd.inferConvexTarget,
  parseConvexInvocation: _convexCmd.parseConvexInvocation,
  resolveConvexInvocation: _convexCmd.resolveConvexInvocation,
  // select command's helpers.
  chooseDeploymentForType: _selectCmd.chooseDeploymentForType,
};
