// `synapse logout` — clear the saved session from ~/.synapse/config.json.
// No backend call (the JWT stays technically valid until exp; the
// point is to delete the refresh token from this machine so future
// 401s can't silent-refresh into a fresh session).

const { clearConfig } = require("../config");

module.exports = {
  name: "logout",
  summary: "Clear the saved Synapse session from this machine.",
  usage: "synapse logout",
  description: `Deletes ~/.synapse/config.json. Does not contact the backend — tokens stay technically valid until their natural exp, but the refresh token is gone so silent-refresh can no longer pick up where you left off.`,

  async run(_args, ctx) {
    const removed = clearConfig();
    ctx.out.result({ removed }, () =>
      ctx.out.info(removed ? "Logged out of Synapse." : "No Synapse session was saved."),
    );
  },
};
