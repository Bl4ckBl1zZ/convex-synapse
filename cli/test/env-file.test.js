const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDeploymentLine,
  isDeploymentLine,
  keyFromLine,
  parseEnvContent,
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

test("buildDeploymentLine: dev/prod targets + team/project comment", () => {
  assert.equal(
    buildDeploymentLine({
      deploymentName: "brave-dolphin-1060",
      target: "dev",
      teamName: "amage.ia",
      projectName: "amagejumpy",
    }),
    "CONVEX_DEPLOYMENT=dev:brave-dolphin-1060 # team: amage.ia, project: amagejumpy",
  );
  assert.equal(
    buildDeploymentLine({
      deploymentName: "wise-otter-42",
      target: "prod",
      teamName: "ACME",
      projectName: "store",
    }),
    "CONVEX_DEPLOYMENT=prod:wise-otter-42 # team: ACME, project: store",
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
    "CONVEX_DEPLOYMENT=dev:x-1 # team: team-a, project: proj-a",
  );
});

test("buildDeploymentLine: invalid target defaults to dev (defensive)", () => {
  assert.equal(
    buildDeploymentLine({ deploymentName: "x", target: "WHATEVER" }),
    "CONVEX_DEPLOYMENT=dev:x",
  );
});

test("first-time write: emits headers + grouped sections + all 5 keys", () => {
  const next = updateEnvContent("", {
    convexUrl: "https://brave-dolphin-1060.app.synapsepanel.com",
    adminKey: "brave-dolphin-1060|abc123",
    deploymentName: "brave-dolphin-1060",
    target: "dev",
    teamName: "amage.ia",
    projectName: "amagejumpy",
  });
  // Section headers present.
  assert.match(next, /^# Convex \(Synapse self-hosted/m);
  assert.match(next, /^# Self-hosted auth/m);
  // All 5 keys in correct order under the right headers.
  assert.match(
    next,
    /# Convex.*\nNEXT_PUBLIC_CONVEX_URL="[^"]+"\nNEXT_PUBLIC_CONVEX_SITE_URL="[^"]+"\nCONVEX_DEPLOYMENT=dev:brave-dolphin-1060 # team: amage\.ia, project: amagejumpy\n/s,
  );
  assert.match(
    next,
    /# Self-hosted auth.*\nCONVEX_SELF_HOSTED_URL="[^"]+"\nCONVEX_SELF_HOSTED_ADMIN_KEY="[^"]+"\n/s,
  );
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
  assert.match(updated, /CONVEX_DEPLOYMENT=dev:new # team: T, project: P/);
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

test("legacy-commented CONVEX_DEPLOYMENT (v1.7-) is replaced with new uncommented form", () => {
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
  assert.doesNotMatch(next, /disabled by synapse CLI/);
  assert.doesNotMatch(next, /old-wolf-123/);
  assert.match(next, /^CONVEX_DEPLOYMENT=dev:happy-cat-1 # team: T, project: P$/m);
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

test("multiple CONVEX_DEPLOYMENT lines collapse to single authoritative line", () => {
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
  assert.equal((next.match(/^CONVEX_DEPLOYMENT=/gm) || []).length, 1);
  assert.match(next, /^CONVEX_DEPLOYMENT=dev:winner$/m);
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
    assert.match(content, /^CONVEX_DEPLOYMENT=dev:x # team: T, project: P$/m);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
