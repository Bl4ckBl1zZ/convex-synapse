// Command registry + two-word-then-one-word dispatcher.
//
// The CLI ships ~28 commands across both flat shortcuts (`synapse dev`,
// `synapse login`) and resource subcommands (`synapse deployment create`,
// `synapse env set`). A registry keyed by the literal command path
// ("dev" or "deployment create") makes routing predictable, keeps each
// handler in its own file, and avoids a 2k-line nested switch.
//
// Resolution order, applied left-to-right against argv:
//   1. Two-word lookup ("deployment create") — wins when present so
//      subcommand groups override any bare top-level synonym.
//   2. One-word lookup ("dev") — falls through for legacy shortcuts.
//   3. Miss → caller surfaces "unknown command" with help.
//
// Each command module exports:
//   {
//     name:        string,    // canonical id, e.g. "deployment create"
//     summary:     string,    // 1-line description for root help
//     usage:       string,    // exact usage line for per-command help
//     description?: string,   // multi-paragraph help body
//     run:         async (rest, ctx) => void | number
//   }
//
// `ctx` is the runtime context (see context.js) — gives every handler
// access to the resolved config, an API client, the output layer, and
// process I/O without each one re-bootstrapping.

const fs = require("node:fs");
const path = require("node:path");

function buildRegistry() {
  const dir = __dirname;
  const map = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    if (file.startsWith("_")) continue; // dispatcher.js, context.js, etc
    if (file === "index.js") continue;
    const mod = require(path.join(dir, file));
    // A module exports either ONE command ({ name, run }) or, for a related
    // family (e.g. the Cell Control Plane group), an ARRAY of commands — or
    // `{ commands: [...] }`. This keeps a 30-command family in ~6 files instead
    // of 30 one-liners, without a nested switch.
    const commands = Array.isArray(mod)
      ? mod
      : Array.isArray(mod && mod.commands)
        ? mod.commands
        : [mod];
    for (const cmd of commands) {
      if (!cmd || typeof cmd.name !== "string" || typeof cmd.run !== "function") {
        throw new Error(
          `commands/${file} does not export the { name, run } shape`,
        );
      }
      if (map.has(cmd.name)) {
        throw new Error(
          `Duplicate command registered: ${cmd.name} (in ${file})`,
        );
      }
      map.set(cmd.name, cmd);
    }
  }
  return map;
}

// Resolve argv into { cmd, rest } using the two-then-one rule.
// Returns { cmd: null, rest: argv } on miss so the caller can surface
// the unknown-command error consistently.
function resolve(registry, argv) {
  if (!argv || argv.length === 0) return { cmd: null, rest: argv ?? [] };
  if (argv.length >= 2) {
    const two = `${argv[0]} ${argv[1]}`;
    if (registry.has(two)) return { cmd: registry.get(two), rest: argv.slice(2) };
  }
  if (registry.has(argv[0])) return { cmd: registry.get(argv[0]), rest: argv.slice(1) };
  return { cmd: null, rest: argv };
}

// Detect `--help` / `-h` anywhere in the args (positional-tolerant).
// Returns boolean; doesn't mutate argv — handlers don't see the flag
// because the dispatcher short-circuits to help rendering first.
function wantsHelp(argv) {
  if (!argv) return false;
  return argv.some((a) => a === "--help" || a === "-h");
}

module.exports = { buildRegistry, resolve, wantsHelp };
