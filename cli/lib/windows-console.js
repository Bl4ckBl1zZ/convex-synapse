// Windows console encoding helper. v1.8.10.
//
// THE BUG:
//   On Windows PowerShell / cmd, `process.stdin.setRawMode(true)` reads
//   bytes from the console using the active *code page* — typically
//   CP-1252 (Western Latin-1) or CP-850 (legacy OEM). Our prompts code
//   does `buffer.toString("utf8")` to decode those bytes, which
//   silently corrupts any non-ASCII character into U+FFFD (the Unicode
//   replacement char). For an operator whose password contains
//   `ç`, `ã`, `é`, `ñ`, etc., the password sent to the backend differs
//   from what they typed — `bcrypt.compare` fails and the operator
//   sees "Email or password is incorrect" no matter how many times
//   they retype it correctly. The dashboard works because the browser
//   handles encoding internally and submits proper UTF-8.
//
// THE FIX:
//   Force the console to UTF-8 (code page 65001) before any prompt
//   runs. After this, both `ReadConsoleA` (the Win32 call Node uses
//   under the hood) and `buffer.toString("utf8")` agree on the byte
//   meaning. Pure-ASCII passwords were never affected because every
//   relevant code page is ASCII-compatible for bytes 0x00–0x7F.
//
// SIDE EFFECTS WE ACCEPT:
//   `chcp 65001` switches the *parent shell's* code page for the
//   remainder of the session. We don't restore on exit — restoring
//   would require running another chcp after every command which is
//   awkward, and most operators want UTF-8 anyway in 2026. We log a
//   one-line notice on first use so the operator isn't surprised.

const { execSync } = require("node:child_process");

const UTF8_CODE_PAGE = 65001;
let attempted = false;
let result = null;

// ensureUtf8Console runs `chcp 65001` once per process on Windows. No-op
// on macOS / Linux. Idempotent — subsequent calls return the cached
// result. Best-effort: any failure (chcp not on PATH, no console
// attached, etc) is swallowed and the caller proceeds as before.
function ensureUtf8Console({ logger } = {}) {
  // Always go through the idempotency gate so the not-windows /
  // already-utf8 / changed paths all share a single cached result.
  // Tests rely on object identity equality of repeated calls.
  if (attempted) return result;
  attempted = true;
  if (process.platform !== "win32") {
    result = { changed: false, reason: "not-windows" };
    return result;
  }

  try {
    // Capture current code page so we can tell if we actually changed
    // anything. `chcp` with no args prints "Active code page: NNN".
    const before = parseCodePage(safeExec("chcp"));
    if (before === UTF8_CODE_PAGE) {
      result = { changed: false, reason: "already-utf8", before };
      return result;
    }
    // `>NUL` suppresses chcp's own confirmation line on success.
    safeExec(`chcp ${UTF8_CODE_PAGE} >NUL`);
    result = { changed: true, before, after: UTF8_CODE_PAGE };
    if (logger && typeof logger.info === "function") {
      logger.info(
        `(Windows: switched console code page ${before} → ${UTF8_CODE_PAGE} so non-ASCII input round-trips correctly. Stays UTF-8 until you close this shell.)`,
      );
    }
    return result;
  } catch (err) {
    result = { changed: false, reason: "exec-failed", error: String(err && err.message ? err.message : err) };
    return result;
  }
}

// safeExec runs a command and returns its stdout as a string, throwing
// on non-zero exit. Encoding "utf8" is fine because chcp's output is
// pure ASCII regardless of the active code page.
function safeExec(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
}

// parseCodePage extracts the integer from chcp's localised "Active code
// page: NNN" output. Localisation is real — Brazilian Windows reports
// "Página de código ativa: 1252", German is "Aktive Codepage: 1252",
// etc. We just grab the first run of digits so the parser doesn't
// depend on the language string.
function parseCodePage(stdout) {
  if (!stdout) return null;
  const m = stdout.match(/\d+/);
  return m ? Number.parseInt(m[0], 10) : null;
}

// containsReplacementChar returns true if `s` includes the Unicode
// replacement character. Used by the prompts layer to detect a
// post-fix-failure-mode case where stdin was still misdecoded and warn
// the operator concretely instead of returning a corrupted string.
function containsReplacementChar(s) {
  return typeof s === "string" && s.includes("�");
}

module.exports = {
  ensureUtf8Console,
  containsReplacementChar,
  // Exposed for tests.
  __testing__: { parseCodePage },
  UTF8_CODE_PAGE,
};
