const assert = require("node:assert/strict");
const test = require("node:test");
const { PassThrough } = require("node:stream");

const { createOutput, extractJsonFlag } = require("../lib/output");

function capture() {
  const stdoutBuf = [];
  const stderrBuf = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => stdoutBuf.push(c.toString("utf8")));
  stderr.on("data", (c) => stderrBuf.push(c.toString("utf8")));
  return {
    stdout,
    stderr,
    text: () => ({ stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") }),
  };
}

test("output.result in human mode invokes the renderer with the data", () => {
  const cap = capture();
  const out = createOutput({ json: false, stdout: cap.stdout, stderr: cap.stderr });
  out.result({ greeting: "hi" }, (d, { stdout }) => stdout.write(`hello ${d.greeting}\n`));
  assert.equal(cap.text().stdout, "hello hi\n");
  assert.equal(cap.text().stderr, "");
});

test("output.result in --json mode emits one JSON line and skips the renderer", () => {
  const cap = capture();
  const out = createOutput({ json: true, stdout: cap.stdout, stderr: cap.stderr });
  let renderCalled = false;
  out.result({ a: 1, b: [2, 3] }, () => {
    renderCalled = true;
  });
  assert.equal(renderCalled, false);
  assert.equal(cap.text().stdout, '{"a":1,"b":[2,3]}\n');
});

test("output.info/warn are suppressed in --json mode (stream stays parse-clean)", () => {
  const cap = capture();
  const out = createOutput({ json: true, stdout: cap.stdout, stderr: cap.stderr });
  out.info("progress 1");
  out.warn("watch out");
  out.result({ ok: true }, () => {});
  // No stderr output in JSON mode, no human-mode strings leaking.
  assert.equal(cap.text().stderr, "");
  assert.equal(cap.text().stdout, '{"ok":true}\n');
});

test("output.error in --json mode emits {error, hint} to stderr", () => {
  const cap = capture();
  const out = createOutput({ json: true, stdout: cap.stdout, stderr: cap.stderr });
  out.error("boom", { hint: "try again" });
  assert.equal(cap.text().stdout, "");
  assert.deepEqual(JSON.parse(cap.text().stderr), { error: "boom", hint: "try again" });
});

test("output.error in human mode prefixes with 'Error:' and shows hint on a new line", () => {
  const cap = capture();
  const out = createOutput({ json: false, stdout: cap.stdout, stderr: cap.stderr });
  out.error("boom", { hint: "try again" });
  // We don't assert ANSI codes — they depend on isTTY. Match prefixes.
  assert.match(cap.text().stderr, /Error: .*boom/);
  assert.match(cap.text().stderr, /Hint: .*try again/);
});

test("extractJsonFlag pulls --json out of any position", () => {
  assert.deepEqual(extractJsonFlag([]), { json: false, rest: [] });
  assert.deepEqual(extractJsonFlag(["--json"]), { json: true, rest: [] });
  assert.deepEqual(extractJsonFlag(["foo", "--json", "bar"]), { json: true, rest: ["foo", "bar"] });
  assert.deepEqual(extractJsonFlag(["--json-foo"]), { json: false, rest: ["--json-foo"] });
});
