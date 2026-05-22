// Thin wrapper around the `mkcert` binary. Every function here
// SHELLS OUT — keep them small, single-purpose, and easy to mock
// for tests via `spawnImpl`.
//
// Why a wrapper instead of inline execFile: most call sites care
// about stderr-vs-stdout, exit code, and structured errors. A
// single point of conversion to thrown errors keeps the planner
// + executor readable.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

class MkcertError extends Error {
  constructor(message, { exitCode, stderr } = {}) {
    super(message);
    this.name = "MkcertError";
    this.exitCode = exitCode ?? null;
    this.stderr = stderr ?? "";
  }
}

// Streams a child process and returns { code, stdout, stderr }.
// Resolves on exit (any code); rejects only on spawn failure (e.g.
// binary missing). Long-running children are unlikely here, but the
// pattern keeps us out of the execFileSync pit-of-no-control.
function runProcess(bin, args, { input, env, cwd, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: env || process.env,
      cwd: cwd || process.cwd(),
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

// `mkcert -install` — installs the local CA into the system trust
// store + browser stores. Idempotent: running on an already-trusted
// machine is a no-op and exits 0.
//
// Returns { ran: bool, output: string }. `ran: true` means we
// invoked the binary; we don't try to tell whether mkcert actually
// did work vs short-circuited (mkcert output is the only signal,
// and parsing it is fragile across versions).
async function installCA({ spawnImpl } = {}) {
  const { code, stdout, stderr } = await runProcess("mkcert", ["-install"], { spawnImpl });
  if (code !== 0) {
    throw new MkcertError(
      `mkcert -install failed (exit ${code}): ${stderr.trim() || stdout.trim()}`,
      { exitCode: code, stderr },
    );
  }
  return { ran: true, output: (stderr + stdout).trim() };
}

// `mkcert -cert-file <cert> -key-file <key> <domain> [<aliases...>]`
// Generates a leaf cert + private key for `domain`, writing both
// files to the requested paths. The PARENT DIRECTORY must exist —
// mkcert won't mkdir for us. Files are written with default modes;
// we chmod the key to 0600 post-write because mkcert v1.4.x writes
// 0644 on Linux/macOS (private key in 0644 is a foot-gun).
//
// Pre-existing files at the same paths are silently overwritten by
// mkcert — that's a caller responsibility to handle (we expose
// `force` via the planner).
async function generateCert({ domain, certPath, keyPath, aliases = [], spawnImpl } = {}) {
  // Defensive: ensure dir exists. The planner should have created it
  // already, but doubling up is cheap.
  fs.mkdirSync(path.dirname(certPath), { recursive: true, mode: 0o700 });
  const args = ["-cert-file", certPath, "-key-file", keyPath, domain, ...aliases];
  const { code, stdout, stderr } = await runProcess("mkcert", args, { spawnImpl });
  if (code !== 0) {
    throw new MkcertError(
      `mkcert failed to generate cert for ${domain} (exit ${code}): ${stderr.trim() || stdout.trim()}`,
      { exitCode: code, stderr },
    );
  }
  // Tighten permissions on the private key.
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Best-effort on filesystems without POSIX modes (Windows NTFS).
  }
  // Likewise lock down the directory itself.
  try {
    fs.chmodSync(path.dirname(keyPath), 0o700);
  } catch {
    // ignore on non-POSIX
  }
  return { certPath, keyPath, output: (stderr + stdout).trim() };
}

// `mkcert -CAROOT` — returns the directory containing rootCA.pem.
// Synchronous because the planner calls it during the scan phase
// (where we deliberately stay synchronous for predictable I/O
// ordering).
function caroot() {
  try {
    return execFileSync("mkcert", ["-CAROOT"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

module.exports = {
  MkcertError,
  runProcess, // exported for tests + executor (used elsewhere too)
  installCA,
  generateCert,
  caroot,
};
