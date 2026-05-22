const readline = require("node:readline");

// Sentinel returned by `choose` when the user asks to go back to the
// previous step. Use a Symbol so it can never collide with a legitimate
// choice payload.
const BACK = Symbol("synapse-choose-back");

function ask(question, { input = process.stdin, output = process.stderr } = {}) {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    return ask(question, { input, output });
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;

    function cleanup() {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      output.write("\n");
    }

    function onData(buffer) {
      const text = buffer.toString("utf8");
      for (const ch of text) {
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= " ") {
          value += ch;
        }
      }
    }

    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function parseCredentialsInput(text) {
  const lines = String(text || "").split(/\r?\n/);
  return {
    email: (lines[0] || "").trim(),
    password: lines[1] || "",
  };
}

function readAll(input) {
  return new Promise((resolve, reject) => {
    let text = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      text += chunk;
    });
    input.on("error", reject);
    input.on("end", () => resolve(text));
  });
}

async function askCredentials({ input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    const parsed = parseCredentialsInput(await readAll(input));
    if (!parsed.email || !parsed.password) {
      throw new Error("Non-interactive login expects email and password on stdin, one per line.");
    }
    return parsed;
  }
  return {
    email: await ask("Email: ", { input, output }),
    password: await askHidden("Password: ", { input, output }),
  };
}

// confirm prompts the user with a yes/no question and resolves to a boolean.
//
// - Empty answer applies `defaultAnswer` (so `[y/N]` matches "no by default"
//   and `[Y/n]` matches "yes by default"). The hint in the question is the
//   caller's responsibility — we render the prompt literally.
// - "y" / "yes" / "n" / "no" (case-insensitive) are accepted.
// - Anything else re-prompts with a tip, capped at `maxAttempts` to keep
//   pasted-shell-history scenarios from looping forever.
// - Non-interactive callers (no TTY) cannot disambiguate — they must use a
//   skip-confirmation flag at the call site instead of relying on `confirm`.
//
// We open a single readline interface for the whole prompt session.
// Calling `ask()` multiple times would re-create the interface and re-bind
// `data` listeners on the input stream — which is fine for real stdin but
// produces flaky behaviour on a buffered PassThrough where the second
// listener can't see data the first consumed. One rl, multiple questions.
async function confirm(question, {
  input = process.stdin,
  output = process.stderr,
  defaultAnswer = false,
  maxAttempts = 3,
} = {}) {
  const rl = readline.createInterface({ input, output });
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const raw = await new Promise((resolve) => rl.question(question, resolve));
      const answer = raw.trim().toLowerCase();
      if (answer === "") return defaultAnswer;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      output.write("Please answer y or n.\n");
    }
    throw new Error("Confirmation prompt cancelled after too many invalid answers");
  } finally {
    rl.close();
  }
}

// choose prompts the user to pick one of `choices`.
//
// - `label` is the plural noun used for the menu header ("dev deployments").
// - `singularLabel` defaults to `label` stripped of a trailing "s" — it's
//   the noun used when only one option exists and we auto-select silently.
//   Pass a custom value when the strip heuristic produces something
//   awkward ("members" → "member" is fine; "people" → "peopl" is not).
// - `allowBack` lets the user type "b" / "back" / "0" to return the BACK
//   sentinel, which the caller maps to a previous step.
// - `maxInvalid` caps how many garbage answers in a row we tolerate
//   before throwing. Protects against pasted shell history / broken
//   stdin where the loop would otherwise spin forever.
async function choose(label, choices, {
  input = process.stdin,
  output = process.stderr,
  singularLabel,
  allowBack = false,
  maxInvalid = 3,
} = {}) {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`No ${label} available.`);
  }
  const singular = singularLabel || label.replace(/s$/, "") || label;
  if (choices.length === 1) {
    output.write(`Auto-selected ${singular}: ${choices[0].label} (only one available)\n`);
    return choices[0].value;
  }

  output.write(`${label}:\n`);
  choices.forEach((choice, index) => {
    output.write(`  ${index + 1}. ${choice.label}\n`);
  });

  const hint = allowBack
    ? `[1-${choices.length}, b=back]`
    : `[1-${choices.length}]`;

  let invalid = 0;
  while (true) {
    const answer = (await ask(`Choose ${label} ${hint}: `, { input, output })).trim();
    if (allowBack && (answer === "b" || answer === "B" || answer === "back" || answer === "0")) {
      return BACK;
    }
    const n = Number.parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
      return choices[n - 1].value;
    }
    invalid += 1;
    if (invalid >= maxInvalid) {
      throw new Error(`Cancelled ${label} prompt after ${invalid} invalid answers`);
    }
    output.write(`Enter a number from 1 to ${choices.length}${allowBack ? " (or 'b' to go back)" : ""}.\n`);
  }
}

// typedConfirm prompts the user to literally re-type a string (typically
// the name of a resource about to be destroyed) before proceeding. Match
// is case-sensitive and exact — `--yes` does NOT bypass this prompt,
// only an explicit pre-supplied `typed` answer does (for non-interactive
// CI where the operator already scripted the confirmation).
//
// Why we need this in addition to `confirm`: y/n prompts get muscle-
// memory-yes'd. Typing the literal name of a prod deployment makes the
// operator look at what they're deleting one more time. Mirrors the
// dashboard's `delete-deployment` flow shipped in v1.7.2.
async function typedConfirm(label, expected, {
  input = process.stdin,
  output = process.stderr,
  typed = null,
  maxAttempts = 3,
} = {}) {
  if (typeof expected !== "string" || expected === "") {
    throw new Error("typedConfirm requires a non-empty `expected` string");
  }
  // Non-interactive shortcut: caller pre-supplied the typed string via
  // a flag (`--confirm=<name>`). We still require exact match; passing
  // the wrong value should NOT proceed even if the caller meant well.
  if (typed !== null) {
    return typed === expected;
  }
  if (!input.isTTY) {
    throw new Error(
      `Refusing to ${label} without a TTY. Re-run with --confirm=${expected} to confirm non-interactively.`,
    );
  }
  const rl = readline.createInterface({ input, output });
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const raw = await new Promise((resolve) =>
        rl.question(`Type ${expected} to confirm ${label}: `, resolve),
      );
      const answer = raw.trim();
      if (answer === expected) return true;
      if (answer === "" || answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
        return false;
      }
      output.write(`Doesn't match. Type the exact name "${expected}" or press Enter to cancel.\n`);
    }
    return false;
  } finally {
    rl.close();
  }
}

module.exports = {
  BACK,
  ask,
  askCredentials,
  askHidden,
  choose,
  confirm,
  parseCredentialsInput,
  typedConfirm,
};
