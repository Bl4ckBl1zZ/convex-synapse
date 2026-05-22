// `synapse login <url>` — register the operator's session against a
// Synapse instance. The flow is intentionally minimal so it works
// over piped stdin (CI bootstrap): the prompts library detects a
// non-TTY and accepts `email\npassword\n` instead of rendering the
// hidden-password prompt.

const { askCredentials } = require("../prompts");
const { SynapseAPI } = require("../api");
const { normalizeBaseUrl, writeConfig } = require("../config");

module.exports = {
  name: "login",
  summary: "Authenticate against a Synapse instance and save the session locally.",
  usage: "synapse login <url>",
  description: `Prompts for email + password (or reads them piped on stdin) and writes the resulting session to ~/.synapse/config.json (mode 0600).

The saved session carries both the access token (1h TTL) and a refresh token (30d TTL); subsequent commands silent-refresh on 401 transparently — operators don't see /login prompts mid-task.`,

  async run(args, ctx) {
    const url = args[0];
    if (!url) {
      throw new Error("Usage: synapse login <url>");
    }
    const baseUrl = normalizeBaseUrl(url);
    const { email, password } = await askCredentials();
    const api = new SynapseAPI({ baseUrl });
    const session = await api.login(email, password);
    if (!session.accessToken) {
      throw new Error("Synapse login response did not include accessToken");
    }
    const file = writeConfig({
      baseUrl,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken || null,
      tokenType: session.tokenType || "Bearer",
      user: session.user || null,
    });
    ctx.out.result(
      { baseUrl, user: session.user || null, configPath: file },
      () => ctx.out.info(`Saved Synapse session to ${file}`),
    );
  },
};
