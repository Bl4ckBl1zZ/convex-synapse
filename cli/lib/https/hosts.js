// Hosts file reader/writer. Crucial cross-platform piece.
//
// Linux/macOS:
//   - Path: /etc/hosts (owned by root, 0644)
//   - Write: needs sudo. We rebuild the file in memory, write to a
//     tmp file with `sudo tee`, then move into place atomically.
//
// Windows:
//   - Path: %SystemRoot%\System32\drivers\etc\hosts (owned by
//     TrustedInstaller, ACL'd to Administrators).
//   - Write: needs admin. If the parent process is NOT elevated,
//     we self-re-exec via PowerShell `Start-Process -Verb RunAs`
//     so a UAC prompt appears. Inside that elevated child, the
//     write is a plain fs.writeFileSync.
//
// WSL2:
//   - /etc/hosts of the Linux side does NOT affect Windows hosts.
//     If the operator runs the Linux Next.js dev server from WSL2,
//     the browser is on the Windows side — must edit the Windows
//     hosts file via /mnt/c/. We surface this as a second target.
//
// Every write goes through `applyPatch` which:
//   1. Reads current content (post-elevation if needed)
//   2. Computes the patched content
//   3. Diffs old-vs-new — bails if equal (idempotent)
//   4. Writes new content atomically (tmp + rename)
//   5. Returns { changed: bool, backupPath?: string }

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const dns = require("node:dns").promises;

class HostsError extends Error {
  constructor(message, { kind } = {}) {
    super(message);
    this.name = "HostsError";
    this.kind = kind || "unknown"; // permission | not_found | malformed | exec
  }
}

const MANAGED_BLOCK_START = "# === synapse https setup — managed entries ===";
const MANAGED_BLOCK_END = "# === end synapse https setup ===";

// Determine the hosts-file path for the OS. WSL returns the Linux
// path here; the Windows companion is handled separately.
function hostsPathForOS() {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || "C:\\Windows";
    return path.join(root, "System32", "drivers", "etc", "hosts");
  }
  return "/etc/hosts";
}

// Computes the patched hosts content for adding `127.0.0.1 <domain>`.
// We DO touch existing rows: if a different IP is already mapped to
// the same domain, we comment it out and append a new managed row.
// That avoids two-line resolution conflicts.
//
// Return { lines, changed: bool, reason }. `reason` explains the
// decision for the preview UI.
function planAddEntry(currentContent, domain) {
  const domainLower = String(domain || "").trim().toLowerCase();
  if (!domainLower) {
    throw new HostsError("planAddEntry: domain required", { kind: "malformed" });
  }
  const inputLines = String(currentContent || "").split(/\r?\n/);
  const lines = inputLines.slice();
  let alreadyHas = false;
  let conflict = null; // existing non-loopback row, if any
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw || raw.trim().startsWith("#")) continue;
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [address, ...hostnames] = parts;
    const lower = hostnames.map((h) => h.toLowerCase());
    if (lower.includes(domainLower)) {
      if (address === "127.0.0.1" || address === "::1") {
        alreadyHas = true;
      } else {
        conflict = { lineIndex: i, address, raw };
      }
    }
  }
  if (alreadyHas && !conflict) {
    return { lines: inputLines, changed: false, reason: "already mapped to loopback" };
  }
  // Comment out any conflict line so the new mapping wins.
  if (conflict) {
    lines[conflict.lineIndex] = `# ${conflict.raw}   # synapse: superseded by loopback`;
  }
  // Append in a "managed by synapse" block. We collapse multiple
  // blocks into one — if a previous run left a START marker, append
  // before the matching END; otherwise create a fresh block.
  const startIdx = lines.indexOf(MANAGED_BLOCK_START);
  const endIdx = lines.indexOf(MANAGED_BLOCK_END);
  const newRow = `127.0.0.1\t${domainLower}`;
  if (startIdx >= 0 && endIdx > startIdx) {
    // Insert before END, skipping if duplicate row exists inside.
    const inner = lines.slice(startIdx + 1, endIdx);
    if (inner.some((l) => l.replace(/\s+/g, " ").trim() === newRow.replace(/\s+/g, " "))) {
      return { lines: inputLines, changed: false, reason: "already in managed block" };
    }
    lines.splice(endIdx, 0, newRow);
  } else {
    // Drop trailing blank lines then append a fresh block.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push("");
    lines.push(MANAGED_BLOCK_START);
    lines.push(newRow);
    lines.push(MANAGED_BLOCK_END);
  }
  // Always end the file with a single newline.
  if (lines[lines.length - 1] !== "") lines.push("");
  return {
    lines,
    changed: true,
    reason: conflict
      ? `superseded existing non-loopback row (${conflict.address})`
      : "added new managed entry",
  };
}

// Computes the patched hosts content for removing a domain mapping
// we previously added. Removes:
//   - The exact `127.0.0.1 <domain>` row inside the managed block
//   - The block markers if the block becomes empty
//   - Does NOT touch rows OUTSIDE the managed block (so the operator
//     can keep their own manually-added entries untouched).
function planRemoveEntry(currentContent, domain) {
  const domainLower = String(domain || "").trim().toLowerCase();
  if (!domainLower) {
    throw new HostsError("planRemoveEntry: domain required", { kind: "malformed" });
  }
  const inputLines = String(currentContent || "").split(/\r?\n/);
  const startIdx = inputLines.indexOf(MANAGED_BLOCK_START);
  const endIdx = inputLines.indexOf(MANAGED_BLOCK_END);
  if (startIdx < 0 || endIdx < startIdx) {
    return { lines: inputLines, changed: false, reason: "no managed block" };
  }
  const before = inputLines.slice(0, startIdx);
  const inner = inputLines.slice(startIdx + 1, endIdx);
  const after = inputLines.slice(endIdx + 1);
  const filtered = inner.filter((l) => {
    if (!l || l.trim().startsWith("#")) return true;
    const parts = l.trim().split(/\s+/);
    return !parts.slice(1).map((h) => h.toLowerCase()).includes(domainLower);
  });
  if (filtered.length === inner.length) {
    return { lines: inputLines, changed: false, reason: "domain not in managed block" };
  }
  let next;
  if (filtered.length === 0) {
    // Drop the empty markers entirely.
    next = [...before, ...after];
    // Trim a single trailing blank from `before` to avoid two blanks
    // in a row where the block used to be.
    if (next.length > 0 && next[before.length - 1] === "") {
      next.splice(before.length - 1, 1);
    }
  } else {
    next = [...before, MANAGED_BLOCK_START, ...filtered, MANAGED_BLOCK_END, ...after];
  }
  // Always end with a single newline.
  if (next[next.length - 1] !== "") next.push("");
  return { lines: next, changed: true, reason: "removed managed entry" };
}

// Strips a leading UTF-8 BOM (U+FEFF) if present. The Windows hosts
// parser (and the Dnscache service) does NOT tolerate a BOM — a hosts
// file that starts with EF BB BF is silently ignored in its entirety,
// so even `host.docker.internal` stops resolving. Node's
// fs.readFileSync(path, "utf8") does NOT strip the BOM, so without
// this every read-modify-write cycle would faithfully preserve a BOM
// some other tool wrote, perpetuating the breakage. We strip on read
// and never emit one on write.
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Reads a hosts file in a way that survives missing files (returns
// empty string instead of throwing). Strips a leading BOM so the
// rest of the pipeline never sees one.
function readHosts(hostsPath) {
  try {
    return stripBom(fs.readFileSync(hostsPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw new HostsError(`Could not read ${hostsPath}: ${err.message}`, { kind: "permission" });
  }
}

// True if the file on disk begins with a UTF-8 BOM. Cheap 3-byte read;
// returns false on any error (missing file, permission). Used by the
// detector so the doctor can name "BOM" as the real cause instead of
// blaming a stale DNS cache.
function hasUtf8Bom(hostsPath) {
  try {
    const fd = fs.openSync(hostsPath, "r");
    try {
      const buf = Buffer.alloc(3);
      const n = fs.readSync(fd, buf, 0, 3, 0);
      return n === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// Best-effort DNS cache flush. On Windows the DNS Client (Dnscache)
// service caches lookups separately from the hosts file — editing
// /etc/hosts on Windows does NOT invalidate the cache, so `next dev`
// and Node's dns.lookup() can both return ENOTFOUND despite the
// entry being written correctly. This bit Matheus's Windows machine
// in real-world testing (v1.8.10 bug report).
//
// `ipconfig /flushdns` is safe to call without admin elevation on
// every Windows version since at least Windows 7, but we never let a
// failure here block the wider flow — it's a hint, not a guarantee.
function flushDnsCacheIfWindows({ execImpl = execFileSync, platform = process.platform } = {}) {
  if (platform !== "win32") return { ran: false, reason: "non-windows platform" };
  try {
    execImpl("ipconfig", ["/flushdns"], { stdio: "ignore", timeout: 5000 });
    return { ran: true };
  } catch (err) {
    return { ran: false, reason: err.message };
  }
}

// Writes content to the hosts file. Three strategies are tried in
// order based on the platform + the `elevation` knob:
//
//   1. Direct fs.writeFileSync (works if the process is already
//      privileged, OR if the file ACL allows the current user)
//   2. `sudo tee` via execFileSync (Linux/macOS)
//   3. PowerShell `Start-Process -Verb RunAs` (Windows non-admin)
//
// `elevation` can be:
//   - "auto" (default): try direct, fall back to sudo/RunAs
//   - "never": only try direct write; error if it fails
//   - "always": skip the direct write attempt
//
// On Windows we additionally:
//   - Normalise line endings to CRLF (the Windows hosts file
//     traditionally uses CRLF; some Windows components are tolerant
//     of LF but defensive normalisation costs nothing)
//   - Run `ipconfig /flushdns` after a successful write so the
//     DNS Client cache picks up the new entry immediately
//
// `writeImpl` is injected for tests.
function writeHosts(hostsPath, content, {
  elevation = "auto",
  writeImpl = fs.writeFileSync,
  execImpl = execFileSync,
  platform = process.platform,
} = {}) {
  // Defence in depth: never let a BOM reach disk. readHosts already
  // strips it, but a caller could hand us content assembled from a
  // BOM-carrying source.
  const noBom = stripBom(content);
  const onDiskContent =
    platform === "win32" ? noBom.replace(/\r?\n/g, "\r\n") : noBom;

  // Try direct write first (fast path).
  let result;
  if (elevation !== "always") {
    try {
      writeImpl(hostsPath, onDiskContent);
      result = { method: "direct", elevated: false };
    } catch (err) {
      if (elevation === "never") {
        throw new HostsError(
          `Cannot write ${hostsPath} without elevation: ${err.message}`,
          { kind: "permission" },
        );
      }
      // fall through to elevated
    }
  }

  if (!result) {
    if (platform === "win32") {
      result = writeHostsViaRunAs(hostsPath, onDiskContent, { execImpl });
    } else {
      result = writeHostsViaSudo(hostsPath, onDiskContent, { execImpl });
    }
  }

  // Post-write DNS cache flush (best-effort, Windows only). The
  // elevated runas path ALREADY flushes inside its PowerShell script
  // — see writeHostsViaRunAs. Calling here covers the direct-write
  // case (operator already in an elevated shell). Doubling up is
  // harmless: a second flush is a no-op.
  if (platform === "win32") {
    const flush = flushDnsCacheIfWindows({ execImpl, platform });
    result.dnsFlushed = flush.ran;
    if (!flush.ran) result.dnsFlushReason = flush.reason;
  }
  return result;
}

// Linux/macOS elevated write. We pipe the new content into `sudo
// tee <hosts>` via a heredoc-style stdin. `sudo` will prompt for
// the password interactively if not cached. Backup is created via
// `cp` BEFORE the write so a Ctrl+C mid-prompt leaves a recoverable
// state.
function writeHostsViaSudo(hostsPath, content, { execImpl = execFileSync } = {}) {
  const backupPath = `${hostsPath}.synapse-bak.${Date.now()}`;
  // 1. Backup. Best-effort — failing to backup STOPS the write so
  // we never write without a recovery path.
  try {
    execImpl("sudo", ["cp", hostsPath, backupPath], { stdio: "inherit" });
  } catch (err) {
    throw new HostsError(
      `Could not create backup at ${backupPath} (sudo failed): ${err.message}`,
      { kind: "exec" },
    );
  }
  // 2. Write a temp file in the user's tmpdir, then `sudo install`
  // it over the real hosts file. `install -m 0644` preserves the
  // canonical permissions; `mv` would lose them if /tmp is on a
  // different filesystem with stricter umask.
  const tmpFile = path.join(os.tmpdir(), `synapse-hosts-${Date.now()}.tmp`);
  fs.writeFileSync(tmpFile, content, { mode: 0o644 });
  try {
    execImpl("sudo", ["install", "-m", "0644", tmpFile, hostsPath], { stdio: "inherit" });
  } catch (err) {
    fs.rmSync(tmpFile, { force: true });
    throw new HostsError(
      `sudo install failed: ${err.message}. Backup is at ${backupPath} — restore with: sudo cp ${backupPath} ${hostsPath}`,
      { kind: "exec" },
    );
  }
  fs.rmSync(tmpFile, { force: true });
  return { method: "sudo", elevated: true, backupPath };
}

// Windows elevated write. We can't write to hosts from a non-admin
// process directly. Solution: spawn a brand-new PowerShell instance
// elevated via `Start-Process -Verb RunAs`, which triggers the UAC
// prompt. That elevated PowerShell runs a small script that writes
// the new content and exits.
//
// We pass the content via a temp file because piping it through
// PowerShell args would mean dealing with command-line length
// limits + complex quoting.
function writeHostsViaRunAs(hostsPath, content, { execImpl = execFileSync } = {}) {
  const tmpFile = path.join(os.tmpdir(), `synapse-hosts-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, content);
  const backupPath = `${hostsPath}.synapse-bak.${Date.now()}`;
  // PowerShell script — runs ELEVATED via Start-Process RunAs below.
  //   1. Copy current hosts to backup
  //   2. Write new content IN-PLACE over the existing hosts file
  //   3. Regrant read ACEs the Dnscache service needs
  //   4. ipconfig /flushdns
  //
  // Why in-place WriteAllText and NOT Move-Item -Force (the v1.8.10
  // approach): Move-Item replaces the destination inode with the temp
  // file, so the resulting hosts file inherits the ACL of %TEMP%,
  // DROPPING the read ACEs a normal hosts file carries
  // (BUILTIN\Users, ALL APPLICATION PACKAGES, and — transitively —
  // NT AUTHORITY\NETWORK SERVICE, the SID the Dnscache service runs
  // as, S-1-5-20). When those reads are missing, Dnscache can't open
  // the file and SILENTLY ignores the entire hosts file — not just our
  // entry, but host.docker.internal too. `ipconfig /flushdns` cannot
  // fix a read-permission problem. WriteAllText opens the existing
  // file (truncate-in-place), so the ACL is preserved.
  //
  // Step 3 regrants the read ACEs unconditionally (idempotent) so we
  // self-heal a hosts file whose ACL was previously clobbered — by an
  // older synapse, by a sandbox, or by any other tool. SIDs are used
  // instead of names so this works on PT-BR / EN / any-locale Windows:
  //   S-1-5-20      = NT AUTHORITY\NETWORK SERVICE (Dnscache)
  //   S-1-5-32-545  = BUILTIN\Users
  //   S-1-15-2-1    = APPLICATION PACKAGE AUTHORITY\ALL APPLICATION PACKAGES
  //
  // Content is written without a BOM: WriteAllText with a
  // UTF8Encoding($false) constructor emits no preamble. (Set-Content
  // / Out-File default to a BOM on Windows PowerShell 5.x, which is
  // exactly the breakage we're avoiding — so we go through .NET.)
  const script = [
    `try {`,
    `  Copy-Item -LiteralPath '${hostsPath}' -Destination '${backupPath}' -ErrorAction Stop;`,
    `  $c = [System.IO.File]::ReadAllText('${tmpFile}');`,
    `  $enc = New-Object System.Text.UTF8Encoding($false);`,
    `  [System.IO.File]::WriteAllText('${hostsPath}', $c, $enc);`,
    `  & icacls '${hostsPath}' /grant '*S-1-5-20:(RX)' '*S-1-5-32-545:(RX)' '*S-1-15-2-1:(RX)' | Out-Null;`,
    `  & ipconfig /flushdns | Out-Null;`,
    `  Remove-Item -LiteralPath '${tmpFile}' -Force -ErrorAction SilentlyContinue;`,
    `  exit 0`,
    `} catch {`,
    `  Write-Error $_.Exception.Message;`,
    `  exit 1`,
    `}`,
  ].join(" ");
  // Use Start-Process so the elevation prompt fires; -Wait so the
  // outer powershell waits for the elevated child to finish. The
  // outer is NOT elevated; only the inner one is.
  try {
    execImpl(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process powershell -ArgumentList '-NoProfile','-NonInteractive','-Command','${script.replace(/'/g, "''")}' -Verb RunAs -Wait`,
      ],
      { stdio: "inherit" },
    );
  } catch (err) {
    fs.rmSync(tmpFile, { force: true });
    throw new HostsError(
      `Could not run elevated PowerShell: ${err.message}. Manual fix: edit ${hostsPath} as Administrator and replace its contents from ${tmpFile} (if still present).`,
      { kind: "exec" },
    );
  }
  // The tmp file should be gone after the elevated Move-Item; if
  // the user cancelled UAC the tmp file stays and the original is
  // intact — detect that case by checking the hosts content.
  const after = readHosts(hostsPath);
  if (after !== content) {
    fs.rmSync(tmpFile, { force: true });
    throw new HostsError(
      "Hosts file unchanged after elevated write — UAC may have been cancelled. Re-run from an Administrator PowerShell, or accept the prompt next time.",
      { kind: "permission" },
    );
  }
  return { method: "runas", elevated: true, backupPath };
}

// Best-effort Dnscache service restart. One step stronger than
// `ipconfig /flushdns`: a restart drops the cache AND re-reads the
// hosts file, which unsticks service states a flush can't (observed
// on machines where the service had cached a bad read of the file).
// Win10/11 mark the service protected, so the restart can be refused
// even elevated — never let that block the flow.
function restartDnscacheIfWindows({ execImpl = execFileSync, platform = process.platform } = {}) {
  if (platform !== "win32") return { ran: false, reason: "non-windows platform" };
  try {
    execImpl(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Restart-Service -Name Dnscache -Force -ErrorAction Stop",
      ],
      { stdio: "ignore", timeout: 15000 },
    );
    return { ran: true };
  } catch (err) {
    return { ran: false, reason: err.message };
  }
}

// ---- Control-probe repair (v1.13.0) -----------------------------------
//
// The strongest possible "did the fix actually work?" signal: write a
// throwaway control entry (`127.0.0.1 synapse-probe-<rand>.invalid` —
// the .invalid TLD is RFC-reserved and can never resolve via real
// DNS) alongside the real entry, flush/restart, then resolve BOTH:
//
//   control ✓ + domain ✓ → fixed for real
//   control ✓ + domain ✗ → the hosts file WORKS; something targets
//     this specific name (NRPT rule / VPN split-DNS) — rewriting
//     harder will never help, so say so
//   control ✗            → Windows is ignoring the hosts file
//     entirely even after the rewrite (interceptor / redirected
//     path / policy) — flushdns roulette would be a lie
//
// The control entry is removed before returning (single UAC prompt:
// on the elevated path the whole dance happens inside one PowerShell
// script).

function makeControlName() {
  return `synapse-probe-${crypto.randomBytes(4).toString("hex")}.invalid`;
}

// Default verify: OS-level getaddrinfo, identical to what Next.js /
// Node will do. Returns the address list, or null when resolution
// failed.
async function defaultLookup(name) {
  try {
    const got = await dns.lookup(name, { all: true });
    return got.map((r) => r.address);
  } catch {
    return null;
  }
}

// Elevated repair: one UAC prompt runs the entire write→verify→clean
// sequence inside a single elevated PowerShell. Results come back via
// a temp file (`name=addr1,addr2` per line; empty addr list = failed)
// because Start-Process gives us no stdout channel.
function repairHostsViaRunAs(hostsPath, withControlContent, finalContent, verifyNames, {
  execImpl = execFileSync,
} = {}) {
  const stamp = Date.now();
  const tmpWith = path.join(os.tmpdir(), `synapse-hosts-${stamp}-probe.txt`);
  const tmpFinal = path.join(os.tmpdir(), `synapse-hosts-${stamp}-final.txt`);
  const resultFile = path.join(os.tmpdir(), `synapse-hosts-${stamp}-result.txt`);
  fs.writeFileSync(tmpWith, withControlContent);
  fs.writeFileSync(tmpFinal, finalContent);
  const backupPath = `${hostsPath}.synapse-bak.${stamp}`;
  const verifyPs = verifyNames
    .map(
      (n) =>
        `try { $a = ([System.Net.Dns]::GetHostAddresses('${n}') | ForEach-Object { $_.IPAddressToString }) -join ','; } catch { $a = ''; }; Add-Content -LiteralPath '${resultFile}' -Value ('${n}=' + $a) -Encoding Ascii;`,
    )
    .join(" ");
  const script = [
    `try {`,
    `  Copy-Item -LiteralPath '${hostsPath}' -Destination '${backupPath}' -ErrorAction Stop;`,
    `  $enc = New-Object System.Text.UTF8Encoding($false);`,
    // Phase 1: content WITH the control entry, ACL regrant, restart+flush.
    `  [System.IO.File]::WriteAllText('${hostsPath}', [System.IO.File]::ReadAllText('${tmpWith}'), $enc);`,
    `  & icacls '${hostsPath}' /grant '*S-1-5-20:(RX)' '*S-1-5-32-545:(RX)' '*S-1-15-2-1:(RX)' | Out-Null;`,
    `  Restart-Service -Name Dnscache -Force -ErrorAction SilentlyContinue;`,
    `  Start-Sleep -Milliseconds 500;`,
    `  & ipconfig /flushdns | Out-Null;`,
    // Phase 2: resolve every verify name via getaddrinfo (the same
    // call Node/Next make). Resolve-DnsName would be WRONG here — it
    // queries DNS servers directly and never consults the hosts file.
    `  ${verifyPs}`,
    // Phase 3: final content (control entry removed), flush again.
    `  [System.IO.File]::WriteAllText('${hostsPath}', [System.IO.File]::ReadAllText('${tmpFinal}'), $enc);`,
    `  & ipconfig /flushdns | Out-Null;`,
    `  Remove-Item -LiteralPath '${tmpWith}','${tmpFinal}' -Force -ErrorAction SilentlyContinue;`,
    `  exit 0`,
    `} catch {`,
    `  Write-Error $_.Exception.Message;`,
    `  exit 1`,
    `}`,
  ].join(" ");
  try {
    execImpl(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process powershell -ArgumentList '-NoProfile','-NonInteractive','-Command','${script.replace(/'/g, "''")}' -Verb RunAs -Wait`,
      ],
      { stdio: "inherit" },
    );
  } catch (err) {
    fs.rmSync(tmpWith, { force: true });
    fs.rmSync(tmpFinal, { force: true });
    fs.rmSync(resultFile, { force: true });
    throw new HostsError(
      `Could not run elevated PowerShell: ${err.message}.`,
      { kind: "exec" },
    );
  }
  // Parse the verify results the elevated child left behind. A missing
  // result file means UAC was cancelled (the script never ran).
  let verify = null;
  try {
    const raw = fs.readFileSync(resultFile, "utf8");
    verify = {};
    for (const line of raw.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const name = line.slice(0, eq).trim().toLowerCase();
      const addrs = line.slice(eq + 1).trim();
      verify[name] = addrs ? addrs.split(",").map((a) => a.trim()) : null;
    }
  } catch {
    verify = null;
  }
  fs.rmSync(resultFile, { force: true });
  if (verify === null) {
    throw new HostsError(
      "Hosts repair produced no result — the UAC prompt may have been cancelled. Re-run and accept the prompt, or run from an Administrator PowerShell.",
      { kind: "permission" },
    );
  }
  return { method: "runas", elevated: true, backupPath, verify };
}

// repairHostsResolution — the v1.13.0 "entry exists but doesn't
// resolve" path. Ensures the entry (resolving conflicts), embeds a
// control probe, rewrites without BOM + regrants ACL + restarts the
// Dnscache service + flushes, verifies BOTH names via getaddrinfo,
// and removes the control entry again. Returns:
//   { changed, method, controlResolved, domainResolved, addresses,
//     control, backupPath? }
//
// On Linux/macOS the control dance is unnecessary (glibc reads
// /etc/hosts on every call) — we just force-rewrite and verify the
// domain itself.
async function repairHostsResolution(hostsPath, domain, {
  platform = process.platform,
  execImpl = execFileSync,
  writeImpl = fs.writeFileSync,
  lookupImpl = defaultLookup,
  controlName,
  sleepMs = 500,
} = {}) {
  const domainLower = String(domain || "").trim().toLowerCase();
  const current = readHosts(hostsPath);
  const plan = planAddEntry(current, domainLower);
  const finalContent = (plan.changed ? plan.lines : current.split(/\r?\n/)).join("\n");

  if (platform !== "win32") {
    writeHosts(hostsPath, finalContent, { execImpl, writeImpl, platform });
    const addresses = await lookupImpl(domainLower);
    return {
      changed: plan.changed,
      method: "rewrite",
      controlResolved: null,
      domainResolved: addressesHitLoopback(addresses),
      addresses,
    };
  }

  const control = (controlName || makeControlName()).toLowerCase();
  const controlPlan = planAddEntry(finalContent, control);
  const withControlContent = controlPlan.lines.join("\n");
  const toCrlf = (s) => stripBom(s).replace(/\r?\n/g, "\r\n");

  // Fast path: the process can write the file directly (elevated
  // shell, or unusually permissive ACL). Same sequence as the RunAs
  // script, driven from Node.
  let direct = true;
  try {
    writeImpl(hostsPath, toCrlf(withControlContent));
  } catch {
    direct = false;
  }
  if (direct) {
    try {
      execImpl(
        "icacls",
        [hostsPath, "/grant", "*S-1-5-20:(RX)", "*S-1-5-32-545:(RX)", "*S-1-15-2-1:(RX)"],
        { stdio: "ignore", timeout: 10000 },
      );
    } catch {
      // best-effort — a non-admin direct write won't be able to icacls.
    }
    restartDnscacheIfWindows({ execImpl, platform });
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
    flushDnsCacheIfWindows({ execImpl, platform });
    const controlAddrs = await lookupImpl(control);
    const domainAddrs = await lookupImpl(domainLower);
    writeImpl(hostsPath, toCrlf(finalContent));
    flushDnsCacheIfWindows({ execImpl, platform });
    return {
      changed: plan.changed,
      method: "direct",
      control,
      controlResolved: addressesHitLoopback(controlAddrs),
      domainResolved: addressesHitLoopback(domainAddrs),
      addresses: domainAddrs,
    };
  }

  const ran = repairHostsViaRunAs(
    hostsPath,
    toCrlf(withControlContent),
    toCrlf(finalContent),
    [control, domainLower],
    { execImpl },
  );
  const controlAddrs = ran.verify ? ran.verify[control] : null;
  const domainAddrs = ran.verify ? ran.verify[domainLower] : null;
  return {
    changed: plan.changed,
    method: ran.method,
    control,
    controlResolved: addressesHitLoopback(controlAddrs),
    domainResolved: addressesHitLoopback(domainAddrs),
    addresses: domainAddrs,
    backupPath: ran.backupPath,
  };
}

function addressesHitLoopback(addresses) {
  if (!addresses || addresses.length === 0) return false;
  return addresses.some((a) => a === "127.0.0.1" || a === "::1");
}

// One-shot "add a domain" patch. Idempotent in content, but with a
// `force` escape hatch.
//
// `opts.force` (default false): when the entry is already present so
// the content wouldn't change, a normal call returns early WITHOUT
// touching the file. The "entry present but the name still doesn't
// resolve" repair path needs the opposite — it must re-write the file
// even when the content is identical, because the *act of writing* is
// what re-grants the read ACL, drops a stray BOM, and triggers the
// post-write `ipconfig /flushdns`. With `force: true` we write the
// (BOM-stripped, conflict-resolved) content back unconditionally.
function addEntry(hostsPath, domain, opts = {}) {
  const { force = false, ...writeOpts } = opts;
  const current = readHosts(hostsPath);
  const plan = planAddEntry(current, domain);
  if (!plan.changed && !force) {
    return { changed: false, reason: plan.reason };
  }
  // When forcing an unchanged file, write the current (already-correct,
  // BOM-stripped) content back so the side effects still fire.
  const next = plan.changed
    ? plan.lines.join("\n")
    : current.split(/\r?\n/).join("\n");
  const result = writeHosts(hostsPath, next, writeOpts);
  return {
    changed: plan.changed,
    forced: !plan.changed && force,
    reason: plan.changed ? plan.reason : "re-applied to repair resolution (ACL/BOM/cache)",
    ...result,
  };
}

// One-shot "remove a domain" patch. Idempotent.
function removeEntry(hostsPath, domain, opts = {}) {
  const current = readHosts(hostsPath);
  const plan = planRemoveEntry(current, domain);
  if (!plan.changed) {
    return { changed: false, reason: plan.reason };
  }
  const next = plan.lines.join("\n");
  const result = writeHosts(hostsPath, next, opts);
  return { changed: true, reason: plan.reason, ...result };
}

module.exports = {
  HostsError,
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  hostsPathForOS,
  flushDnsCacheIfWindows,
  restartDnscacheIfWindows,
  stripBom,
  hasUtf8Bom,
  planAddEntry,
  planRemoveEntry,
  readHosts,
  writeHosts,
  writeHostsViaSudo,
  writeHostsViaRunAs,
  repairHostsViaRunAs,
  repairHostsResolution,
  makeControlName,
  addressesHitLoopback,
  addEntry,
  removeEntry,
};
