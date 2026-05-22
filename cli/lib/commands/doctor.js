// `synapse doctor` — the health-check battery. Walks ~12 checks
// across 4 categories (local-env, project, backend, deployments)
// in parallel where possible, then renders a panorama.
//
// Output is either a pretty terminal report (default) or a stable
// machine-readable JSON tree (--json). Exit codes: 0 ok, 1 warnings
// only, 2 at least one issue.

const path = require("node:path");
const os = require("node:os");
const { configPath } = require("../config");
const { generateReport, SCHEMA_VERSION } = require("../doctor/runner");
const { renderReport } = require("../doctor/renderer");

function parseFlags(args) {
  let fix = false;
  let yes = false;
  let verbose = false;
  const rest = [];
  for (const a of args) {
    if (a === "--fix") fix = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--verbose" || a === "-v") verbose = true;
    else rest.push(a);
  }
  return { fix, yes, verbose, rest };
}

module.exports = {
  name: "doctor",
  summary: "Run a health-check panorama on your local setup + Synapse backend + deployments.",
  usage: "synapse doctor [--fix] [--yes] [--verbose] [--json]",
  description: `Runs ~12 checks across local environment, project metadata, backend connectivity, and per-deployment health. Reports each check, the bottom-line totals, and exits with status:

  0  everything ok
  1  at least one warning (still functional)
  2  at least one issue (probably blocks your next deploy)

Flags:
  --fix       apply safe fixes automatically (chmod, gitignore appends, etc).
              Checks marked 'prompt' require --yes too.
  --yes       upgrade 'prompt' fixes to auto.
  --verbose   show detailed data per check.
  --json      stable schema (current: v${SCHEMA_VERSION}); CI-friendly.

The --json output schema is documented in cli/schema/doctor-v${SCHEMA_VERSION}.json.`,

  async run(args, ctx) {
    const { fix, yes, verbose } = parseFlags(args);
    // Build doctor's ctx — augment the dispatcher ctx with helpers
    // checks expect (cfgPath for the home config, env for shell vars).
    let api = null;
    try {
      // ctx.api throws if not logged in; we want checks to handle the
      // "not logged in" case gracefully via cfgOrNull, so build the
      // api lazily and only when we have a session.
      if (ctx.cfgOrNull && ctx.cfgOrNull.accessToken) {
        api = ctx.api;
      }
    } catch {
      api = null;
    }

    const doctorCtx = {
      cwd: ctx.cwd,
      env: ctx.env,
      cfg: ctx.cfgOrNull,
      api,
      projectConfig: ctx.projectConfig,
      cfgPath: configPath(),
      homedir: os.homedir(),
    };

    const report = await generateReport(doctorCtx, { fix, allowPrompt: yes });

    ctx.out.result(report, (d, { stdout }) => {
      renderReport(d, { stdout, verbose });
    });

    process.exitCode = report.exitCode;
  },
};
