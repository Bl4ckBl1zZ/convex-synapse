// `synapse env set NAME=value [NAME2=value2 ...] [--for=dev,prod] [--project=<id>] [--json]`
//
// Batch-sets project-default env vars. Multiple positionals = single
// transactional update on the backend (the handler wraps the whole
// `changes` array in a BEGIN/COMMIT). If any value is rejected the
// whole batch rolls back.
//
// Value parsing: split on the FIRST `=`. So `FOO=a=b` sets FOO to "a=b".
// Names must match /^[A-Z_][A-Z0-9_]*$/ — same shape the Convex backend
// accepts (uppercase letters, digits, underscore; leading non-digit).

const colors = require("../colors");
const { extractFlags, resolveProject } = require("./_resource");

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const VALID_FORS = new Set(["dev", "prod", "preview"]);

// Splits `NAME=value` on the FIRST `=`. Returns { name, value } or
// throws when the shape is wrong. Empty value is OK ("FOO=" sets to "").
function parsePair(arg) {
  const eq = arg.indexOf("=");
  if (eq <= 0) {
    throw new Error(
      `Invalid env assignment: ${JSON.stringify(arg)}. Expected NAME=value.`,
    );
  }
  const name = arg.slice(0, eq);
  const value = arg.slice(eq + 1);
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid env name: ${JSON.stringify(name)}. Names must match [A-Z_][A-Z0-9_]*.`,
    );
  }
  return { name, value };
}

// Comma-split + trim + dedupe a `--for=dev,prod` argument. Empty
// returns null (= "use default"). Errors on unknown types.
function parseFor(raw) {
  if (raw === undefined || raw === null || raw === true) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  const parts = [
    ...new Set(trimmed.split(",").map((s) => s.trim().toLowerCase())),
  ].filter(Boolean);
  for (const p of parts) {
    if (!VALID_FORS.has(p)) {
      throw new Error(
        `Invalid --for entry: ${p}. Must be one of: ${[...VALID_FORS].join(", ")}.`,
      );
    }
  }
  return parts;
}

module.exports = {
  name: "env set",
  summary: "Set one or more project-default environment variables.",
  usage:
    "synapse env set NAME=value [NAME2=value2 ...] [--for=dev,prod] [--project=<id>] [--json]",
  description: `Calls POST /v1/projects/{id}/update_default_environment_variables with op=set. Multiple pairs are applied in a single transaction. Names follow the [A-Z_][A-Z0-9_]* convention; values are byte-preserved (whitespace, quotes, '=' all OK).

Flags:
  --for=dev,prod     Limit the var to specific deploymentTypes
                     (comma-separated). Omitted: backend defaults
                     (typically: all types).
  --project=<id>     Override the linked project.
  --json             Machine-readable output.

Examples:
  synapse env set OPENAI_API_KEY=sk-abc...
  synapse env set FOO=bar BAZ=qux --for=prod
  synapse env set REDIS_URL='rediss://user:pass@host:6379/0'`,

  // Re-exports for tests.
  parsePair,
  parseFor,
  NAME_RE,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: ["for", "project"],
      boolean: ["json"],
    });
    if (rest.length === 0) {
      throw new Error(
        "Usage: synapse env set NAME=value [NAME2=value2 ...] [--for=...]",
      );
    }
    const forList = parseFor(flags.for);
    const pairs = rest.map(parsePair);

    const resolveArgs = flags.project ? [`--project=${flags.project}`] : [];
    const { projectId, source } = resolveProject(ctx, resolveArgs);

    const changes = pairs.map(({ name, value }) => ({
      op: "set",
      name,
      value,
      ...(forList ? { deploymentTypes: forList } : {}),
    }));

    if (!ctx.out.json) {
      ctx.out.info(
        `Setting ${pairs.length} env var${pairs.length > 1 ? "s" : ""} on project ${projectId}${forList ? ` (for: ${forList.join(",")})` : ""}…`,
      );
    }
    await ctx.api.updateProjectEnvVars(projectId, changes);

    ctx.out.result(
      {
        projectId,
        projectSource: source,
        applied: changes.length,
        changes: changes.map((c) => ({ name: c.name, deploymentTypes: c.deploymentTypes ?? null })),
      },
      (_d, { stdout }) => {
        for (const { name } of pairs) {
          stdout.write(`${colors.green("+")} ${colors.bold(name)}\n`);
        }
        stdout.write(
          colors.dim(
            "These defaults are injected into NEW deployments. To apply to existing deployments, run `synapse convex env set` per deployment, or re-create them.\n",
          ),
        );
      },
    );
  },
};
