// `synapse whoami` — confirm the saved session is alive against the
// backend. Hits /v1/me; if the access token is expired but the
// refresh token still works, the api proxy silently rotates the
// bundle transparently before reporting OK.

module.exports = {
  name: "whoami",
  summary: "Show the email + URL the saved session is authenticated for.",
  usage: "synapse whoami",
  description: `Calls /v1/me/ on the backend. Returns the user's display name + email + the base URL of the Synapse instance. Triggers silent-refresh under the hood if the access token has expired but the refresh token is still good.`,

  async run(_args, ctx) {
    const me = await ctx.api.me();
    const email = me.email || me.user?.email || "(unknown email)";
    const name = me.name || me.user?.name || "";
    ctx.out.result(
      { email, name, baseUrl: ctx.cfg.baseUrl },
      ({ email, name, baseUrl }, { stdout }) =>
        stdout.write(`${name ? `${name} ` : ""}<${email}> on ${baseUrl}\n`),
    );
  },
};
