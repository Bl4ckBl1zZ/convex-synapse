// `synapse version` — print the CLI's own version, plus the version of
// the Synapse backend it's logged into (best-effort), plus Node + OS.
//
// Designed to be the first thing operators run when reporting a bug —
// the data here is enough to triage without further questions.

const os = require("node:os");
const pkg = require("../../package.json");

module.exports = {
  name: "version",
  summary: "Show CLI, backend, Node and OS versions.",
  usage: "synapse version [--json]",
  description: `Reports:
  cli       this package's npm version (from package.json)
  backend   the Synapse instance's version (via /v1/install_status)
  node      runtime version
  platform  os + arch

If you're not logged in, backend is reported as null with a reason.
Output is stable across releases — safe to grep in CI logs.`,

  async run(_args, ctx) {
    const cliVersion = pkg.version;
    const node = process.version;
    const platform = `${os.platform()} ${os.release()} (${process.arch})`;

    let backend = null;
    let backendError = null;
    const cfg = ctx.cfgOrNull;
    if (!cfg || !cfg.baseUrl) {
      backendError = "not logged in";
    } else {
      try {
        // install_status is public — no auth needed, no refresh races.
        // Use the unauthenticated SynapseAPI so a 401 on /me/ doesn't
        // muddy this purely informational call.
        const { SynapseAPI } = require("../api");
        const probe = new SynapseAPI({ baseUrl: cfg.baseUrl });
        const status = await probe.request(
          "GET",
          "/v1/install_status",
          undefined,
          { auth: false },
        );
        backend = { url: cfg.baseUrl, version: status.version, firstRun: status.firstRun };
      } catch (err) {
        backendError = err && err.message ? err.message : String(err);
        backend = { url: cfg.baseUrl, version: null };
      }
    }

    const payload = {
      cli: cliVersion,
      backend,
      backendError,
      node,
      platform,
    };

    ctx.out.result(payload, (d, { stdout }) => {
      const widest = "platform".length;
      const pad = (k) => k.padEnd(widest);
      stdout.write(`${pad("cli")}  ${d.cli}\n`);
      if (d.backend) {
        const v = d.backend.version ? `${d.backend.version}` : "(unknown)";
        const reason = d.backendError ? ` — ${d.backendError}` : "";
        stdout.write(`${pad("backend")}  ${v}${reason}\n`);
        stdout.write(`${pad("")}  at ${d.backend.url}\n`);
      } else {
        stdout.write(`${pad("backend")}  (not logged in)\n`);
      }
      stdout.write(`${pad("node")}  ${d.node}\n`);
      stdout.write(`${pad("platform")}  ${d.platform}\n`);
    });
  },
};
