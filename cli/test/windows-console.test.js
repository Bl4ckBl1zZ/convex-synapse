const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureUtf8Console,
  containsReplacementChar,
  __testing__,
  UTF8_CODE_PAGE,
} = require("../lib/windows-console");

// parseCodePage --------------------------------------------------------

test("parseCodePage: parses English chcp output", () => {
  assert.equal(__testing__.parseCodePage("Active code page: 850\n"), 850);
});

test("parseCodePage: parses pt-BR localised output", () => {
  // Brazilian Windows reports the chcp result in Portuguese; we only
  // care about the trailing integer, which the regex catches regardless
  // of the surrounding language.
  assert.equal(
    __testing__.parseCodePage("Página de código ativa: 1252\r\n"),
    1252,
  );
});

test("parseCodePage: parses German output", () => {
  assert.equal(__testing__.parseCodePage("Aktive Codepage: 65001"), 65001);
});

test("parseCodePage: returns null on empty / nonsense input", () => {
  assert.equal(__testing__.parseCodePage(""), null);
  assert.equal(__testing__.parseCodePage(null), null);
  assert.equal(__testing__.parseCodePage("no digits here"), null);
});

test("parseCodePage: grabs the FIRST run of digits (defensive)", () => {
  assert.equal(__testing__.parseCodePage("xyz 850 abc 1252"), 850);
});

// containsReplacementChar ---------------------------------------------

test("containsReplacementChar: spots U+FFFD", () => {
  assert.equal(containsReplacementChar("hello"), false);
  assert.equal(containsReplacementChar("hellö"), false);
  assert.equal(containsReplacementChar("hell�o"), true);
  assert.equal(containsReplacementChar("�"), true);
});

test("containsReplacementChar: handles non-string input defensively", () => {
  assert.equal(containsReplacementChar(null), false);
  assert.equal(containsReplacementChar(undefined), false);
  assert.equal(containsReplacementChar(123), false);
  assert.equal(containsReplacementChar({}), false);
});

// ensureUtf8Console ---------------------------------------------------
// We can't actually exercise chcp from a Linux test box, so we just
// verify the no-op on non-Windows path returns the right shape and
// doesn't try to spawn anything. The Windows branches are exercised
// via the smoke test described in PR notes.

test("ensureUtf8Console: returns not-windows on linux/mac without spawning chcp", () => {
  // Sanity: the test runner itself is not Windows.
  assert.notEqual(process.platform, "win32");
  const r = ensureUtf8Console();
  assert.equal(r.changed, false);
  assert.equal(r.reason, "not-windows");
});

test("ensureUtf8Console: idempotent — subsequent calls return cached result", () => {
  const r1 = ensureUtf8Console();
  const r2 = ensureUtf8Console();
  // Same object identity confirms we hit the `if (attempted)` early-return.
  assert.strictEqual(r1, r2);
});

test("UTF8_CODE_PAGE is 65001 (Windows convention)", () => {
  assert.equal(UTF8_CODE_PAGE, 65001);
});
