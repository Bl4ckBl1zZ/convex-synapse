// Shared helpers for v1.8.7 control-plane commands.
//
// Every command in the new "Deployments" + "Env vars" sections needs
// to resolve a target project — either from the linked `.synapse/
// project.json` (no flag) or from an explicit `--project=<id>` / team
// flag (CI / scripted runs). Centralising the logic here keeps the
// commands themselves slim and gives us one place to update if the
// resolution rules change.

// Extracts `--project=<id>` / `--project <id>` from argv. Returns the
// id (or null) plus the remaining args. We accept the equals form
// and the space-separated form — operators copy-paste from various
// shells.
function extractProjectFlag(args) {
  const rest = [];
  let projectId = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--project") {
      projectId = args[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--project=")) {
      projectId = a.slice("--project=".length);
      continue;
    }
    rest.push(a);
  }
  return { projectId, rest };
}

// Same shape as extractProjectFlag for --team. team flag accepts either
// a slug or an id (backend's loadTeamForRequest accepts both).
function extractTeamFlag(args) {
  const rest = [];
  let teamRef = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--team") {
      teamRef = args[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--team=")) {
      teamRef = a.slice("--team=".length);
      continue;
    }
    rest.push(a);
  }
  return { teamRef, rest };
}

// Generic flag extractor. Boolean flags (no value) and string flags
// (with `--name=value` form) must be DECLARED separately so the parser
// never has to guess whether `--default value-stays` means
// `default=true, positional=value-stays` (operator intent) or
// `default=value-stays` (greedy heuristic).
//
// Both spec shapes are accepted:
//   extractFlags(args, ["foo", "bar"])
//       → all flags string-or-true (legacy form; used by single-arg
//       parsers that don't have boolean/string ambiguity)
//   extractFlags(args, { string: ["type"], boolean: ["ha", "yes"] })
//       → strict: boolean flags NEVER consume the next token; string
//       flags require `--name=value` OR `--name <value>` (next-token).
//
// Unknown flags stay in `rest` (commands surface them with a Usage
// error).
function extractFlags(args, spec) {
  let stringSet;
  let booleanSet;
  if (Array.isArray(spec)) {
    // Legacy shape — keep the v1.8.x behaviour for `parseFlags`-style
    // call sites that don't differentiate.
    stringSet = new Set(spec);
    booleanSet = new Set();
  } else {
    stringSet = new Set(spec.string || []);
    booleanSet = new Set(spec.boolean || []);
  }
  const known = (n) => stringSet.has(n) || booleanSet.has(n);

  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (known(name)) {
        if (eq >= 0) {
          // --name=value: always string (a boolean flag with `=` is
          // unambiguous, e.g. `--yes=false`).
          flags[name] = a.slice(eq + 1);
          continue;
        }
        if (booleanSet.has(name) && !stringSet.has(name)) {
          // Pure boolean. NEVER consumes the next token.
          flags[name] = true;
          continue;
        }
        // String (or legacy-spec) flag without `=`: consume next token
        // if it isn't another flag. Boolean detection via the
        // boolean-set above already short-circuited, so this branch
        // is reached only for explicit string flags.
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[name] = true;
        } else {
          flags[name] = next;
          i += 1;
        }
        continue;
      }
    }
    rest.push(a);
  }
  return { flags, rest };
}

// Resolve the project the command should operate on. Result:
//   { projectId, source: "flag" | "linked", projectConfig?, fallbackError? }
// Throws when neither a flag NOR a linked project is available (the
// error message tells the operator exactly what to do).
function resolveProject(ctx, args) {
  const { projectId, rest } = extractProjectFlag(args);
  if (projectId) {
    return { projectId, source: "flag", rest };
  }
  const linked = ctx.projectConfig;
  if (linked && linked.project && linked.project.id) {
    return {
      projectId: linked.project.id,
      source: "linked",
      projectConfig: linked,
      rest,
    };
  }
  const err = new Error(
    "No linked project in this directory. Pass --project=<id> or run `synapse select` first.",
  );
  err.code = "no_project";
  throw err;
}

module.exports = {
  extractFlags,
  extractProjectFlag,
  extractTeamFlag,
  resolveProject,
};
