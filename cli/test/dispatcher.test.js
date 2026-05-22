const assert = require("node:assert/strict");
const test = require("node:test");
const { resolve, wantsHelp } = require("../lib/commands/_dispatcher");

function fakeRegistry(names) {
  return new Map(names.map((n) => [n, { name: n, run: async () => {} }]));
}

test("resolve: two-word match wins over one-word when both exist", () => {
  const reg = fakeRegistry(["deployment", "deployment create"]);
  const { cmd, rest } = resolve(reg, ["deployment", "create", "--type", "dev"]);
  assert.equal(cmd.name, "deployment create");
  assert.deepEqual(rest, ["--type", "dev"]);
});

test("resolve: falls back to one-word when no two-word match", () => {
  const reg = fakeRegistry(["dev"]);
  const { cmd, rest } = resolve(reg, ["dev", "--once"]);
  assert.equal(cmd.name, "dev");
  assert.deepEqual(rest, ["--once"]);
});

test("resolve: unknown command yields { cmd: null, rest: argv }", () => {
  const reg = fakeRegistry(["dev"]);
  const r = resolve(reg, ["ghostbuster"]);
  assert.equal(r.cmd, null);
  assert.deepEqual(r.rest, ["ghostbuster"]);
});

test("resolve: legacy one-word `credentials <name>` keeps working under two-then-one rule", () => {
  // The two-word lookup `credentials dev-cat` misses; falls back to
  // `credentials` and treats `dev-cat` as a positional. Mirrors the
  // existing public CLI surface.
  const reg = fakeRegistry(["credentials"]);
  const { cmd, rest } = resolve(reg, ["credentials", "dev-cat", "--format", "shell"]);
  assert.equal(cmd.name, "credentials");
  assert.deepEqual(rest, ["dev-cat", "--format", "shell"]);
});

test("resolve: empty argv yields null cmd, empty rest", () => {
  const reg = fakeRegistry(["dev"]);
  assert.deepEqual(resolve(reg, []), { cmd: null, rest: [] });
  assert.deepEqual(resolve(reg, undefined), { cmd: null, rest: [] });
});

test("wantsHelp recognises --help, -h anywhere in args", () => {
  assert.equal(wantsHelp([]), false);
  assert.equal(wantsHelp(["foo", "--help"]), true);
  assert.equal(wantsHelp(["-h"]), true);
  assert.equal(wantsHelp(["--help-me"]), false);
  assert.equal(wantsHelp(undefined), false);
});
