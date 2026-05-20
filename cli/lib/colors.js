// Zero-dependency ANSI helpers. Each helper returns its argument as-is when
// the terminal does not support colour (stdout is not a TTY) or the user
// opted out via NO_COLOR (https://no-color.org). Checked at call time, not
// at require time, so tests that toggle `process.env.NO_COLOR` or that run
// under `node --test` (no TTY) get plain output without further wiring.
//
// We deliberately do not depend on `chalk` / `kleur` / etc — the @iann29/
// synapse package ships zero runtime deps, and a handful of escape codes
// don't justify breaking that.

function enabled(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true") return true;
  return Boolean(stream && stream.isTTY);
}

function wrap(code) {
  return (value, stream) =>
    enabled(stream) ? `\x1b[${code}m${value}\x1b[0m` : String(value);
}

// Renders the status portion of a deployment row. `running` reads as success,
// `failed` as error, `provisioning` as in-flight, anything else as dim noise.
// Falls through to the plain string when colour is off so logs grep cleanly.
function statusBadge(status, stream) {
  switch (status) {
    case "running":
      return module.exports.green(status, stream);
    case "failed":
    case "errored":
      return module.exports.red(status, stream);
    case "provisioning":
      return module.exports.yellow(status, stream);
    case "stopped":
    case "deleted":
      return module.exports.dim(status, stream);
    default:
      return String(status || "");
  }
}

module.exports = {
  enabled,
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
  statusBadge,
};
