// `synapse members *` — covers the 4 commands, role-set validation,
// memberId / userId presence guards, and one SynapseAPI round-trip
// to prove the URL + auth header land correctly.

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const { createOutput } = require("../lib/output");
const { SynapseAPI } = require("../lib/api");
const members = require("../lib/commands/members");

function cmd(mod, name) {
  const arr = Array.isArray(mod) ? mod : mod.commands || [mod];
  const found = arr.find((c) => c.name === name);
  if (!found) throw new Error(`command not found: ${name}`);
  return found;
}

function capture(json = false) {
  const outBuf = [];
  const errBuf = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => outBuf.push(c.toString("utf8")));
  stderr.on("data", (c) => errBuf.push(c.toString("utf8")));
  return {
    out: createOutput({ json, stdout, stderr }),
    text: () => ({ stdout: outBuf.join(""), stderr: errBuf.join("") }),
  };
}

function makeCtx({ json = false, api = {} } = {}) {
  const cap = capture(json);
  return { cap, ctx: { out: cap.out, cwd: process.cwd(), api, projectConfig: null } };
}

// ---- API client wiring -------------------------------------------------

test("API: projectMembersList tolerates a bare array response", async () => {
  const calls = [];
  const api = new SynapseAPI({
    baseUrl: "https://s.test",
    accessToken: "tok",
    fetchImpl: async (url, opts) => {
      calls.push({ url: url.toString(), method: opts.method, auth: opts.headers.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: "u1", email: "a@example.com", name: "Alice", role: "admin", source: "project" },
        ],
      };
    },
  });
  const rows = await api.projectMembersList("p1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "project");
  assert.match(calls[0].url, /\/v1\/projects\/p1\/list_members$/);
  assert.equal(calls[0].auth, "Bearer tok");
});

// ---- members list ------------------------------------------------------

test("members list calls projectMembersList and renders source column", async () => {
  const { cap, ctx } = makeCtx({
    json: false,
    api: {
      projectMembersList: async (projectId) => {
        assert.equal(projectId, "p1");
        return [
          { id: "u1", email: "a@example.com", name: "Alice", role: "admin", source: "team" },
          { id: "u2", email: "b@example.com", name: "Bob", role: "viewer", source: "project" },
        ];
      },
    },
  });
  await cmd(members, "members list").run(["--project=p1"], ctx);
  const out = cap.text().stdout;
  assert.match(out, /USER/);
  assert.match(out, /SOURCE/);
  assert.match(out, /Alice/);
  assert.match(out, /team/);
  assert.match(out, /project/);
});

test("members list emits JSON kind/count/members under --json", async () => {
  const { cap, ctx } = makeCtx({
    json: true,
    api: {
      projectMembersList: async () => [
        { id: "u1", email: "a@example.com", name: "Alice", role: "admin", source: "project" },
      ],
    },
  });
  await cmd(members, "members list").run(["--project=p1"], ctx);
  const parsed = JSON.parse(cap.text().stdout);
  assert.equal(parsed.kind, "members");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.projectId, "p1");
});

// ---- members add -------------------------------------------------------

test("members add validates --role against admin|member|viewer", async () => {
  const { ctx } = makeCtx({ api: { projectMemberAdd: async () => ({}) } });
  await assert.rejects(
    () => cmd(members, "members add").run(
      ["--project=p1", "--user-id=u1", "--role=owner"],
      ctx,
    ),
    /Invalid --role: owner/,
  );
});

test("members add posts { userId, role } to the backend", async () => {
  let captured = null;
  const { ctx } = makeCtx({
    json: true,
    api: {
      projectMemberAdd: async (projectId, userId, role) => {
        captured = { projectId, userId, role };
        return { projectId, userId, role };
      },
    },
  });
  await cmd(members, "members add").run(
    ["--project=p1", "--user-id=u1", "--role=member"],
    ctx,
  );
  assert.deepEqual(captured, { projectId: "p1", userId: "u1", role: "member" });
});

test("members add complains when --user-id is missing", async () => {
  const { ctx } = makeCtx({ api: { projectMemberAdd: async () => ({}) } });
  await assert.rejects(
    () => cmd(members, "members add").run(
      ["--project=p1", "--role=member"],
      ctx,
    ),
    /Missing --user-id/,
  );
});

// ---- members update-role ----------------------------------------------

test("members update-role requires --member-id and --role", async () => {
  const { ctx } = makeCtx({ api: { projectMemberUpdateRole: async () => ({}) } });
  await assert.rejects(
    () => cmd(members, "members update-role").run(
      ["--project=p1", "--role=admin"],
      ctx,
    ),
    /Missing --member-id/,
  );
});

test("members update-role posts { memberId, role }", async () => {
  let captured = null;
  const { ctx } = makeCtx({
    json: true,
    api: {
      projectMemberUpdateRole: async (projectId, memberId, role) => {
        captured = { projectId, memberId, role };
        return { memberId, role };
      },
    },
  });
  await cmd(members, "members update-role").run(
    ["--project=p1", "--member-id=u2", "--role=admin"],
    ctx,
  );
  assert.deepEqual(captured, { projectId: "p1", memberId: "u2", role: "admin" });
});

// ---- members remove ---------------------------------------------------

test("members remove posts { memberId } to the backend", async () => {
  let captured = null;
  const { cap, ctx } = makeCtx({
    json: false,
    api: {
      projectMemberRemove: async (projectId, memberId) => {
        captured = { projectId, memberId };
        return { memberId, status: "override_removed" };
      },
    },
  });
  await cmd(members, "members remove").run(
    ["--project=p1", "--member-id=u2"],
    ctx,
  );
  assert.deepEqual(captured, { projectId: "p1", memberId: "u2" });
  assert.match(cap.text().stdout, /Removed override/);
});

test("members remove rejects missing --member-id", async () => {
  const { ctx } = makeCtx({ api: { projectMemberRemove: async () => ({}) } });
  await assert.rejects(
    () => cmd(members, "members remove").run(["--project=p1"], ctx),
    /Missing --member-id/,
  );
});
