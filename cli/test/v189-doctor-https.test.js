// v1.8.9 — `synapse doctor` learns the local-HTTPS-dev category.
//
// Tests cover:
//   - parseDevHttpsScript extracts domain + cert + key paths
//   - hasLocalHttpsContext detects both cwd-script and cert-store
//     contexts (and returns false when neither exists)
//   - the 5 new checks return the right status under each context
//   - silentlySkip propagates through cascade-skip
//   - renderer hides individual silentlySkip rows AND entire
//     categories where every row would be silently skipped

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { PassThrough } = require("node:stream");

const checksMod = require("../lib/doctor/checks");
const runner = require("../lib/doctor/runner");
const renderer = require("../lib/doctor/renderer");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doctor-https-"));
}

function capture() {
  const buf = [];
  const stdout = new PassThrough();
  stdout.on("data", (c) => buf.push(c.toString("utf8")));
  return { stdout, text: () => buf.join("") };
}

function writePackage(dir, scripts = {}) {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts, dependencies: { next: "^16" } }, null, 2) + "\n",
  );
}

// ---- parseDevHttpsScript --------------------------------------------

test("parseDevHttpsScript extracts hostname, cert, key", () => {
  const tmp = mkTmp();
  try {
    writePackage(tmp, {
      "dev:https":
        "next dev --turbopack --hostname dev.foo.com --experimental-https --experimental-https-key /k.pem --experimental-https-cert /c.pem",
    });
    const dev = checksMod.parseDevHttpsScript(tmp);
    assert.equal(dev.domain, "dev.foo.com");
    assert.equal(dev.cert, "/c.pem");
    assert.equal(dev.key, "/k.pem");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseDevHttpsScript returns null without package.json", () => {
  const tmp = mkTmp();
  try {
    assert.equal(checksMod.parseDevHttpsScript(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseDevHttpsScript returns null when dev:https script is missing", () => {
  const tmp = mkTmp();
  try {
    writePackage(tmp, { dev: "next dev" });
    assert.equal(checksMod.parseDevHttpsScript(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseDevHttpsScript returns null on malformed script (missing --hostname)", () => {
  const tmp = mkTmp();
  try {
    writePackage(tmp, { "dev:https": "next dev --experimental-https" });
    assert.equal(checksMod.parseDevHttpsScript(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- hasLocalHttpsContext -------------------------------------------

test("hasLocalHttpsContext: true when cwd has dev:https script", () => {
  const tmp = mkTmp();
  try {
    writePackage(tmp, {
      "dev:https": "next dev --hostname x.foo.com --experimental-https --experimental-https-key /k --experimental-https-cert /c",
    });
    assert.equal(checksMod.hasLocalHttpsContext(tmp), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("hasLocalHttpsContext: true when cert store has at least one subdir", () => {
  const tmp = mkTmp();
  const tmpHome = mkTmp();
  const homedirOrig = os.homedir;
  os.homedir = () => tmpHome;
  try {
    fs.mkdirSync(path.join(tmpHome, ".config", "dev-certs", "dev.foo.com"), { recursive: true });
    assert.equal(checksMod.hasLocalHttpsContext(tmp), true);
  } finally {
    os.homedir = homedirOrig;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("hasLocalHttpsContext: false when neither context is present", () => {
  const tmp = mkTmp();
  const tmpHome = mkTmp();
  const homedirOrig = os.homedir;
  os.homedir = () => tmpHome;
  try {
    // cert store doesn't exist
    assert.equal(checksMod.hasLocalHttpsContext(tmp), false);
  } finally {
    os.homedir = homedirOrig;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---- runChecks + runner integration ---------------------------------

function buildCtx(cwd) {
  return {
    cwd,
    env: {},
    cfg: null,
    api: null,
    projectConfig: null,
    cfgPath: path.join(cwd, "synapse-config.json"),
    homedir: os.homedir(),
  };
}

test("runChecks: HTTPS category present + has issues when dev:https files missing", async () => {
  const tmp = mkTmp();
  try {
    writePackage(tmp, {
      "dev:https": "next dev --hostname dev.does-not-exist.local --experimental-https --experimental-https-key /tmp/nope-key.pem --experimental-https-cert /tmp/nope-cert.pem",
    });
    const results = await runner.runChecks(require("../lib/doctor/checks").ALL_CHECKS, buildCtx(tmp));
    const certFiles = results.find((r) => r.id === "https-cert-files");
    assert.equal(certFiles.status, "issue", "missing cert files should be issue");
    assert.match(certFiles.remediation || "", /synapse https setup dev\.does-not-exist\.local/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runChecks: dev:https expiry-check cascades to silentlySkip when cert-files is silentlySkip", async () => {
  // Project without a dev:https script — both cert-files and the
  // dependent cert-expiry become silently skipped.
  const tmp = mkTmp();
  const tmpHome = mkTmp();
  const homedirOrig = os.homedir;
  os.homedir = () => tmpHome;
  try {
    const results = await runner.runChecks(require("../lib/doctor/checks").ALL_CHECKS, buildCtx(tmp));
    const certFiles = results.find((r) => r.id === "https-cert-files");
    const expiry = results.find((r) => r.id === "https-cert-expiry");
    assert.equal(certFiles.status, "skipped");
    assert.equal(certFiles.data.silentlySkip, true, "cert-files marked silentlySkip");
    assert.equal(expiry.status, "skipped");
    assert.equal(
      expiry.data.silentlySkip,
      true,
      "expiry cascade-skip should INHERIT silentlySkip flag from parent",
    );
  } finally {
    os.homedir = homedirOrig;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---- renderer: silent-skip hiding ----------------------------------

test("renderer hides INDIVIDUAL rows with silentlySkip:true", () => {
  const cap = capture();
  renderer.renderReport(
    {
      schemaVersion: "1.0",
      env: { synapseUrl: null, user: null },
      results: [
        // visible
        {
          id: "a",
          category: "local-https-dev",
          title: "mkcert installed",
          status: "ok",
          summary: "v1.4.4",
        },
        // hidden
        {
          id: "b",
          category: "local-https-dev",
          title: "dev:https cert files",
          status: "skipped",
          summary: "no dev:https script",
          data: { silentlySkip: true },
        },
      ],
      totals: { ok: 1, warn: 0, issue: 0, skipped: 1, fixed: 0, fixableAuto: 0, fixablePrompt: 0 },
      durationMs: 1,
      exitCode: 0,
    },
    { stdout: cap.stdout },
  );
  const out = cap.text();
  assert.match(out, /mkcert installed/);
  assert.doesNotMatch(out, /dev:https cert files/);
});

test("renderer hides the WHOLE category when every row is silentlySkip", () => {
  const cap = capture();
  renderer.renderReport(
    {
      schemaVersion: "1.0",
      env: { synapseUrl: null, user: null },
      results: [
        {
          id: "ok-one",
          category: "local-env",
          title: "Node",
          status: "ok",
          summary: "v25",
        },
        {
          id: "a",
          category: "local-https-dev",
          title: "https-cert-files",
          status: "skipped",
          summary: "no dev:https",
          data: { silentlySkip: true },
        },
        {
          id: "b",
          category: "local-https-dev",
          title: "https-domain-resolves",
          status: "skipped",
          summary: "no dev:https",
          data: { silentlySkip: true },
        },
      ],
      totals: { ok: 1, warn: 0, issue: 0, skipped: 2, fixed: 0, fixableAuto: 0, fixablePrompt: 0 },
      durationMs: 1,
      exitCode: 0,
    },
    { stdout: cap.stdout },
  );
  const out = cap.text();
  assert.match(out, /Local environment/);
  assert.doesNotMatch(out, /Local HTTPS dev/, "category header must be hidden when every row is silentlySkip");
});

// ---- integration: render full report with the renderer's logic -----

test("renderer integration: dev:https issues are visible + their remediation lands", () => {
  const cap = capture();
  renderer.renderReport(
    {
      schemaVersion: "1.0",
      env: { synapseUrl: null, user: null },
      results: [
        { id: "n", category: "local-env", title: "Node", status: "ok", summary: "v25" },
        { id: "mk", category: "local-https-dev", title: "mkcert", status: "ok", summary: "v1.4.4" },
        {
          id: "files",
          category: "local-https-dev",
          title: "cert files",
          status: "issue",
          summary: "dev.foo.com: missing cert + key",
          remediation: "Run `synapse https setup dev.foo.com` to regenerate.",
        },
      ],
      totals: { ok: 2, warn: 0, issue: 1, skipped: 0, fixed: 0, fixableAuto: 0, fixablePrompt: 0 },
      durationMs: 1,
      exitCode: 2,
    },
    { stdout: cap.stdout },
  );
  const out = cap.text();
  assert.match(out, /Local HTTPS dev/);
  assert.match(out, /cert files/);
  assert.match(out, /synapse https setup dev\.foo\.com/);
});
