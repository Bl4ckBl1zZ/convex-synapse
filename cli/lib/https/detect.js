// `synapse https setup` — environment detection layer.
//
// Pure functions that probe the operator's machine and return a
// `Detection` record. The planner consumes this record and decides
// what steps to run; the executor runs the steps. Detection NEVER
// mutates anything — every function in this file is safe to call
// from `doctor` and `status` too.
//
// Every detection has a typed result. Callers should NEVER catch
// errors from these functions — anything thrown here is a bug
// (the helpers all degrade to a known "unknown"/"none" state).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, execSync } = require("node:child_process");
const dns = require("node:dns").promises;

// Where the operator's per-domain certs live. Centralised so every
// component agrees on the layout. Linux/macOS: `~/.config/dev-certs/`.
// Windows: Node's os.homedir() returns `C:\Users\<name>` and path.join
// produces backslashes — both work.
function certsRoot() {
  return path.join(os.homedir(), ".config", "dev-certs");
}

function certDirFor(domain) {
  return path.join(certsRoot(), domain);
}

function certFilesFor(domain) {
  const dir = certDirFor(domain);
  return {
    dir,
    cert: path.join(dir, `${domain}.pem`),
    key: path.join(dir, `${domain}-key.pem`),
  };
}

// ---- 1. OS + 2. package manager --------------------------------------

// Identifies the host OS in a way the planner can act on. We treat
// WSL as its own platform because the hosts-file story diverges
// fundamentally (Linux hosts file doesn't affect Windows browsers).
function detectPlatform() {
  const platform = process.platform;
  if (platform === "win32") return { id: "windows", node: platform };
  if (platform === "darwin") return { id: "macos", node: platform };
  if (platform === "linux") {
    // WSL exposes itself via /proc/version containing "Microsoft" or
    // "WSL". The detection is read-only and the file is always there.
    try {
      const ver = fs.readFileSync("/proc/version", "utf8").toLowerCase();
      if (ver.includes("microsoft") || ver.includes("wsl")) {
        return { id: "wsl", node: platform };
      }
    } catch {
      // /proc/version unreadable — assume plain Linux.
    }
    return { id: "linux", node: platform };
  }
  return { id: "unknown", node: platform };
}

// Detects available package managers in priority order. We don't try
// to pick "the" one — the planner just needs to know which tools the
// operator HAS so it can suggest the right install command. Returns
// a sorted array of manager ids; empty means "no package manager
// detected — fall back to binary download instructions".
function detectPackageManagers() {
  const candidates = {
    linux: ["pacman", "apt-get", "dnf", "yum", "zypper", "apk"],
    macos: ["brew"],
    windows: ["choco", "scoop", "winget"],
    wsl: ["pacman", "apt-get", "dnf"],
    unknown: [],
  };
  const platform = detectPlatform().id;
  const list = candidates[platform] || [];
  return list.filter((bin) => commandExists(bin));
}

function commandExists(bin) {
  // `which` works on Linux/macOS/WSL. Windows ships `where` instead.
  // Node 16+ has a portable shortcut via try/catch on the binary,
  // but `which`/`where` is fast and avoids hard-coding PATH lookup.
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(probe, [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---- 3. mkcert + 4. CA trusted ---------------------------------------

// Detects mkcert: binary path, version, CA root location. The CA
// root is the directory containing rootCA.pem; `mkcert -CAROOT`
// prints it.
function detectMkcert() {
  if (!commandExists("mkcert")) {
    return { present: false, version: null, caroot: null };
  }
  let version = null;
  let caroot = null;
  try {
    // mkcert writes the version to STDERR (!), so we capture both.
    const v = execFileSync("mkcert", ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    version = v || null;
  } catch (err) {
    // Some packages of mkcert print only the bare version; the older
    // ones don't have `-version`. Try without.
    try {
      const v = execFileSync("mkcert", ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      version = v || null;
    } catch {
      version = "unknown";
    }
  }
  try {
    caroot = execFileSync("mkcert", ["-CAROOT"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    caroot = null;
  }
  return { present: true, version, caroot };
}

// "Is the local CA trusted?" — mkcert -install is idempotent and
// non-destructive, so the safest signal is "rootCA.pem exists in
// the CAROOT directory". A more pedantic check would parse the
// system trust store, but the rootCA.pem presence is what mkcert
// itself uses to detect prior installs.
function detectCaTrusted(mkcert) {
  if (!mkcert.present || !mkcert.caroot) return false;
  try {
    return fs.existsSync(path.join(mkcert.caroot, "rootCA.pem"));
  } catch {
    return false;
  }
}

// ---- 5. NSS / certutil -----------------------------------------------

// Firefox uses its own cert DB (NSS), not the OS trust store. mkcert
// drives Firefox trust via `certutil` when it's available. Without
// certutil, mkcert -install still works for Chrome/Safari/Edge but
// Firefox needs manual import. We surface this so the planner can
// warn or auto-install libnss3-tools on Linux.
function detectCertutil() {
  return commandExists("certutil");
}

// ---- 6. Domain validation --------------------------------------------

// Validates the operator-supplied domain. Returns { ok, reason? }.
// Rules:
//   - hostname-shaped (letters, digits, dots, hyphens)
//   - has at least one dot (so "localhost" is rejected — that path
//     doesn't need mkcert)
//   - not an IP literal (1.2.3.4, ::1, etc)
//   - not "localhost" or "*.localhost"
//   - each label 1-63 chars, total ≤ 253 chars
//
// The shape mirrors RFC 1035 hostname grammar, leniently.
function validateDomain(domain) {
  if (typeof domain !== "string" || domain.trim() === "") {
    return { ok: false, reason: "Domain is empty." };
  }
  const d = domain.trim().toLowerCase();
  if (d === "localhost" || d.endsWith(".localhost")) {
    return {
      ok: false,
      reason:
        "localhost works without HTTPS; you don't need mkcert for it. Use a real domain like `dev.<project>.com`.",
    };
  }
  // Rough IPv4 check.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(d)) {
    return { ok: false, reason: "Use a hostname, not an IP." };
  }
  // IPv6-ish.
  if (d.includes(":")) {
    return { ok: false, reason: "Use a hostname, not an IP." };
  }
  if (!d.includes(".")) {
    return {
      ok: false,
      reason: "Domain must include a dot (e.g. `dev.myproject.com`).",
    };
  }
  if (d.length > 253) {
    return { ok: false, reason: "Domain exceeds 253 characters." };
  }
  const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  for (const label of d.split(".")) {
    if (!LABEL.test(label)) {
      return {
        ok: false,
        reason: `Invalid label "${label}" — letters/digits/hyphens only, no leading/trailing hyphen, ≤63 chars.`,
      };
    }
  }
  return { ok: true };
}

// ---- 7. DNS resolution -----------------------------------------------

// Does the domain already resolve to 127.0.0.1 via the OS resolver?
// We hit both DNS (dns.resolve4) and the OS resolver (dns.lookup) —
// the difference matters: hosts-file entries land in lookup() but
// NOT in resolve4(). Returns { resolvesToLoopback, source: "dns" |
// "hosts" | "none", got? }.
async function detectDomainResolution(domain) {
  // dns.lookup uses the OS resolver, which honours /etc/hosts.
  let lookupResult = null;
  try {
    lookupResult = await dns.lookup(domain, { all: true });
  } catch {
    lookupResult = [];
  }
  const lookupHasLoopback = lookupResult.some(
    (r) => r.address === "127.0.0.1" || r.address === "::1",
  );
  // dns.resolve4 hits the public DNS. If the public A record points
  // at 127.0.0.1 (legitimate trick — saves operators a hosts edit),
  // this returns it.
  let dnsResult = null;
  try {
    dnsResult = await dns.resolve4(domain);
  } catch {
    dnsResult = [];
  }
  const dnsHasLoopback = dnsResult.includes("127.0.0.1");

  if (dnsHasLoopback) {
    return { resolvesToLoopback: true, source: "dns", got: dnsResult };
  }
  if (lookupHasLoopback) {
    return { resolvesToLoopback: true, source: "hosts", got: lookupResult.map((r) => r.address) };
  }
  return {
    resolvesToLoopback: false,
    source: "none",
    got: [...new Set([...dnsResult, ...lookupResult.map((r) => r.address)])],
  };
}

// ---- 8/9/10. Hosts file ----------------------------------------------

// Returns the canonical hosts file path for the running OS. WSL is
// special: /etc/hosts only affects the Linux side. To make a domain
// resolve in Windows browsers from inside WSL2, the operator would
// also need to edit `C:\Windows\System32\drivers\etc\hosts` (and
// our writer would need to reach it via the `/mnt/c/` mount).
function detectHostsPath() {
  const platform = detectPlatform().id;
  if (platform === "windows") {
    const root = process.env.SystemRoot || "C:\\Windows";
    return path.join(root, "System32", "drivers", "etc", "hosts");
  }
  // WSL: return the Linux path; the WSL companion path is reported
  // separately via detectWslWindowsHosts().
  return "/etc/hosts";
}

// For WSL: probe the Windows-side hosts file via /mnt/c/. Returns
// the path if accessible; null otherwise.
function detectWslWindowsHosts() {
  if (detectPlatform().id !== "wsl") return null;
  const candidates = [
    "/mnt/c/Windows/System32/drivers/etc/hosts",
    "/mnt/c/WINDOWS/System32/drivers/etc/hosts",
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // skip
    }
  }
  return null;
}

// Reads the hosts file and reports:
//   - exists: bool
//   - readable: bool
//   - writable: bool (process can write WITHOUT elevation)
//   - matches: array of { line, address, hostnames[] } whose
//     hostnames include the queried domain
//   - allLines: raw lines (planner uses them to compute the patch)
function detectHostsForDomain(domain, hostsPath) {
  const result = {
    path: hostsPath,
    exists: false,
    readable: false,
    writable: false,
    matches: [],
    allLines: [],
  };
  try {
    if (!fs.existsSync(hostsPath)) return result;
    result.exists = true;
    const content = fs.readFileSync(hostsPath, "utf8");
    result.readable = true;
    result.allLines = content.split(/\r?\n/);
    for (const raw of result.allLines) {
      if (!raw || raw.trim().startsWith("#")) continue;
      // hosts file rows: <address> <hostname> [<hostname> ...]
      const parts = raw.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const [address, ...hostnames] = parts;
      if (hostnames.map((h) => h.toLowerCase()).includes(domain.toLowerCase())) {
        result.matches.push({ line: raw, address, hostnames });
      }
    }
  } catch {
    // permission denied or otherwise — readable stays false.
  }
  try {
    fs.accessSync(hostsPath, fs.constants.W_OK);
    result.writable = true;
  } catch {
    // Not writable without elevation.
  }
  return result;
}

// ---- 11/12/13. package.json + Next.js + dev:https script ------------

// Reads cwd/package.json (read-only). Returns:
//   - present, parsed (object | null)
//   - hasNext, nextVersion (semver string or null)
//   - existingDevHttps (string | null) — the current value of
//     scripts["dev:https"], if any.
function detectPackageJson(cwd) {
  const file = path.join(cwd, "package.json");
  const result = {
    path: file,
    present: false,
    parsed: null,
    hasNext: false,
    nextVersion: null,
    existingDevHttps: null,
  };
  if (!fs.existsSync(file)) return result;
  result.present = true;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return result; // malformed JSON — leave parsed null
  }
  result.parsed = parsed;
  const allDeps = {
    ...(parsed.dependencies || {}),
    ...(parsed.devDependencies || {}),
    ...(parsed.peerDependencies || {}),
  };
  if (allDeps.next) {
    result.hasNext = true;
    result.nextVersion = allDeps.next;
  }
  if (parsed.scripts && typeof parsed.scripts["dev:https"] === "string") {
    result.existingDevHttps = parsed.scripts["dev:https"];
  }
  return result;
}

// Compares two `dev:https` script strings, ignoring whitespace
// differences. We use this to decide whether the existing script
// matches what we'd write — if it does, the step is a no-op.
function devHttpsScriptsEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

// Build the canonical `dev:https` script for a given domain. This is
// the source of truth — both `setup` (when writing) and `status`
// (when comparing) call this. Path uses POSIX forward slashes even
// on Windows because Node's path resolution accepts them.
function buildDevHttpsScript(domain, certFile, keyFile) {
  return `next dev --turbopack --hostname ${domain} --experimental-https --experimental-https-key ${keyFile} --experimental-https-cert ${certFile}`;
}

// ---- 14/15. Existing cert state --------------------------------------

// Probes the cert directory for an existing pair. Reports presence
// + best-effort expiry (we shell out to openssl when available; if
// not, just presence is enough — mkcert default expiry is 825 days
// and the planner errs on the side of "regenerate if asked").
function detectExistingCerts(domain) {
  const { dir, cert, key } = certFilesFor(domain);
  const present = fs.existsSync(cert) && fs.existsSync(key);
  let expiry = null;
  if (present && commandExists("openssl")) {
    try {
      const out = execFileSync(
        "openssl",
        ["x509", "-in", cert, "-noout", "-enddate"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      // Format: notAfter=Aug  1 12:00:00 2027 GMT
      const m = out.match(/notAfter=(.+)/);
      if (m) expiry = new Date(m[1]).toISOString();
    } catch {
      // openssl unavailable or cert unparseable — leave expiry null.
    }
  }
  return { dir, certPath: cert, keyPath: key, present, expiry };
}

// Scans `dir` for cert pairs at the top level (non-recursive). Two
// historical key-file conventions exist in the wild:
//   - `<domain>-key.pem` (mkcert default + most online tutorials)
//   - `<domain>.key.pem` (operator's hand-rolled convention)
//
// We pair `<domain>.pem` with EITHER variant — whichever exists.
// Returns array of { domain, cert, key, keyShape: "dash"|"dot" }.
function findCertPairsInDir(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const fileSet = new Set(files);
  const out = [];
  const seen = new Set();
  for (const f of files) {
    if (!f.endsWith(".pem")) continue;
    if (f.endsWith("-key.pem") || f.endsWith(".key.pem")) continue;
    const domain = f.slice(0, -".pem".length);
    if (seen.has(domain)) continue;
    const dashKey = `${domain}-key.pem`;
    const dotKey = `${domain}.key.pem`;
    if (fileSet.has(dashKey)) {
      out.push({
        domain,
        cert: path.join(dir, f),
        key: path.join(dir, dashKey),
        keyShape: "dash",
      });
      seen.add(domain);
    } else if (fileSet.has(dotKey)) {
      out.push({
        domain,
        cert: path.join(dir, f),
        key: path.join(dir, dotKey),
        keyShape: "dot",
      });
      seen.add(domain);
    }
  }
  return out;
}

// Cwd-only wrapper (back-compat name).
function detectLegacyCertsInCwd(cwd) {
  return findCertPairsInDir(cwd);
}

// Scans the canonical cert store for "flat" pairs (cert+key directly
// in the root instead of in a per-domain subdirectory). Useful for
// `https migrate --root` to reorganise an operator's existing setup
// without losing data.
function detectFlatCertsInStore() {
  return findCertPairsInDir(certsRoot());
}

// ---- 16. Cross-project domain conflict -------------------------------

// Returns true if `~/.config/dev-certs/` already has a directory for
// this domain owned by a different project. We can't actually tell
// "ownership" without scanning every package.json on disk, so we
// just report "cert exists under canonical path" — the planner uses
// this to warn that the cert will be reused.
function detectDomainAlreadyInCertStore(domain) {
  try {
    return fs.existsSync(certDirFor(domain));
  } catch {
    return false;
  }
}

// ---- elevation availability ------------------------------------------

// Best-effort: can we elevate? `sudo -n true` returns 0 if NOPASSWD
// is configured (no interactive prompt needed); non-zero otherwise.
// We don't actually run sudo here — the executor decides whether to
// prompt. This signal only feeds the preview ("you'll be prompted
// for your password" vs "elevation already cached").
function detectSudoCached() {
  if (detectPlatform().id === "windows") return false;
  try {
    execFileSync("sudo", ["-n", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Windows: is the current process running elevated? `net session`
// returns 0 from an admin shell; non-zero from a normal one. We use
// it as the "are we admin?" probe.
function detectWindowsAdmin() {
  if (detectPlatform().id !== "windows") return false;
  try {
    execSync("net session > nul 2>&1");
    return true;
  } catch {
    return false;
  }
}

// ---- Aggregate scan --------------------------------------------------

// The single entrypoint commands call. Builds a Detection object
// with everything the planner needs. Pure: zero mutations.
async function scan({ domain, cwd = process.cwd() } = {}) {
  const platform = detectPlatform();
  const packageManagers = detectPackageManagers();
  const mkcert = detectMkcert();
  const caTrusted = detectCaTrusted(mkcert);
  const hasCertutil = detectCertutil();

  const validation = domain ? validateDomain(domain) : { ok: false, reason: "no domain" };
  const resolution = domain && validation.ok
    ? await detectDomainResolution(domain)
    : { resolvesToLoopback: false, source: "none", got: [] };

  const hostsPath = detectHostsPath();
  const hostsState = detectHostsForDomain(domain || "", hostsPath);
  const wslWindowsHostsPath = detectWslWindowsHosts();
  const wslWindowsHostsState = wslWindowsHostsPath
    ? detectHostsForDomain(domain || "", wslWindowsHostsPath)
    : null;

  const pkg = detectPackageJson(cwd);
  const existingCerts = domain ? detectExistingCerts(domain) : null;
  const legacyCerts = detectLegacyCertsInCwd(cwd);
  const certStoreClash = domain ? detectDomainAlreadyInCertStore(domain) : false;

  return {
    domain: domain || null,
    cwd,
    platform,
    packageManagers,
    mkcert,
    caTrusted,
    hasCertutil,
    validation,
    resolution,
    hosts: hostsState,
    wslWindowsHosts: wslWindowsHostsState,
    pkg,
    existingCerts,
    legacyCerts,
    certStoreClash,
    sudoCached: detectSudoCached(),
    windowsAdmin: detectWindowsAdmin(),
  };
}

module.exports = {
  // Paths
  certsRoot,
  certDirFor,
  certFilesFor,
  // Detections (granular — exported for tests)
  detectPlatform,
  detectPackageManagers,
  detectMkcert,
  detectCaTrusted,
  detectCertutil,
  validateDomain,
  detectDomainResolution,
  detectHostsPath,
  detectWslWindowsHosts,
  detectHostsForDomain,
  detectPackageJson,
  detectExistingCerts,
  detectLegacyCertsInCwd,
  detectFlatCertsInStore,
  findCertPairsInDir,
  detectDomainAlreadyInCertStore,
  detectSudoCached,
  detectWindowsAdmin,
  commandExists,
  buildDevHttpsScript,
  devHttpsScriptsEqual,
  // Aggregate
  scan,
};
