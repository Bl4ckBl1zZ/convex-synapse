// The planner turns a Detection object (see detect.js) into a list
// of Steps the executor can run. Steps are declarative records the
// preview UI can also print without executing — enabling --dry-run
// and -v shows for free.
//
// Each Step is shaped:
//   {
//     id:          string,         // stable; logs key off this
//     title:       string,         // human-readable one-liner
//     kind:        "exec" | "skip" | "blocker" | "warn",
//     reason:      string,         // why we chose this path
//     run?:        (ctx) => Promise<{ changed, ... }>
//     skipReason?: string,         // why we're NOT running
//     blocker?:    string,         // why the whole plan is blocked
//   }
//
// `kind: blocker` halts the plan before execution (e.g. mkcert
// missing — we can't proceed). The executor refuses to run if any
// blocker is present.

const fs = require("node:fs");
const path = require("node:path");
const detectMod = require("./detect");
const mkcertMod = require("./mkcert");
const hostsMod = require("./hosts");
const nextjsMod = require("./nextjs");

// Maps a detected platform + pkg manager combo to the canonical
// install instructions for mkcert. We don't auto-install (mutating
// pkg managers from a CLI feels wrong); we just print the command.
function mkcertInstallHint(detection) {
  const { id } = detection.platform;
  const managers = detection.packageManagers;
  if (id === "linux" || id === "wsl") {
    if (managers.includes("pacman")) return "sudo pacman -S mkcert nss";
    if (managers.includes("apt-get")) return "sudo apt-get install mkcert libnss3-tools";
    if (managers.includes("dnf")) return "sudo dnf install mkcert nss-tools";
    if (managers.includes("yum")) return "sudo yum install mkcert nss-tools";
    if (managers.includes("zypper")) return "sudo zypper install mkcert mozilla-nss-tools";
    if (managers.includes("apk")) return "sudo apk add mkcert nss-tools";
    return "Install mkcert from https://github.com/FiloSottile/mkcert/releases";
  }
  if (id === "macos") {
    if (managers.includes("brew")) return "brew install mkcert nss";
    return "Install Homebrew (https://brew.sh) then run: brew install mkcert nss";
  }
  if (id === "windows") {
    if (managers.includes("scoop")) return "scoop bucket add extras && scoop install mkcert";
    if (managers.includes("choco")) return "choco install mkcert";
    if (managers.includes("winget")) return "winget install FiloSottile.mkcert";
    return "Install mkcert: https://github.com/FiloSottile/mkcert/releases (download the .exe to a PATH directory)";
  }
  return "Install mkcert from https://github.com/FiloSottile/mkcert/releases";
}

// Computes the canonical dev:https script for a domain + cert path
// pair. Always uses POSIX-style forward slashes — Next.js accepts
// them on Windows too, and they make the script identical across
// platforms (so a project shared between Linux + Windows partners
// reads the same).
function devHttpsCommandFor(detection, domain) {
  const { certPath, keyPath } = detection.existingCerts || detectMod.certFilesFor(domain);
  // Convert to posix path style; on Linux/macOS this is a no-op.
  const toPosix = (p) => p.replace(/\\/g, "/");
  return detectMod.buildDevHttpsScript(domain, toPosix(certPath), toPosix(keyPath));
}

// The main entry. Given a detection + options, returns an array of
// Steps. Caller decides whether to print, prompt, then execute.
function plan(detection, {
  force = false,
  skipHosts = false,
  skipScript = false,
} = {}) {
  const steps = [];

  // ---- Pre-validate (blockers go first) ------------------------------
  if (!detection.validation.ok) {
    steps.push({
      id: "validate",
      title: "Validate domain",
      kind: "blocker",
      reason: detection.validation.reason,
      blocker: detection.validation.reason,
    });
    return steps;
  }
  if (!detection.mkcert.present) {
    const hint = mkcertInstallHint(detection);
    steps.push({
      id: "mkcert-missing",
      title: "mkcert installed",
      kind: "blocker",
      reason: "mkcert not found in PATH",
      blocker: `mkcert is required but not installed. Run:\n  ${hint}\nThen re-run \`synapse https setup\`.`,
    });
    return steps;
  }

  // ---- Step: mkcert -install (CA trust) ------------------------------
  if (!detection.caTrusted) {
    steps.push({
      id: "ca-install",
      title: "Install local CA into system + browser trust stores (mkcert -install)",
      kind: "exec",
      reason: "rootCA.pem not present in mkcert's CAROOT — first-time setup",
      async run() {
        return mkcertMod.installCA();
      },
    });
  } else {
    steps.push({
      id: "ca-install",
      title: "Install local CA",
      kind: "skip",
      reason: "CA already trusted (rootCA.pem present)",
      skipReason: "idempotent",
    });
  }
  // Firefox/NSS reminder — not a blocker, just a warning.
  if (!detection.hasCertutil && (detection.platform.id === "linux" || detection.platform.id === "wsl")) {
    steps.push({
      id: "nss-warn",
      title: "Firefox trust (NSS)",
      kind: "warn",
      reason:
        "certutil not found — Firefox uses a separate NSS DB. Without it, Chrome/Edge will trust the cert but Firefox won't.",
      skipReason:
        "Install NSS tools to fix Firefox trust on this machine (apt: libnss3-tools, pacman: nss, dnf: nss-tools), then re-run `mkcert -install`.",
    });
  }

  // ---- Step: ensure cert dir exists ----------------------------------
  const { dir: certDir, certPath, keyPath } = detection.existingCerts || detectMod.certFilesFor(detection.domain);
  if (!fs.existsSync(certDir)) {
    steps.push({
      id: "cert-dir",
      title: `Create ${certDir}`,
      kind: "exec",
      reason: "cert directory missing",
      async run() {
        fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
        return { changed: true };
      },
    });
  } else {
    steps.push({
      id: "cert-dir",
      title: `Cert directory ${certDir}`,
      kind: "skip",
      reason: "directory already exists",
      skipReason: "idempotent",
    });
  }

  // ---- Step: generate certificate ------------------------------------
  const certPresent =
    detection.existingCerts && detection.existingCerts.present && !force;
  if (certPresent) {
    steps.push({
      id: "cert-generate",
      title: `Generate cert pair for ${detection.domain}`,
      kind: "skip",
      reason: "cert + key already exist in canonical location",
      skipReason:
        "use `synapse https setup <domain> --force` to regenerate (invalidates the current cert).",
    });
  } else {
    steps.push({
      id: "cert-generate",
      title: `Generate cert pair for ${detection.domain} (mkcert)`,
      kind: "exec",
      reason: force ? "--force: regenerating" : "no cert present in canonical location",
      async run() {
        return mkcertMod.generateCert({
          domain: detection.domain,
          certPath,
          keyPath,
        });
      },
    });
  }

  // ---- Step: hosts file ----------------------------------------------
  if (skipHosts) {
    steps.push({
      id: "hosts",
      title: "Hosts file entry",
      kind: "skip",
      reason: "--skip-hosts requested",
      skipReason: "operator opted out",
    });
  } else if (
    detection.resolution.resolvesToLoopback &&
    detection.resolution.source === "dns"
  ) {
    steps.push({
      id: "hosts",
      title: "Hosts file entry",
      kind: "skip",
      reason: `${detection.domain} already resolves to 127.0.0.1 via public DNS`,
      skipReason:
        "no hosts edit needed — DNS A record points at loopback (any machine on any OS resolves correctly)",
    });
  } else if (detection.hosts.matches.some((m) => m.address === "127.0.0.1")) {
    steps.push({
      id: "hosts",
      title: "Hosts file entry",
      kind: "skip",
      reason: `${detection.hosts.path} already maps ${detection.domain} to 127.0.0.1`,
      skipReason: "entry present",
    });
  } else {
    const needsElevation = !detection.hosts.writable;
    steps.push({
      id: "hosts",
      title: `Add "127.0.0.1 ${detection.domain}" to ${detection.hosts.path}`,
      kind: "exec",
      reason: needsElevation
        ? `${detection.hosts.path} requires elevation (sudo/Administrator)`
        : "writable directly",
      async run() {
        return hostsMod.addEntry(detection.hosts.path, detection.domain);
      },
    });
  }

  // ---- Step: WSL Windows hosts companion -----------------------------
  if (
    detection.platform.id === "wsl" &&
    detection.wslWindowsHosts &&
    detection.wslWindowsHosts.exists &&
    !detection.wslWindowsHosts.matches.some((m) => m.address === "127.0.0.1") &&
    !detection.resolution.resolvesToLoopback
  ) {
    steps.push({
      id: "hosts-wsl",
      title: `Add Windows-side hosts entry (${detection.wslWindowsHosts.path})`,
      kind: "warn",
      reason:
        "WSL Linux hosts file does NOT affect Windows browsers. Edit the Windows hosts file from a Windows Administrator shell:",
      skipReason: `Open PowerShell as Administrator and append: 127.0.0.1\t${detection.domain} to ${detection.wslWindowsHosts.path}`,
    });
  }

  // ---- Step: package.json script -------------------------------------
  if (skipScript) {
    steps.push({
      id: "script",
      title: "package.json dev:https",
      kind: "skip",
      reason: "--skip-script requested",
      skipReason: "operator opted out",
    });
  } else if (!detection.pkg.present) {
    steps.push({
      id: "script",
      title: "package.json dev:https",
      kind: "skip",
      reason: "no package.json in cwd",
      skipReason: `cd into your Next.js project, then re-run, OR add manually:\n  "dev:https": "${devHttpsCommandFor(detection, detection.domain)}"`,
    });
  } else if (!detection.pkg.hasNext) {
    steps.push({
      id: "script",
      title: "package.json dev:https",
      kind: "warn",
      reason: "package.json present but `next` not in dependencies",
      skipReason:
        "not a Next.js project — skipping the dev:https script. The cert is still ready in ~/.config/dev-certs.",
    });
  } else {
    const command = devHttpsCommandFor(detection, detection.domain);
    const existing = detection.pkg.existingDevHttps;
    if (existing && detectMod.devHttpsScriptsEqual(existing, command)) {
      steps.push({
        id: "script",
        title: "package.json dev:https",
        kind: "skip",
        reason: "script already matches the canonical command",
        skipReason: "idempotent",
      });
    } else {
      steps.push({
        id: "script",
        title: existing
          ? "Update package.json dev:https script"
          : "Add package.json dev:https script",
        kind: "exec",
        reason: existing
          ? `existing script differs from canonical — will replace.\n  before: ${existing}\n  after:  ${command}`
          : "no dev:https script in package.json",
        async run() {
          return nextjsMod.setDevHttpsScript(detection.pkg.path, command);
        },
      });
    }
  }

  // ---- Step: legacy cert migration hint ------------------------------
  if (detection.legacyCerts && detection.legacyCerts.length > 0) {
    const names = detection.legacyCerts.map((c) => c.domain).join(", ");
    steps.push({
      id: "legacy-warn",
      title: "Legacy certs detected in project root",
      kind: "warn",
      reason: `Found ${detection.legacyCerts.length} legacy cert pair(s) in cwd: ${names}`,
      skipReason:
        "Run `synapse https migrate` to move them under ~/.config/dev-certs/ and update package.json paths.",
    });
  }

  return steps;
}

// Used by the remove command. Generates an undo plan symmetric to
// the setup plan: removes cert files, hosts entry, dev:https script.
function planRemove(detection, { keepCerts = false, keepScript = false, keepHosts = false } = {}) {
  const steps = [];
  if (!detection.validation.ok) {
    steps.push({
      id: "validate",
      title: "Validate domain",
      kind: "blocker",
      reason: detection.validation.reason,
      blocker: detection.validation.reason,
    });
    return steps;
  }
  const { dir: certDir, certPath, keyPath } = detection.existingCerts || detectMod.certFilesFor(detection.domain);

  if (!keepCerts) {
    if (detection.existingCerts && detection.existingCerts.present) {
      steps.push({
        id: "cert-remove",
        title: `Delete ${certDir}`,
        kind: "exec",
        reason: "cert present in canonical location",
        async run() {
          fs.rmSync(certDir, { recursive: true, force: true });
          return { changed: true };
        },
      });
    } else {
      steps.push({
        id: "cert-remove",
        title: "Delete cert directory",
        kind: "skip",
        reason: "no cert present in canonical location",
        skipReason: "nothing to delete",
      });
    }
  }

  if (!keepHosts) {
    if (detection.hosts.matches.length > 0) {
      steps.push({
        id: "hosts-remove",
        title: `Remove ${detection.domain} from ${detection.hosts.path}`,
        kind: "exec",
        reason: "managed hosts entry present",
        async run() {
          return hostsMod.removeEntry(detection.hosts.path, detection.domain);
        },
      });
    } else {
      steps.push({
        id: "hosts-remove",
        title: "Remove hosts entry",
        kind: "skip",
        reason: "no entry found",
        skipReason: "nothing to remove",
      });
    }
  }

  if (!keepScript) {
    if (detection.pkg.existingDevHttps) {
      steps.push({
        id: "script-remove",
        title: "Remove dev:https script from package.json",
        kind: "exec",
        reason: "script present",
        async run() {
          return nextjsMod.removeDevHttpsScript(detection.pkg.path);
        },
      });
    } else {
      steps.push({
        id: "script-remove",
        title: "Remove dev:https script",
        kind: "skip",
        reason: "no script present",
        skipReason: "nothing to remove",
      });
    }
  }
  return steps;
}

// Tells the caller whether the plan is executable (no blockers).
function planIsExecutable(steps) {
  return steps.every((s) => s.kind !== "blocker");
}

module.exports = {
  plan,
  planRemove,
  planIsExecutable,
  mkcertInstallHint,
  devHttpsCommandFor,
};
