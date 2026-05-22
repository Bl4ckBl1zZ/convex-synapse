// `synapse env push [--from=<path>] [--for=<types>] [--project=<id>]
//                   [--dry-run] [--yes] [--json]`
//
// Reads a .env-shaped file and applies it to the project's defaults
// via op=set on every entry. `--dry-run` prints the diff and exits
// without calling the backend (RECOMMENDED on first push).
//
// Safety:
//   - Refuses to push CONVEX_SELF_HOSTED_URL / CONVEX_SELF_HOSTED_ADMIN_KEY
//     (those belong in the operator's local .env.local, not in the
//     project-default surface that gets injected into containers).
//   - Refuses to push NEXT_PUBLIC_CONVEX_URL / SITE_URL for the same
//     reason — they're managed by `synapse select`.
//   - Without --yes the command shows a diff and prompts.

const fs = require("node:fs");
const colors = require("../colors");
const { extractFlags, resolveProject } = require("./_resource");
const { parseEnvContent } = require("../env-file");
const { confirm } = require("../prompts");

// Names that MUST NEVER land in the project-default surface. A push
// that includes any of these is rejected before any backend call.
const DENY_LIST = new Set([
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_DEPLOYMENT",
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_SITE_URL",
]);

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const VALID_FORS = new Set(["dev", "prod", "preview"]);

function diffEnv(currentConfigs, parsed) {
  const current = new Map();
  for (const c of currentConfigs) current.set(c.name, c.value);
  const added = [];
  const changed = [];
  const unchanged = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!current.has(name)) {
      added.push({ name, value });
      continue;
    }
    if (current.get(name) !== value) {
      changed.push({ name, value, from: current.get(name) });
      continue;
    }
    unchanged.push({ name, value });
  }
  return { added, changed, unchanged };
}

module.exports = {
  name: "env push",
  summary: "Apply a .env-shaped file to project-default env vars.",
  usage:
    "synapse env push [--from=<path>] [--for=<types>] [--project=<id>] [--dry-run] [--yes] [--json]",
  description: `Reads a .env file and sets each NAME=value as a project-default env var (op=set in batch). Best practice: run with --dry-run FIRST to see what would change.

The file format is the same one \`synapse env pull\` writes. Quoted values, comments, blank lines, and \`export\` prefixes are all tolerated.

The following names are REJECTED with an error (they live in .env.local, not in the project-default surface):
  CONVEX_SELF_HOSTED_URL, CONVEX_SELF_HOSTED_ADMIN_KEY,
  CONVEX_DEPLOYMENT, NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_CONVEX_SITE_URL

Flags:
  --from=<path>      File to read (default: .env in current dir).
  --for=dev,prod     Stamp the listed deploymentTypes on each var.
  --project=<id>     Override the linked project.
  --dry-run          Show the diff and exit; no backend call.
  --yes              Skip the y/N confirmation prompt.
  --json             Machine-readable output.

Examples:
  synapse env push --from=.env.synapse --dry-run
  synapse env push --from=.env.prod --for=prod --yes`,

  // Re-exports for tests.
  diffEnv,
  DENY_LIST,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: ["from", "for", "project"],
      boolean: ["dry-run", "yes", "json"],
    });
    if (rest.length > 0) {
      throw new Error(`Unexpected positional: ${rest[0]}.`);
    }
    const path = typeof flags.from === "string" ? flags.from : ".env";
    if (!fs.existsSync(path)) {
      throw new Error(
        `File not found: ${path}. Pass --from=<path> or create one with \`synapse env pull\`.`,
      );
    }
    const dryRun = flags["dry-run"] === true || flags["dry-run"] === "true";
    const yes = flags.yes === true || flags.yes === "true";

    // Parse --for. Empty = backend default behaviour (no array sent).
    let forList = null;
    if (typeof flags.for === "string" && flags.for.trim() !== "") {
      forList = [
        ...new Set(flags.for.split(",").map((s) => s.trim().toLowerCase())),
      ].filter(Boolean);
      for (const f of forList) {
        if (!VALID_FORS.has(f)) {
          throw new Error(
            `Invalid --for entry: ${f}. Must be one of: ${[...VALID_FORS].join(", ")}.`,
          );
        }
      }
    }

    const parsed = parseEnvContent(fs.readFileSync(path, "utf8"));
    // Reject denied names BEFORE any backend call. Surface ALL of them
    // so the operator can fix the file once instead of N times.
    const violations = Object.keys(parsed).filter((n) => DENY_LIST.has(n));
    if (violations.length > 0) {
      throw new Error(
        `Refusing to push: ${violations.join(", ")} are reserved (live in .env.local, not in project-default env). Remove them from ${path} first.`,
      );
    }
    // Validate name shape.
    for (const name of Object.keys(parsed)) {
      if (!NAME_RE.test(name)) {
        throw new Error(
          `Invalid env name in ${path}: ${JSON.stringify(name)}. Must match [A-Z_][A-Z0-9_]*.`,
        );
      }
    }

    const resolveArgs = flags.project ? [`--project=${flags.project}`] : [];
    const { projectId, source } = resolveProject(ctx, resolveArgs);

    const current = await ctx.api.listProjectEnvVars(projectId);
    const diff = diffEnv(current.configs || [], parsed);

    // Dry-run: show diff and exit.
    if (dryRun) {
      ctx.out.result(
        {
          projectId,
          projectSource: source,
          file: path,
          dryRun: true,
          ...diff,
        },
        (_d, { stdout }) => {
          stdout.write(colors.dim(`Project: ${projectId}  ·  source: ${path}\n`));
          if (diff.added.length === 0 && diff.changed.length === 0) {
            stdout.write(colors.dim("(nothing to do — file matches current state)\n"));
            return;
          }
          for (const a of diff.added) {
            stdout.write(`${colors.green("+")} ${colors.bold(a.name)}\n`);
          }
          for (const c of diff.changed) {
            stdout.write(`${colors.yellow("~")} ${colors.bold(c.name)}\n`);
          }
          if (diff.unchanged.length > 0) {
            stdout.write(colors.dim(`(${diff.unchanged.length} unchanged)\n`));
          }
          stdout.write(colors.dim("\nDry-run — no changes applied. Re-run without --dry-run to push.\n"));
        },
      );
      return;
    }

    // Real push. Confirm in human mode unless --yes; refuse in
    // --json mode unless --yes (CI must opt in explicitly).
    const toApply = diff.added.length + diff.changed.length;
    if (toApply === 0) {
      ctx.out.result(
        {
          projectId,
          projectSource: source,
          file: path,
          applied: 0,
          ...diff,
        },
        (_d, { stdout }) =>
          stdout.write(colors.dim("Nothing to push — file matches current state.\n")),
      );
      return;
    }
    if (!yes && ctx.out.json) {
      throw new Error(
        `Refusing to push ${toApply} change${toApply > 1 ? "s" : ""} in --json mode without --yes.`,
      );
    }
    if (!yes && !ctx.out.json) {
      ctx.out.info(`About to apply ${toApply} change${toApply > 1 ? "s" : ""}:`);
      for (const a of diff.added) ctx.out.info(`  + ${a.name}`);
      for (const c of diff.changed) ctx.out.info(`  ~ ${c.name}`);
      const confirmed = await confirm(
        `Push to project ${projectId}? [y/N] `,
        { defaultAnswer: false },
      );
      if (!confirmed) {
        ctx.out.info("Aborted.");
        process.exitCode = 1;
        return;
      }
    }

    const changes = [];
    for (const a of diff.added) {
      changes.push({
        op: "set",
        name: a.name,
        value: a.value,
        ...(forList ? { deploymentTypes: forList } : {}),
      });
    }
    for (const c of diff.changed) {
      changes.push({
        op: "set",
        name: c.name,
        value: c.value,
        ...(forList ? { deploymentTypes: forList } : {}),
      });
    }
    await ctx.api.updateProjectEnvVars(projectId, changes);

    ctx.out.result(
      {
        projectId,
        projectSource: source,
        file: path,
        applied: changes.length,
        ...diff,
      },
      (_d, { stdout }) => {
        for (const a of diff.added) {
          stdout.write(`${colors.green("+")} ${colors.bold(a.name)}\n`);
        }
        for (const c of diff.changed) {
          stdout.write(`${colors.yellow("~")} ${colors.bold(c.name)}\n`);
        }
        if (diff.unchanged.length > 0) {
          stdout.write(colors.dim(`(${diff.unchanged.length} unchanged)\n`));
        }
      },
    );
  },
};
