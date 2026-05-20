const assert = require("node:assert/strict");
const test = require("node:test");
const { PassThrough } = require("node:stream");

const { BACK, choose, confirm, parseCredentialsInput } = require("../lib/prompts");

// scriptedStdin returns a PassThrough that streams `lines` one at a time,
// each on its own tick. We can't pre-write the whole transcript because
// readline.question only consumes data after the call is queued — writes
// that arrive earlier get partly buffered in a way that traps subsequent
// question() calls. Feeding one line per setImmediate gives the consumer
// time to register its handler before each line arrives.
function scriptedStdin(lines, { isTTY = true } = {}) {
  const stream = new PassThrough();
  Object.defineProperty(stream, "isTTY", { value: isTTY, configurable: true });
  let idx = 0;
  function feedNext() {
    if (idx >= lines.length) return;
    setImmediate(() => {
      stream.write(lines[idx++] + "\n");
      feedNext();
    });
  }
  feedNext();
  return stream;
}

function makeStderr() {
  const buffer = [];
  const stream = new PassThrough();
  stream.on("data", (chunk) => buffer.push(chunk.toString("utf8")));
  return { stream, text: () => buffer.join("") };
}

test("parseCredentialsInput reads email and password from piped stdin text", () => {
  assert.deepEqual(parseCredentialsInput("ian@example.com\nstrongpass123\n"), {
    email: "ian@example.com",
    password: "strongpass123",
  });
});

test("parseCredentialsInput preserves password spaces", () => {
  assert.deepEqual(parseCredentialsInput(" ian@example.com \n pass with spaces \n"), {
    email: "ian@example.com",
    password: " pass with spaces ",
  });
});

test("confirm accepts y / yes / Y as true", async () => {
  for (const reply of ["y", "yes", "Y", "Yes"]) {
    const out = makeStderr();
    const result = await confirm("Continue? ", {
      input: scriptedStdin([reply]),
      output: out.stream,
      defaultAnswer: false,
    });
    assert.equal(result, true, `reply=${JSON.stringify(reply)}`);
  }
});

test("confirm accepts n / no / N as false", async () => {
  for (const reply of ["n", "no", "N", "No"]) {
    const out = makeStderr();
    const result = await confirm("Continue? ", {
      input: scriptedStdin([reply]),
      output: out.stream,
      defaultAnswer: true,
    });
    assert.equal(result, false, `reply=${JSON.stringify(reply)}`);
  }
});

test("confirm returns defaultAnswer on empty input", async () => {
  const out1 = makeStderr();
  const yes = await confirm("? ", { input: scriptedStdin([""]), output: out1.stream, defaultAnswer: true });
  assert.equal(yes, true);
  const out2 = makeStderr();
  const no = await confirm("? ", { input: scriptedStdin([""]), output: out2.stream, defaultAnswer: false });
  assert.equal(no, false);
});

test("confirm re-prompts on garbage and resolves on the retry", async () => {
  const out = makeStderr();
  const result = await confirm("? ", {
    input: scriptedStdin(["maybe", "nope", "yes"]),
    output: out.stream,
    defaultAnswer: false,
  });
  assert.equal(result, true);
  assert.match(out.text(), /Please answer y or n\./);
});

test("confirm gives up after maxAttempts of garbage", async () => {
  const out = makeStderr();
  await assert.rejects(
    () => confirm("? ", {
      input: scriptedStdin(["a", "b", "c", "d", "e"]),
      output: out.stream,
      defaultAnswer: false,
      maxAttempts: 3,
    }),
    /too many invalid answers/,
  );
});

test("choose auto-selects with singular label, not the plural header", async () => {
  const out = makeStderr();
  const picked = await choose(
    "teams",
    [{ label: "Only Team", value: "only" }],
    { input: scriptedStdin([]), output: out.stream, singularLabel: "team" },
  );
  assert.equal(picked, "only");
  assert.match(out.text(), /Auto-selected team: Only Team \(only one available\)/);
  // The plural header is reserved for the multi-option menu, never the
  // auto-select line — guards against the "Using projects: ingreis" bug.
  assert.doesNotMatch(out.text(), /Auto-selected teams/);
});

test("choose picks the menu item by 1-based index", async () => {
  const out = makeStderr();
  const picked = await choose(
    "teams",
    [
      { label: "Alpha", value: "a" },
      { label: "Beta", value: "b" },
    ],
    { input: scriptedStdin(["2"]), output: out.stream },
  );
  assert.equal(picked, "b");
});

test("choose returns the BACK sentinel when allowBack is on and user types b", async () => {
  for (const reply of ["b", "B", "back", "0"]) {
    const out = makeStderr();
    const picked = await choose(
      "projects",
      [
        { label: "Alpha", value: "a" },
        { label: "Beta", value: "b" },
      ],
      {
        input: scriptedStdin([reply]),
        output: out.stream,
        allowBack: true,
      },
    );
    assert.equal(picked, BACK, `reply=${JSON.stringify(reply)}`);
    assert.match(out.text(), /\[1-2, b=back\]/);
  }
});

test("choose ignores back tokens when allowBack is off", async () => {
  const out = makeStderr();
  const picked = await choose(
    "projects",
    [
      { label: "Alpha", value: "a" },
      { label: "Beta", value: "b" },
    ],
    {
      input: scriptedStdin(["b", "2"]),
      output: out.stream,
      allowBack: false,
    },
  );
  assert.equal(picked, "b");
  // Hint hides the back token entirely.
  assert.doesNotMatch(out.text(), /b=back/);
});

test("choose throws after maxInvalid garbage answers", async () => {
  const out = makeStderr();
  await assert.rejects(
    () => choose(
      "teams",
      [
        { label: "Alpha", value: "a" },
        { label: "Beta", value: "b" },
      ],
      {
        input: scriptedStdin(["x", "y", "z", "w"]),
        output: out.stream,
        maxInvalid: 3,
      },
    ),
    /Cancelled teams prompt after 3 invalid answers/,
  );
});
