const assert = require("node:assert/strict");
const test = require("node:test");

const { SynapseAPI, SynapseAPIError, extractListPayload } = require("../lib/api");

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("login posts to Synapse auth endpoint without bearer", async () => {
  const api = new SynapseAPI({
    baseUrl: "https://synapse.example.com",
    fetchImpl: async (url, init) => {
      assert.equal(url.pathname, "/v1/auth/login");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(init.body), { email: "ian@example.com", password: "secret" });
      return jsonResponse(200, { accessToken: "jwt", tokenType: "Bearer", user: { email: "ian@example.com" } });
    },
  });
  const got = await api.login("ian@example.com", "secret");
  assert.equal(got.accessToken, "jwt");
});

test("authenticated requests send bearer token", async () => {
  const api = new SynapseAPI({
    baseUrl: "https://synapse.example.com",
    accessToken: "tok",
    fetchImpl: async (url, init) => {
      assert.equal(url.pathname, "/v1/me/");
      assert.equal(init.headers.Authorization, "Bearer tok");
      return jsonResponse(200, { email: "ian@example.com" });
    },
  });
  const got = await api.me();
  assert.equal(got.email, "ian@example.com");
});

test("list endpoints follow X-Next-Cursor pagination", async () => {
  const seen = [];
  const api = new SynapseAPI({
    baseUrl: "https://synapse.example.com",
    accessToken: "tok",
    fetchImpl: async (url, init) => {
      seen.push(`${url.pathname}${url.search}`);
      assert.equal(init.headers.Authorization, "Bearer tok");
      if (url.searchParams.get("cursor") === "2") {
        return new Response(JSON.stringify([{ id: "3", slug: "third" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([{ id: "1", slug: "first" }, { id: "2", slug: "second" }]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Next-Cursor": "2",
        },
      });
    },
  });

  const teams = await api.teams();
  assert.deepEqual(teams.map((team) => team.slug), ["first", "second", "third"]);
  assert.deepEqual(seen, ["/v1/teams/?limit=500", "/v1/teams/?limit=500&cursor=2"]);
});

test("refresh posts refreshToken without bearer", async () => {
  const api = new SynapseAPI({
    baseUrl: "https://synapse.example.com",
    accessToken: "expired",
    fetchImpl: async (url, init) => {
      assert.equal(url.pathname, "/v1/auth/refresh");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(init.body), { refreshToken: "refresh" });
      return jsonResponse(200, { accessToken: "new", refreshToken: "new-refresh" });
    },
  });
  const got = await api.refresh("refresh");
  assert.equal(got.accessToken, "new");
});

test("API errors include stable code and status", async () => {
  const api = new SynapseAPI({
    baseUrl: "https://synapse.example.com",
    accessToken: "tok",
    fetchImpl: async () => jsonResponse(403, { code: "forbidden", message: "Nope" }),
  });
  await assert.rejects(() => api.teams(), (err) => {
    assert.ok(err instanceof SynapseAPIError);
    assert.equal(err.status, 403);
    assert.equal(err.code, "forbidden");
    assert.equal(err.message, "Nope");
    return true;
  });
});

test("network failures get a Synapse-specific error", async () => {
  const api = new SynapseAPI({
    baseUrl: "https://synapse.example.com",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(() => api.me(), (err) => {
    assert.ok(err instanceof SynapseAPIError);
    assert.equal(err.status, 0);
    assert.equal(err.code, "network_error");
    assert.match(err.message, /Could not reach Synapse/);
    return true;
  });
});

test("successful non-JSON responses get a stable bad_response error", async () => {
  const api = new SynapseAPI({
    baseUrl: "https://synapse.example.com",
    fetchImpl: async () => new Response("not json", { status: 200 }),
  });
  await assert.rejects(() => api.me(), (err) => {
    assert.ok(err instanceof SynapseAPIError);
    assert.equal(err.status, 200);
    assert.equal(err.code, "bad_response");
    assert.match(err.message, /did not return JSON/);
    return true;
  });
});

test("extractListPayload returns the array for every supported shape", () => {
  assert.deepEqual(extractListPayload([1, 2]), [1, 2]);
  assert.deepEqual(extractListPayload({ teams: [{ id: "t" }] }), [{ id: "t" }]);
  assert.deepEqual(extractListPayload({ projects: [] }), []);
  assert.deepEqual(extractListPayload({ deployments: [{ name: "x" }] }), [{ name: "x" }]);
  assert.deepEqual(extractListPayload({ members: [{ id: "m" }] }), [{ id: "m" }]);
  // Generic fallback when the wrapper key is something new.
  assert.deepEqual(extractListPayload({ widgets: [{ id: "w" }] }), [{ id: "w" }]);
});

test("extractListPayload returns null for non-list shapes", () => {
  assert.equal(extractListPayload(null), null);
  assert.equal(extractListPayload(undefined), null);
  assert.equal(extractListPayload("not a list"), null);
  assert.equal(extractListPayload(42), null);
  assert.equal(extractListPayload({}), null);
  assert.equal(extractListPayload({ unrelated: "value" }), null);
});

test("listAll consumes both bare-array and envelope responses across pages", async () => {
  // First page: array shape with cursor; second page: {deployments:[...]}.
  // Mixing intentionally — if the server ever ships an envelope on one
  // endpoint and not another, we still collect the full list.
  let calls = 0;
  const api = new SynapseAPI({
    baseUrl: "https://synapse.example.com",
    accessToken: "tok",
    fetchImpl: async (url) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify([{ id: "d1", name: "dep-one" }]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Next-Cursor": "d1",
          },
        });
      }
      return new Response(
        JSON.stringify({ deployments: [{ id: "d2", name: "dep-two" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const deployments = await api.deployments("project-id");
  assert.deepEqual(deployments.map((d) => d.name), ["dep-one", "dep-two"]);
});

test("listAll surfaces a useful bad_response when the payload has no list inside", async () => {
  const api = new SynapseAPI({
    baseUrl: "https://synapse.example.com",
    accessToken: "tok",
    fetchImpl: async () =>
      new Response(JSON.stringify({ message: "nope" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  await assert.rejects(() => api.teams(), (err) => {
    assert.ok(err instanceof SynapseAPIError);
    assert.equal(err.code, "bad_response");
    assert.match(err.message, /object with keys \[message\]/);
    return true;
  });
});
