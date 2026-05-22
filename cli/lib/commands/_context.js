// Runtime context handed to every command's `run(rest, ctx)`.
//
// The dispatcher constructs one of these per invocation. It carries:
//   - cfg / api: the operator's session and a refresh-aware API client,
//     lazily built (commands like `version` that don't need a session
//     can read ctx.cfgOrNull without forcing the user to log in first).
//   - out: the shared output layer (createOutput()), already aware of
//     whether --json was on the argv.
//   - projectDir / projectConfig: convenience accessors for commands
//     that need the linked project metadata (.synapse/project.json).
//
// Commands MUST go through ctx instead of touching process.stdout /
// process.cwd directly — otherwise --json piping and the test fakes
// stop working.

const { SynapseAPI, SynapseAPIError } = require("../api");
const {
  clearConfig: _clearConfig,
  normalizeBaseUrl,
  readConfig,
  requireConfig,
  writeConfig,
} = require("../config");
const { readProjectConfig } = require("../project");

// Wraps an API client so any 401 transparently retries against
// /v1/auth/refresh once. Mirrors what bin/synapse.js had before the
// refactor; lives here so every command shares it.
function makeRefreshableApi(cfg) {
  const api = new SynapseAPI({ baseUrl: cfg.baseUrl, accessToken: cfg.accessToken });
  return new Proxy(api, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      return async (...args) => {
        try {
          return await value.apply(target, args);
        } catch (err) {
          if (
            !(err instanceof SynapseAPIError) ||
            err.status !== 401 ||
            !cfg.refreshToken
          ) {
            throw err;
          }
          const session = await new SynapseAPI({ baseUrl: cfg.baseUrl }).refresh(
            cfg.refreshToken,
          );
          if (!session.accessToken) throw err;
          cfg.accessToken = session.accessToken;
          cfg.refreshToken = session.refreshToken || cfg.refreshToken;
          cfg.tokenType = session.tokenType || cfg.tokenType || "Bearer";
          if (session.user) cfg.user = session.user;
          writeConfig(cfg);
          target.accessToken = cfg.accessToken;
          return await value.apply(target, args);
        }
      };
    },
  });
}

function createContext({ out, cwd = process.cwd(), env = process.env } = {}) {
  let _cfg = null;
  let _api = null;
  let _projectConfig;
  const cfgLoad = () => {
    if (_cfg === undefined || _cfg === null) {
      _cfg = readConfig(); // may be null if not logged in
    }
    return _cfg;
  };

  return {
    out,
    cwd,
    env,

    // Returns the saved config or null. Commands that don't need a
    // session (version, doctor's local checks) use this.
    get cfgOrNull() {
      return cfgLoad();
    },

    // Throws "Not logged in" with a helpful message when no session
    // exists. Commands that REQUIRE auth call this.
    get cfg() {
      const c = cfgLoad();
      if (!c || !c.baseUrl || !c.accessToken) {
        throw new Error("Not logged in. Run `synapse login <url>` first.");
      }
      _cfg = c;
      return c;
    },

    // Builds an auth+refresh-aware API client on demand.
    get api() {
      if (_api) return _api;
      const c = this.cfg; // throws if not logged in
      _api = makeRefreshableApi(c);
      return _api;
    },

    // Re-reads the project metadata from disk on first access only —
    // commands that mutate it (synapse select) call this AFTER writing.
    get projectConfig() {
      if (_projectConfig === undefined) {
        _projectConfig = readProjectConfig(cwd);
      }
      return _projectConfig;
    },

    // Convenience for commands that need to verify a project is linked.
    requireProject() {
      const p = this.projectConfig;
      if (!p) {
        throw new Error(
          "No Synapse project metadata found in this directory. Run `synapse select` first.",
        );
      }
      return p;
    },

    // Force a re-read of the project config (e.g. after `synapse select`
    // wrote a new file mid-handler).
    refreshProjectConfig() {
      _projectConfig = readProjectConfig(cwd);
      return _projectConfig;
    },
  };
}

module.exports = { createContext, makeRefreshableApi, normalizeBaseUrl };
