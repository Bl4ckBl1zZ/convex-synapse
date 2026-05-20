const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const config = require("../lib/config");

test("normalizes HTTP(S) Synapse URLs", () => {
  assert.equal(config.normalizeBaseUrl("https://synapse.example.com/"), "https://synapse.example.com");
  assert.equal(config.normalizeBaseUrl("http://localhost:8080/path/"), "http://localhost:8080/path");
  assert.throws(() => config.normalizeBaseUrl("ftp://example.com"), /must start/);
});

test("writes config with private file permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-config-"));
  process.env.SYNAPSE_CLI_CONFIG = path.join(dir, "config.json");
  try {
    const file = config.writeConfig({ baseUrl: "http://localhost:8080", accessToken: "tok" });
    assert.deepEqual(config.readConfig(), { baseUrl: "http://localhost:8080", accessToken: "tok" });
    // NTFS doesn't model POSIX modes — fs.statSync().mode returns 0o666 even
    // after a successful fs.chmodSync(file, 0o600). The Windows secret-at-rest
    // story is user-profile ACL inheritance, not POSIX bits, so the chmodSync
    // call in lib/config.js is already wrapped in try/catch. Assert the modes
    // only on POSIX hosts; on Windows we verify the file exists + round-trips.
    if (process.platform !== "win32") {
      const dirMode = fs.statSync(path.dirname(file)).mode & 0o777;
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(mode, 0o600);
    }
    assert.equal(config.clearConfig(), true);
    assert.equal(config.readConfig(), null);
  } finally {
    delete process.env.SYNAPSE_CLI_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
