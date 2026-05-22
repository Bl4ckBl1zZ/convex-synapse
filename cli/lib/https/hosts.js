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

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

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

// Reads a hosts file in a way that survives missing files (returns
// empty string instead of throwing).
function readHosts(hostsPath) {
  try {
    return fs.readFileSync(hostsPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw new HostsError(`Could not read ${hostsPath}: ${err.message}`, { kind: "permission" });
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
// `writeImpl` is injected for tests.
function writeHosts(hostsPath, content, {
  elevation = "auto",
  writeImpl = fs.writeFileSync,
  execImpl = execFileSync,
  platform = process.platform,
} = {}) {
  // Try direct write first (fast path).
  if (elevation !== "always") {
    try {
      writeImpl(hostsPath, content);
      return { method: "direct", elevated: false };
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

  if (platform === "win32") {
    return writeHostsViaRunAs(hostsPath, content, { execImpl });
  }
  return writeHostsViaSudo(hostsPath, content, { execImpl });
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
  // PowerShell script (single-line, double-quote-friendly):
  //   Copy-Item <hosts> <backup>; Move-Item -Force <tmp> <hosts>
  const script = [
    `try {`,
    `  Copy-Item -LiteralPath '${hostsPath}' -Destination '${backupPath}' -ErrorAction Stop;`,
    `  Move-Item -LiteralPath '${tmpFile}' -Destination '${hostsPath}' -Force -ErrorAction Stop;`,
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

// One-shot "add a domain" patch. Idempotent.
function addEntry(hostsPath, domain, opts = {}) {
  const current = readHosts(hostsPath);
  const plan = planAddEntry(current, domain);
  if (!plan.changed) {
    return { changed: false, reason: plan.reason };
  }
  const next = plan.lines.join("\n");
  const result = writeHosts(hostsPath, next, opts);
  return { changed: true, reason: plan.reason, ...result };
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
  planAddEntry,
  planRemoveEntry,
  readHosts,
  writeHosts,
  writeHostsViaSudo,
  writeHostsViaRunAs,
  addEntry,
  removeEntry,
};
