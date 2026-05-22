// `synapse credentials <deployment> [--format env|shell|json]` — fetch a
// deployment's CONVEX_SELF_HOSTED_* pair from the backend and emit it
// in the requested format. Read-only; doesn't touch any local file.
//
// Operators mostly use --format env (pasteable into .env.local) and
// --format shell (eval-able to export the vars). --format json is for
// CI scripts that want machine-parseable output.

const { quoteEnvValue } = require("../env-file");

const FORMATS = new Set(["env", "shell", "json"]);

function parseFormat(args) {
  let format = "env";
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--format") {
      format = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--format=")) {
      format = arg.slice("--format=".length);
    } else {
      rest.push(arg);
    }
  }
  return { format, rest };
}

function formatCredentials(creds, format) {
  switch (format) {
    case "json":
      return JSON.stringify(creds, null, 2);
    case "shell":
      return creds.exportSnippet;
    case "env":
      return (
        creds.envSnippet ||
        `CONVEX_SELF_HOSTED_URL=${quoteEnvValue(creds.convexUrl)}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${quoteEnvValue(creds.adminKey)}`
      );
    default:
      throw new Error("format must be one of: env, shell, json");
  }
}

module.exports = {
  name: "credentials",
  summary: "Print a deployment's CONVEX_SELF_HOSTED_* pair in env/shell/json form.",
  usage: "synapse credentials <deployment> [--format env|shell|json]",
  description: `Hits /v1/deployments/{name}/cli_credentials and renders the result. No local file is written — pipe the output where you want it.

Formats:
  env    KEY=value pairs, single-quoted (default; .env.local-ready)
  shell  export KEY=value pairs (paste into a shell or eval $(...))
  json   the full response body, including envSnippet/exportSnippet`,

  // Re-exported for legacy test imports; the dispatcher path doesn't
  // need either helper directly.
  formatCredentials,
  parseFormat,

  async run(args, ctx) {
    const { format, rest } = parseFormat(args);
    const deployment = rest[0];
    if (!deployment) {
      throw new Error("Usage: synapse credentials <deployment> [--format env|shell|json]");
    }
    if (!FORMATS.has(format)) {
      throw new Error("format must be one of: env, shell, json");
    }
    const creds = await ctx.api.cliCredentials(deployment);
    if (format === "json") {
      // json format already prints the structured response; keep raw
      // CLI output identical to pre-refactor (stdout, no newline tax).
      ctx.out.result(creds, (d, { stdout }) =>
        stdout.write(formatCredentials(d, "json") + "\n"),
      );
      return;
    }
    // env/shell — emit the snippet verbatim to stdout.
    ctx.out.result(creds, (d, { stdout }) =>
      stdout.write(formatCredentials(d, format) + "\n"),
    );
  },
};
