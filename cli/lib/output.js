// Shared output layer for every synapse CLI command.
//
// Every handler writes through `createOutput()` instead of poking
// process.stdout directly. This is the only thing that makes `--json`
// honest: in JSON mode the renderer never emits ANSI codes, partial
// human strings, or stray progress lines that would corrupt a piped
// script's parse.
//
// Contract:
//   - `result(data, renderHuman)` is THE command result. In JSON mode
//     emits `JSON.stringify(data)` to stdout. In human mode invokes
//     renderHuman(data, ctx).
//   - `info`/`warn` are side-channel status (progress, hints). They go
//     to stderr and are SUPPRESSED entirely in JSON mode so a piped
//     `--json` stream stays parse-clean.
//   - `error(msg, { hint })` writes to stderr. In JSON mode emits
//     `{error, hint}` so scripts can branch on it.
//   - `table(rows, columns)` is a small helper that lays out aligned
//     columns in human mode; in JSON mode the caller passes `rows`
//     directly to `result()` instead.

const colors = require("./colors");

function createOutput({
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  function writeOut(s) {
    stdout.write(s);
  }
  function writeErr(s) {
    stderr.write(s);
  }

  return {
    json,
    stdout,
    stderr,

    // The command's structured result. JSON mode emits a single line.
    // Human mode delegates rendering — the renderer is free to write
    // tables, multi-line copy, colors, anything. Callers MUST supply
    // a renderer; commands with no useful human output should pass a
    // no-op (`() => {}`) explicitly so the JSON-vs-human split stays
    // obvious in code review.
    result(data, renderHuman) {
      if (this.json) {
        writeOut(JSON.stringify(data) + "\n");
        return;
      }
      renderHuman(data, { stdout, stderr });
    },

    // Progress / status. Suppressed under --json so a piped consumer
    // never sees mixed JSON and prose on stdout.
    info(msg) {
      if (this.json) return;
      writeErr(msg + "\n");
    },

    warn(msg) {
      if (this.json) return;
      writeErr(colors.yellow("Warning: ") + msg + "\n");
    },

    // Fatal-ish error message. Returns nothing — callers throw or
    // set process.exitCode on their own to control control flow.
    // The dispatcher's top-level catch is the canonical exit path.
    error(msg, { hint } = {}) {
      if (this.json) {
        writeErr(JSON.stringify({ error: msg, ...(hint ? { hint } : {}) }) + "\n");
        return;
      }
      writeErr(colors.red("Error: ") + msg + "\n");
      if (hint) writeErr(colors.dim("Hint: ") + hint + "\n");
    },

    // Lightweight column-aligned table renderer for human mode.
    // `columns` is [{ key, header, align?, color? }]. `align` is
    // "left" (default) or "right". `color` is a colors.* function
    // applied per-cell after the value is stringified.
    //
    // In JSON mode the function is a no-op — callers should hand the
    // raw rows array to `result()` instead.
    table(rows, columns) {
      if (this.json) return;
      if (!rows || rows.length === 0) {
        writeOut(colors.dim("(no rows)\n"));
        return;
      }
      const widths = columns.map((c) => c.header.length);
      const cells = rows.map((row) =>
        columns.map((c, i) => {
          const raw = row[c.key];
          const text = raw == null ? "" : String(raw);
          if (text.length > widths[i]) widths[i] = text.length;
          return text;
        }),
      );
      const fmt = (text, w, align) =>
        align === "right" ? text.padStart(w) : text.padEnd(w);
      const header = columns
        .map((c, i) => colors.dim(fmt(c.header, widths[i], c.align)))
        .join("  ");
      writeOut(header + "\n");
      writeOut(
        colors.dim(widths.map((w) => "─".repeat(w)).join("  ")) + "\n",
      );
      for (const row of cells) {
        const line = row
          .map((cell, i) => {
            const padded = fmt(cell, widths[i], columns[i].align);
            return columns[i].color ? columns[i].color(padded) : padded;
          })
          .join("  ");
        writeOut(line + "\n");
      }
    },
  };
}

// Detects `--json` from an args vector and returns
// `{ json: boolean, rest: string[] }` so handlers can strip the flag
// before parsing their own positionals. Bash/CI scripts commonly
// pass `--json` in any position; we accept it anywhere.
function extractJsonFlag(argv) {
  const rest = [];
  let json = false;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else {
      rest.push(a);
    }
  }
  return { json, rest };
}

module.exports = { createOutput, extractJsonFlag };
