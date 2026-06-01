const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildDeploymentLine,
  guardPublicConvexUrls,
  isDeploymentLine,
  keyFromLine,
  parseEnvContent,
  reassertPublicConvexUrls,
  sanitizeForComment,
  updateEnvContent,
} = require("../lib/env-file");

test("detects env keys from plain and export assignments", () => {
  assert.equal(keyFromLine("CONVEX_DEPLOYMENT=dev:old"), "CONVEX_DEPLOYMENT");
  assert.equal(keyFromLine(" export CONVEX_SELF_HOSTED_URL=x"), "CONVEX_SELF_HOSTED_URL");
  assert.equal(keyFromLine("# CONVEX_DEPLOYMENT=dev:old"), null);
});

test("isDeploymentLine recognizes uncommented, exported, and legacy-commented forms", () => {
  assert.equal(isDeploymentLine("CONVEX_DEPLOYMENT=dev:x"), true);
  assert.equal(isDeploymentLine("export CONVEX_DEPLOYMENT=dev:x"), true);
  assert.equal(isDeploymentLine("# CONVEX_DEPLOYMENT=dev:x # disabled by synapse CLI"), true);
  assert.equal(isDeploymentLine("#CONVEX_DEPLOYMENT=dev:x"), true);
  assert.equal(isDeploymentLine("CONVEX_SELF_HOSTED_URL=x"), false);
  assert.equal(isDeploymentLine("# random comment"), false);
});

test("sanitizeForComment scrubs newlines and hashes (defensive)", () => {
  assert.equal(sanitizeForComment("amage.ia"), "amage.ia");
  assert.equal(sanitizeForComment("line1\nline2"), "line1 line2");
  assert.equal(sanitizeForComment("evil # comment"), "evil · comment");
  assert.equal(sanitizeForComment(null), "");
  assert.equal(sanitizeForComment(undefined), "");
});

test("buildDeploymentLine returns null without deploymentName", () => {
  assert.equal(buildDeploymentLine({}), null);
  assert.equal(buildDeploymentLine({ target: "dev" }), null);
});

test("buildDeploymentLine: dev/prod targets emit a COMMENTED line (v1.8.4 regression fix)", () => {
  // v1.8.4: the line MUST be commented because Convex CLI errors when
  // CONVEX_DEPLOYMENT + CONVEX_SELF_HOSTED_URL/ADMIN_KEY are both set.
  // v1.8.2-v1.8.3 wrote it active; that broke `synapse dev` because
  // npx convex re-reads .env.local via dotenv after we delete the var
  // from the spawn env.
  assert.equal(
    buildDeploymentLine({
      deploymentName: "brave-dolphin-1060",
      target: "dev",
      teamName: "amage.ia",
      projectName: "amagejumpy",
    }),
    "# CONVEX_DEPLOYMENT=dev:brave-dolphin-1060 # team: amage.ia, project: amagejumpy",
  );
  assert.equal(
    buildDeploymentLine({
      deploymentName: "wise-otter-42",
      target: "prod",
      teamName: "ACME",
      projectName: "store",
    }),
    "# CONVEX_DEPLOYMENT=prod:wise-otter-42 # team: ACME, project: store",
  );
});

test("buildDeploymentLine: falls back to slugs when names are missing", () => {
  assert.equal(
    buildDeploymentLine({
      deploymentName: "x-1",
      target: "dev",
      teamSlug: "team-a",
      projectSlug: "proj-a",
    }),
    "# CONVEX_DEPLOYMENT=dev:x-1 # team: team-a, project: proj-a",
  );
});

test("buildDeploymentLine: invalid target defaults to dev (defensive)", () => {
  assert.equal(
    buildDeploymentLine({ deploymentName: "x", target: "WHATEVER" }),
    "# CONVEX_DEPLOYMENT=dev:x",
  );
});

test("first-time write: emits headers + grouped sections + CONVEX_DEPLOYMENT commented (v1.8.4)", () => {
  const next = updateEnvContent("", {
    convexUrl: "https://brave-dolphin-1060.app.synapsepanel.com",
    adminKey: "brave-dolphin-1060|abc123",
    deploymentName: "brave-dolphin-1060",
    target: "dev",
    teamName: "amage.ia",
    projectName: "amagejumpy",
  });
  assert.match(next, /^# Convex \(Synapse self-hosted/m);
  assert.match(next, /^# Self-hosted auth/m);
  // Public block: NEXT_PUBLIC_* active, CONVEX_DEPLOYMENT commented out.
  assert.match(
    next,
    /# Convex.*\nNEXT_PUBLIC_CONVEX_URL="[^"]+"\nNEXT_PUBLIC_CONVEX_SITE_URL="[^"]+"\n# CONVEX_DEPLOYMENT=dev:brave-dolphin-1060 # team: amage\.ia, project: amagejumpy\n/s,
  );
  // Self-hosted block: both keys active.
  assert.match(
    next,
    /# Self-hosted auth.*\nCONVEX_SELF_HOSTED_URL="[^"]+"\nCONVEX_SELF_HOSTED_ADMIN_KEY="[^"]+"\n/s,
  );
  // Regression assertion: there must be NO uncommented CONVEX_DEPLOYMENT
  // line anywhere — that's the Convex CLI error trigger.
  assert.doesNotMatch(next, /^CONVEX_DEPLOYMENT=/m);
});

test("idempotency: identical args twice produce identical output (canonical form)", () => {
  const opts = {
    convexUrl: "https://x.app.synapsepanel.com",
    adminKey: "x|abc",
    deploymentName: "x",
    target: "dev",
    teamName: "ACME",
    projectName: "store",
  };
  const a = updateEnvContent("", opts);
  const b = updateEnvContent(a, opts);
  assert.equal(a, b);
});

test("re-run with NEW credentials replaces values in place, keeps headers", () => {
  const initial = updateEnvContent("", {
    convexUrl: "https://old.app.synapsepanel.com",
    adminKey: "old|key",
    deploymentName: "old",
    target: "dev",
    teamName: "T",
    projectName: "P",
  });
  const updated = updateEnvContent(initial, {
    convexUrl: "https://new.app.synapsepanel.com",
    adminKey: "new|key",
    deploymentName: "new",
    target: "dev",
    teamName: "T",
    projectName: "P",
  });
  // Only the new URL/key/name should appear.
  assert.equal((updated.match(/old/g) || []).length, 0);
  assert.match(updated, /NEXT_PUBLIC_CONVEX_URL="https:\/\/new\.app\.synapsepanel\.com"/);
  assert.match(updated, /^# CONVEX_DEPLOYMENT=dev:new # team: T, project: P$/m);
  assert.match(updated, /CONVEX_SELF_HOSTED_ADMIN_KEY="new\|key"/);
  // Section headers preserved (not duplicated).
  assert.equal((updated.match(/# Convex \(Synapse self-hosted/g) || []).length, 1);
  assert.equal((updated.match(/# Self-hosted auth/g) || []).length, 1);
});

test("preserves unrelated user vars (NEXT_PUBLIC_SITE_URL, WAHA_API_URL, etc)", () => {
  const existing = [
    "NEXT_PUBLIC_SITE_URL=https://dev.amagejumpy.com:3000",
    "WAHA_API_URL=https://maya.amagejumpy.com",
    "ENGINE_API_KEY=amage-engine-xyz",
    "",
  ].join("\n");
  const next = updateEnvContent(existing, {
    convexUrl: "https://x.app.synapsepanel.com",
    adminKey: "x|abc",
    deploymentName: "x",
    target: "dev",
    teamName: "T",
    projectName: "P",
  });
  assert.match(next, /^NEXT_PUBLIC_SITE_URL=https:\/\/dev\.amagejumpy\.com:3000$/m);
  assert.match(next, /^WAHA_API_URL=https:\/\/maya\.amagejumpy\.com$/m);
  assert.match(next, /^ENGINE_API_KEY=amage-engine-xyz$/m);
  // Convex block appended at the end with headers.
  assert.match(next, /# Convex \(Synapse self-hosted/);
});

test("legacy-commented CONVEX_DEPLOYMENT (v1.7-) is replaced with our commented form", () => {
  const existing = [
    "FOO=bar",
    "# CONVEX_DEPLOYMENT=dev:old-wolf-123 # disabled by synapse CLI for self-hosted Convex",
    'CONVEX_SELF_HOSTED_URL="http://old"',
    'CONVEX_SELF_HOSTED_ADMIN_KEY="old|key"',
  ].join("\n");
  const next = updateEnvContent(existing, {
    convexUrl: "https://new.app.synapsepanel.com",
    adminKey: "new|key",
    deploymentName: "happy-cat-1",
    target: "dev",
    teamName: "T",
    projectName: "P",
  });
  // Legacy "disabled by" trailer is gone (we rewrote the line cleanly).
  assert.doesNotMatch(next, /disabled by synapse CLI/);
  assert.doesNotMatch(next, /old-wolf-123/);
  // New form is also commented, with our team/project trailer.
  assert.match(next, /^# CONVEX_DEPLOYMENT=dev:happy-cat-1 # team: T, project: P$/m);
  // Regression guard: NO uncommented CONVEX_DEPLOYMENT in the output.
  assert.doesNotMatch(next, /^CONVEX_DEPLOYMENT=/m);
  assert.match(next, /^FOO=bar$/m);
});

test("legacy API (no deploymentName) leaves existing CONVEX_DEPLOYMENT lines untouched", () => {
  const existing = [
    "FOO=bar",
    "CONVEX_DEPLOYMENT=dev:old",
    "CONVEX_SELF_HOSTED_URL=http://old",
  ].join("\n");
  const next = updateEnvContent(existing, {
    convexUrl: "http://new",
    adminKey: "new",
    // No deploymentName, no team/project — legacy caller shape.
  });
  // Existing CONVEX_DEPLOYMENT preserved verbatim (not commented, not dropped).
  assert.match(next, /^CONVEX_DEPLOYMENT=dev:old$/m);
  // Self-hosted vars still updated.
  assert.match(next, /^CONVEX_SELF_HOSTED_URL="http:\/\/new"$/m);
});

test("multiple CONVEX_DEPLOYMENT lines collapse to single commented line", () => {
  const existing = [
    "CONVEX_DEPLOYMENT=dev:a",
    "CONVEX_DEPLOYMENT=dev:b",
    "# CONVEX_DEPLOYMENT=dev:c # disabled by synapse CLI",
  ].join("\n");
  const next = updateEnvContent(existing, {
    convexUrl: "http://new",
    adminKey: "new",
    deploymentName: "winner",
    target: "dev",
  });
  // Exactly one CONVEX_DEPLOYMENT-mentioning line, and it's commented.
  assert.equal((next.match(/CONVEX_DEPLOYMENT=/g) || []).length, 1);
  assert.match(next, /^# CONVEX_DEPLOYMENT=dev:winner$/m);
  // Regression guard.
  assert.doesNotMatch(next, /^CONVEX_DEPLOYMENT=/m);
});

test("does not duplicate managed value keys", () => {
  const next = updateEnvContent(
    [
      "CONVEX_SELF_HOSTED_URL=http://old",
      "CONVEX_SELF_HOSTED_URL=http://duplicate",
      "CONVEX_SELF_HOSTED_ADMIN_KEY=old",
    ].join("\n"),
    {
      convexUrl: "http://new",
      adminKey: "new-key",
      deploymentName: "x",
      target: "dev",
    },
  );
  assert.equal((next.match(/^CONVEX_SELF_HOSTED_URL=/gm) || []).length, 1);
  assert.equal((next.match(/^CONVEX_SELF_HOSTED_ADMIN_KEY=/gm) || []).length, 1);
});

test("parses .env.local values needed by delegated convex commands", () => {
  const parsed = parseEnvContent([
    "# ignored",
    "CONVEX_DEPLOYMENT=dev:cloud # team: T, project: P",
    'CONVEX_SELF_HOSTED_URL="https://happy-cat.convex.example.com"',
    "CONVEX_SELF_HOSTED_ADMIN_KEY='dev:happy-cat|secret'",
    'NEXT_PUBLIC_CONVEX_URL="https://happy-cat.convex.example.com"',
  ].join("\n"));

  assert.equal(parsed.CONVEX_DEPLOYMENT, "dev:cloud # team: T, project: P");
  assert.equal(parsed.CONVEX_SELF_HOSTED_URL, "https://happy-cat.convex.example.com");
  assert.equal(parsed.CONVEX_SELF_HOSTED_ADMIN_KEY, "dev:happy-cat|secret");
  assert.equal(parsed.NEXT_PUBLIC_CONVEX_URL, "https://happy-cat.convex.example.com");
});

test("missing convexUrl or adminKey throws (caller error, not a silent broken file)", () => {
  assert.throws(() => updateEnvContent("", { convexUrl: "x" }), /convexUrl \+ adminKey/);
  assert.throws(() => updateEnvContent("", { adminKey: "y" }), /convexUrl \+ adminKey/);
});

// v1.8.4 regression: the generated .env.local must NEVER contain both
// an uncommented CONVEX_DEPLOYMENT AND CONVEX_SELF_HOSTED_* — Convex CLI
// errors with "CONVEX_DEPLOYMENT must not be set when
// CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY are set".
// This test would have caught the v1.8.2-v1.8.3 regression before ship.
test("REGRESSION: .env.local never has both active CONVEX_DEPLOYMENT and CONVEX_SELF_HOSTED_* (v1.8.4)", () => {
  const next = updateEnvContent("", {
    convexUrl: "https://x.app.example.com",
    adminKey: "x|abc",
    deploymentName: "x",
    target: "dev",
    teamName: "T",
    projectName: "P",
  });
  // Parse the file the way Convex CLI's dotenv would.
  const parsed = parseEnvContent(next);
  // Both self-hosted vars are present.
  assert.ok(parsed.CONVEX_SELF_HOSTED_URL, "self-hosted URL must be set");
  assert.ok(parsed.CONVEX_SELF_HOSTED_ADMIN_KEY, "self-hosted ADMIN_KEY must be set");
  // CONVEX_DEPLOYMENT must NOT be set as far as dotenv is concerned.
  assert.equal(
    parsed.CONVEX_DEPLOYMENT,
    undefined,
    "CONVEX_DEPLOYMENT must be commented out — Convex CLI errors otherwise",
  );
});

test("preserves file mode permissions on disk write (smoke via fs)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const { writeProjectEnv } = require("../lib/env-file");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-file-test-"));
  try {
    writeProjectEnv(
      tmp,
      { convexUrl: "https://x.app", adminKey: "x|k", deploymentName: "x" },
      { team: { slug: "t", name: "T" }, project: { slug: "p", name: "P" }, target: "dev" },
    );
    const file = path.join(tmp, ".env.local");
    assert.ok(fs.existsSync(file));
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, `expected mode 0600, got 0${mode.toString(8)}`);
    }
    const content = fs.readFileSync(file, "utf8");
    assert.match(content, /^# CONVEX_DEPLOYMENT=dev:x # team: T, project: P$/m);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("distinct siteUrl drives NEXT_PUBLIC_CONVEX_SITE_URL (cloud vs site host)", () => {
  const next = updateEnvContent("", {
    convexUrl: "https://agile-cat-9412.app.synapsepanel.com",
    siteUrl: "https://agile-cat-9412.site.app.synapsepanel.com",
    adminKey: "agile-cat-9412|abc",
    deploymentName: "agile-cat-9412",
  });
  // Cloud URL → 3210 (client API, deploy/admin); site URL → 3211 (HTTP actions).
  assert.match(next, /NEXT_PUBLIC_CONVEX_URL="https:\/\/agile-cat-9412\.app\.synapsepanel\.com"/);
  assert.match(next, /NEXT_PUBLIC_CONVEX_SITE_URL="https:\/\/agile-cat-9412\.site\.app\.synapsepanel\.com"/);
  // CONVEX_SELF_HOSTED_URL stays the cloud URL — deploy/admin hit 3210.
  assert.match(next, /CONVEX_SELF_HOSTED_URL="https:\/\/agile-cat-9412\.app\.synapsepanel\.com"/);
});

test("siteUrl omitted falls back to convexUrl for SITE_URL (host-port mode)", () => {
  const next = updateEnvContent("", {
    convexUrl: "https://x.app.synapsepanel.com",
    adminKey: "x|abc",
    deploymentName: "x",
  });
  assert.match(next, /NEXT_PUBLIC_CONVEX_SITE_URL="https:\/\/x\.app\.synapsepanel\.com"/);
});

// ---------------------------------------------------------------------------
// reassertPublicConvexUrls — the v1.12.1 fix. The upstream `npx convex
// dev|deploy` overwrites NEXT_PUBLIC_CONVEX_SITE_URL with the backend
// container's (possibly stale) /get_canonical_urls value; this restores the
// authoritative site host from cli_credentials. See docs/CONVEX_SITE_ORIGIN.md.
// ---------------------------------------------------------------------------

function withTmpEnv(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-reassert-"));
  try {
    if (content !== null) {
      fs.writeFileSync(path.join(dir, ".env.local"), content);
    }
    return fn(dir, path.join(dir, ".env.local"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("reassert: fixes a clobbered (cloud) site URL back to the site host", () => {
  // Exactly the user's report: upstream wrote the cloud URL (unquoted) into
  // NEXT_PUBLIC_CONVEX_SITE_URL; the deployment actually has a role='site'
  // custom domain so cli_credentials hands back the distinct site host.
  const clobbered = [
    'NEXT_PUBLIC_CONVEX_URL="https://mpi.amagejumpy.com"',
    "NEXT_PUBLIC_SITE_URL=https://dev.amagejumpy.com:3000",
    "NEXT_PUBLIC_CONVEX_SITE_URL=https://mpi.amagejumpy.com",
    "",
  ].join("\n");
  withTmpEnv(clobbered, (dir, file) => {
    const changed = reassertPublicConvexUrls(dir, {
      convexUrl: "https://mpi.amagejumpy.com",
      siteUrl: "https://site.mpi.amagejumpy.com",
    });
    assert.equal(changed, true);
    const parsed = parseEnvContent(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.NEXT_PUBLIC_CONVEX_SITE_URL, "https://site.mpi.amagejumpy.com");
    assert.equal(parsed.NEXT_PUBLIC_CONVEX_URL, "https://mpi.amagejumpy.com");
    // The operator's own var must survive untouched.
    assert.equal(parsed.NEXT_PUBLIC_SITE_URL, "https://dev.amagejumpy.com:3000");
  });
});

test("reassert: no-op when the values are already correct (loop-safe)", () => {
  const correct = [
    'NEXT_PUBLIC_CONVEX_URL="https://mpi.amagejumpy.com"',
    'NEXT_PUBLIC_CONVEX_SITE_URL="https://site.mpi.amagejumpy.com"',
    "",
  ].join("\n");
  withTmpEnv(correct, (dir, file) => {
    const before = fs.readFileSync(file, "utf8");
    const changed = reassertPublicConvexUrls(dir, {
      convexUrl: "https://mpi.amagejumpy.com",
      siteUrl: "https://site.mpi.amagejumpy.com",
    });
    assert.equal(changed, false);
    // Byte-for-byte unchanged — this is what keeps the fs.watch guard from
    // ping-ponging with its own restore write.
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("reassert: a correct value in any quoting style is left as-is (no churn)", () => {
  // Container NOT stale: upstream wrote the correct site host, just unquoted.
  // Value matches → we don't rewrite (compare is value-based, not byte-based).
  const correctUnquoted = [
    "NEXT_PUBLIC_CONVEX_URL=https://mpi.amagejumpy.com",
    "NEXT_PUBLIC_CONVEX_SITE_URL=https://site.mpi.amagejumpy.com",
    "",
  ].join("\n");
  withTmpEnv(correctUnquoted, (dir) => {
    const changed = reassertPublicConvexUrls(dir, {
      convexUrl: "https://mpi.amagejumpy.com",
      siteUrl: "https://site.mpi.amagejumpy.com",
    });
    assert.equal(changed, false);
  });
});

test("reassert: host-port mode (no siteUrl) keeps SITE_URL = cloud URL", () => {
  const file = [
    "NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210",
    "NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:3210",
    "",
  ].join("\n");
  withTmpEnv(file, (dir, p) => {
    const changed = reassertPublicConvexUrls(dir, { convexUrl: "http://127.0.0.1:3210" });
    assert.equal(changed, false);
    const parsed = parseEnvContent(fs.readFileSync(p, "utf8"));
    assert.equal(parsed.NEXT_PUBLIC_CONVEX_SITE_URL, "http://127.0.0.1:3210");
  });
});

test("reassert: missing file or missing convexUrl is a safe no-op", () => {
  withTmpEnv(null, (dir) => {
    assert.equal(reassertPublicConvexUrls(dir, { convexUrl: "https://x" }), false);
  });
  withTmpEnv("NEXT_PUBLIC_CONVEX_URL=https://x\n", (dir) => {
    assert.equal(reassertPublicConvexUrls(dir, {}), false);
    assert.equal(reassertPublicConvexUrls(dir, null), false);
  });
});

test("reassert: adds the managed keys when upstream never wrote them", () => {
  withTmpEnv("OTHER=keep-me\n", (dir, file) => {
    const changed = reassertPublicConvexUrls(dir, {
      convexUrl: "https://mpi.amagejumpy.com",
      siteUrl: "https://site.mpi.amagejumpy.com",
    });
    assert.equal(changed, true);
    const parsed = parseEnvContent(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.OTHER, "keep-me");
    assert.equal(parsed.NEXT_PUBLIC_CONVEX_URL, "https://mpi.amagejumpy.com");
    assert.equal(parsed.NEXT_PUBLIC_CONVEX_SITE_URL, "https://site.mpi.amagejumpy.com");
  });
});

test("guard: restores the site URL when the file is rewritten mid-session", () => {
  const correct = [
    'NEXT_PUBLIC_CONVEX_URL="https://mpi.amagejumpy.com"',
    'NEXT_PUBLIC_CONVEX_SITE_URL="https://site.mpi.amagejumpy.com"',
    "",
  ].join("\n");
  withTmpEnv(correct, (dir, file) => {
    let listener = null;
    let closed = false;
    const fakeWatch = (_file, cb) => {
      listener = cb;
      return { close() { closed = true; }, unref() {} };
    };
    const stop = guardPublicConvexUrls(
      dir,
      { convexUrl: "https://mpi.amagejumpy.com", siteUrl: "https://site.mpi.amagejumpy.com" },
      { watch: fakeWatch },
    );
    assert.equal(typeof listener, "function");

    // Simulate the upstream `npx convex dev` clobber, then fire the watcher.
    fs.writeFileSync(file, "NEXT_PUBLIC_CONVEX_SITE_URL=https://mpi.amagejumpy.com\n");
    listener("change", ".env.local");

    const parsed = parseEnvContent(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.NEXT_PUBLIC_CONVEX_SITE_URL, "https://site.mpi.amagejumpy.com");

    stop();
    assert.equal(closed, true);
  });
});

test("guard: no credentials or no file yields an inert stop()", () => {
  withTmpEnv(null, (dir) => {
    let watchCalled = false;
    const fakeWatch = () => { watchCalled = true; return { close() {}, unref() {} }; };
    // No file on disk.
    const stop1 = guardPublicConvexUrls(dir, { convexUrl: "https://x" }, { watch: fakeWatch });
    assert.equal(watchCalled, false);
    assert.doesNotThrow(stop1);
    // No credentials.
    fs.writeFileSync(path.join(dir, ".env.local"), "X=1\n");
    const stop2 = guardPublicConvexUrls(dir, null, { watch: fakeWatch });
    assert.equal(watchCalled, false);
    assert.doesNotThrow(stop2);
  });
});
