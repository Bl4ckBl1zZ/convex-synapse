// Windows DNS deep-diagnosis layer (v1.13.0).
//
// Background: "the hosts file has the entry, ipconfig /flushdns ran,
// and getaddrinfo STILL returns ENOTFOUND" is not one bug — it's five
// different machine states that all look identical from the outside.
// v1.8.10 taught us BOM + ACL + stale cache; real-world Windows then
// produced machines where none of those was the cause. This module
// probes the remaining suspects so the doctor can NAME the culprit and
// the repair can attack the right one:
//
//   1. DataBasePath redirected — the registry key that tells the
//      resolver WHERE the hosts file lives. AV/VPN products move it;
//      we'd then be editing a file nobody reads.
//   2. Hosts encoding — we already reject UTF-8 BOMs, but PowerShell
//      5's Out-File/Set-Content write UTF-16 LE by default. A UTF-16
//      hosts file is silently ignored wholesale.
//   3. Dnscache service stopped/disabled ("optimizer" tools do this).
//   4. NRPT rules — corporate VPNs (Zscaler, GlobalProtect, Umbrella)
//      install Name Resolution Policy Table rules that route a
//      namespace's queries elsewhere, stepping over the hosts file.
//   5. DNS interceptors — LSP/WFP-level products that answer
//      getaddrinfo before the OS resolver ever sees the query. The
//      tell: the entry IS in `ipconfig /displaydns` (so the service
//      read the file fine) yet lookups still fail.
//
// Everything here is READ-ONLY and injectable for tests. The write
// side (control-probe repair) lives in hosts.js.

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const DEFAULT_DATABASE_PATH = "%SystemRoot%\\System32\\drivers\\etc";

// Expands %VAR% references the way the registry's REG_EXPAND_SZ does.
// Unknown vars are left as-is so a weird value still shows up
// readably in the diagnosis output.
function expandWindowsEnv(value, env = process.env) {
  return String(value || "").replace(/%([^%]+)%/g, (whole, name) => {
    const hit = env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()];
    return hit !== undefined ? hit : whole;
  });
}

function normWinPath(p) {
  return String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

// ---- 1. Registry DataBasePath -----------------------------------------

// Parses `reg query ...Tcpip\Parameters /v DataBasePath` output:
//
//   HKEY_LOCAL_MACHINE\...\Parameters
//       DataBasePath    REG_EXPAND_SZ    %SystemRoot%\System32\drivers\etc
//
// The value name and type are locale-stable (only surrounding chrome
// is localised), so anchoring on "DataBasePath" is safe on PT-BR
// Windows too.
function parseDataBasePath(regOutput, env = process.env) {
  const m = String(regOutput || "").match(
    /DataBasePath\s+REG(?:_EXPAND)?_SZ\s+(.+)/i,
  );
  if (!m) return null;
  const raw = m[1].trim();
  const expanded = expandWindowsEnv(raw, env);
  return { raw, expanded };
}

// Reads the resolver's hosts DIRECTORY from the registry and reports
// whether it's been redirected away from the canonical location.
// `hostsPath` is the file the resolver actually reads — repairs must
// target THIS, not the canonical path.
function readDataBasePath({ execImpl = execFileSync, env = process.env } = {}) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const canonicalDir = `${systemRoot}\\System32\\drivers\\etc`;
  const out = {
    checked: false,
    raw: null,
    dir: canonicalDir,
    hostsPath: `${canonicalDir}\\hosts`,
    redirected: false,
  };
  try {
    const stdout = execImpl(
      "reg",
      [
        "query",
        "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters",
        "/v",
        "DataBasePath",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    );
    const parsed = parseDataBasePath(stdout, env);
    out.checked = true;
    if (parsed) {
      out.raw = parsed.raw;
      out.dir = parsed.expanded;
      out.hostsPath = `${parsed.expanded.replace(/[\\/]+$/, "")}\\hosts`;
      out.redirected = normWinPath(parsed.expanded) !== normWinPath(canonicalDir);
    }
  } catch {
    // reg unavailable / access denied — stay unchecked, assume canonical.
  }
  return out;
}

// ---- 2. Hosts encoding -------------------------------------------------

// Inspects the first 4 KB of the hosts file at the BYTE level. The
// Windows resolver only reads ANSI/UTF-8; a UTF-16 file (with or
// without BOM) is ignored wholesale. Returns:
//   { checked, encoding: "utf8" | "utf8-bom" | "utf16le" | "utf16be"
//             | "binary-nul", resolverReadable: bool }
function scanHostsEncoding(hostsPath, { readImpl } = {}) {
  const out = { checked: false, encoding: "utf8", resolverReadable: true };
  let buf;
  try {
    if (readImpl) {
      buf = readImpl(hostsPath);
    } else {
      const fd = fs.openSync(hostsPath, "r");
      try {
        buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, 4096, 0);
        buf = buf.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return out; // unreadable — leave unchecked
  }
  out.checked = true;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    out.encoding = "utf16le";
    out.resolverReadable = false;
    return out;
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    out.encoding = "utf16be";
    out.resolverReadable = false;
    return out;
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    // UTF-8 BOM: the file body is readable but the first row is
    // poisoned and several Windows builds drop the whole file.
    out.encoding = "utf8-bom";
    out.resolverReadable = false;
    return out;
  }
  if (buf.includes(0)) {
    // NUL bytes without a BOM — UTF-16 written by a tool that skipped
    // the preamble, or binary corruption. Either way: unreadable.
    out.encoding = "binary-nul";
    out.resolverReadable = false;
    return out;
  }
  return out;
}

// ---- 3. Dnscache service + 4. NRPT (one PowerShell round-trip) --------

// PowerShell startup costs ~0.5-1s, so the service + NRPT probes share
// a single invocation. [string] casts force locale-independent enum
// names ("Running", "Automatic") instead of bare ints.
const PS_SERVICE_AND_NRPT = [
  "$out = @{};",
  "try { $out.nrpt = @(Get-DnsClientNrptRule | Select-Object -Property Namespace,NameServers) } catch { $out.nrpt = $null };",
  "try { $svc = Get-Service -Name Dnscache -ErrorAction Stop; $out.service = @{ status = [string]$svc.Status; startType = [string]$svc.StartType } } catch { $out.service = $null };",
  "$out | ConvertTo-Json -Depth 4 -Compress",
].join(" ");

// Pure parser for the combined JSON — exported for tests. Namespace
// entries look like ".corp.example.com" (suffix rules) or exact
// hostnames; NameServers is a string or array.
function parseServiceAndNrpt(jsonText, domain) {
  const out = {
    service: { checked: false, status: null, startType: null, healthy: true },
    nrpt: { checked: false, rules: [], matching: [] },
  };
  let parsed;
  try {
    parsed = JSON.parse(String(jsonText || "").trim());
  } catch {
    return out;
  }
  if (parsed && parsed.service && typeof parsed.service === "object") {
    out.service.checked = true;
    out.service.status = String(parsed.service.status || "");
    out.service.startType = String(parsed.service.startType || "");
    out.service.healthy =
      /running/i.test(out.service.status) && !/disabled/i.test(out.service.startType);
  }
  if (parsed && "nrpt" in parsed) {
    const rules = Array.isArray(parsed.nrpt)
      ? parsed.nrpt
      : parsed.nrpt
        ? [parsed.nrpt]
        : [];
    out.nrpt.checked = parsed.nrpt !== null;
    const domainLower = String(domain || "").toLowerCase();
    for (const r of rules) {
      if (!r) continue;
      const namespaces = Array.isArray(r.Namespace)
        ? r.Namespace
        : r.Namespace
          ? [r.Namespace]
          : [];
      const servers = Array.isArray(r.NameServers)
        ? r.NameServers
        : r.NameServers
          ? [r.NameServers]
          : [];
      const rule = { namespaces, servers };
      out.nrpt.rules.push(rule);
      const covers = namespaces.some((ns) => {
        const n = String(ns || "").toLowerCase();
        if (!n) return false;
        if (n.startsWith(".")) {
          return domainLower === n.slice(1) || domainLower.endsWith(n);
        }
        return domainLower === n;
      });
      if (covers && domainLower) out.nrpt.matching.push(rule);
    }
  }
  return out;
}

function probeServiceAndNrpt(domain, { execImpl = execFileSync } = {}) {
  try {
    const stdout = execImpl(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", PS_SERVICE_AND_NRPT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 },
    );
    return parseServiceAndNrpt(stdout, domain);
  } catch {
    return parseServiceAndNrpt(null, domain);
  }
}

// ---- 5. DNS Client cache contents --------------------------------------

// `ipconfig /displaydns` lists everything the Dnscache service holds —
// including the hosts-file entries it preloaded. That makes it the
// perfect READ-ONLY bisection signal:
//
//   entry present in cache + lookup still fails  → something answers
//     getaddrinfo before the service (VPN/AV interceptor)
//   entry absent from cache                       → the service never
//     loaded our row (encoding / ACL / redirected path / service down)
//
// Labels in the output are localised ("Record Name" / "Nome do
// registro"), so we don't anchor on them — we just look for the
// domain itself anywhere in the dump.
function dnsCacheHasEntry(domain, { execImpl = execFileSync } = {}) {
  const out = { checked: false, present: false };
  if (!domain) return out;
  try {
    const stdout = execImpl("ipconfig", ["/displaydns"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
      maxBuffer: 32 * 1024 * 1024,
    });
    out.checked = true;
    out.present = stdout.toLowerCase().includes(String(domain).toLowerCase());
  } catch {
    // displaydns exits non-zero when the cache is disabled — that
    // itself is a (weak) signal, but we can't distinguish it from
    // ipconfig being unavailable, so stay unchecked.
  }
  return out;
}

// ---- Aggregate + classification ----------------------------------------

// Runs every read-only probe. Only called on Windows, and only when
// the cheap signals already show "entry present but not resolving" —
// the PowerShell probes cost ~1-2s and aren't worth paying on the
// happy path. `dataBasePath` can be passed in when the caller already
// read it (detect.scan reads it unconditionally — it's cheap and
// decides which hosts file every other component looks at).
function collectProbes(domain, hostsPath, {
  execImpl = execFileSync,
  env = process.env,
  dataBasePath,
} = {}) {
  const dbp = dataBasePath || readDataBasePath({ execImpl, env });
  const encoding = scanHostsEncoding(dbp.redirected ? dbp.hostsPath : hostsPath);
  const cache = dnsCacheHasEntry(domain, { execImpl });
  const { service, nrpt } = probeServiceAndNrpt(domain, { execImpl });
  return { dataBasePath: dbp, encoding, cache, service, nrpt, deep: true };
}

// classifyResolutionFailure — the pure bisection. Given the probe
// results for a machine where the hosts entry EXISTS but the domain
// does NOT resolve, name the most likely cause. Ordering matters:
// each cause assumes the previous ones were ruled out.
//
// Returns { cause, summary, repairable, advice } where `cause` is a
// stable id tests assert on:
//   hosts-encoding | hosts-redirected | dnscache-service |
//   dns-interceptor | nrpt | stale-cache-or-acl
function classifyResolutionFailure(probes = {}) {
  const { dataBasePath, cache, service, nrpt } = probes;

  // The cheap BOM flag from the basic hosts scan doubles as an
  // encoding probe when the deep byte-level scan didn't run (or
  // couldn't read the file) — a BOM alone already explains the
  // failure.
  let encoding = probes.encoding;
  if ((!encoding || !encoding.checked) && probes.hostsHasBom) {
    encoding = { checked: true, encoding: "utf8-bom", resolverReadable: false };
  }

  if (encoding && encoding.checked && !encoding.resolverReadable) {
    const label =
      encoding.encoding === "utf8-bom"
        ? "a UTF-8 BOM"
        : encoding.encoding === "binary-nul"
          ? "NUL bytes (UTF-16 without BOM, or corruption)"
          : `${encoding.encoding.toUpperCase()} encoding`;
    return {
      cause: "hosts-encoding",
      repairable: true,
      summary: `the hosts file is saved with ${label} — the Windows resolver silently ignores the whole file (PowerShell's Out-File/Set-Content write UTF-16 by default; some editor saved it wrong)`,
      advice: "Rewriting the file as plain UTF-8 without BOM fixes this.",
    };
  }
  if (dataBasePath && dataBasePath.checked && dataBasePath.redirected) {
    return {
      cause: "hosts-redirected",
      repairable: true,
      summary: `the resolver doesn't read the canonical hosts file at all — the registry DataBasePath points it at "${dataBasePath.dir}" (usually an antivirus/VPN did this). Edits to the canonical file are invisible to Windows`,
      advice: `Writing the entry into the redirected file (${dataBasePath.hostsPath}) instead.`,
    };
  }
  if (service && service.checked && !service.healthy) {
    return {
      cause: "dnscache-service",
      repairable: true,
      summary: `the DNS Client service (Dnscache) is ${service.status || "not running"}${/disabled/i.test(service.startType || "") ? " and set to Disabled" : ""} — hosts entries aren't being served`,
      advice:
        "Restarting the service (and setting it back to Automatic if it was disabled) restores hosts-file resolution.",
    };
  }
  if (cache && cache.checked && cache.present) {
    return {
      cause: "dns-interceptor",
      repairable: false,
      summary:
        "the DNS Client service DID load the hosts entry (it shows in `ipconfig /displaydns`) yet lookups still fail — something is answering DNS *before* Windows' own resolver. Typical culprits: VPN clients (Zscaler, GlobalProtect, Cisco Umbrella) and antivirus 'web protection' modules",
      advice:
        "Pause/disable the VPN or AV DNS-protection module and retry — or sidestep local resolution entirely with a public A record for the dev domain pointing at 127.0.0.1.",
    };
  }
  if (nrpt && nrpt.checked && nrpt.matching.length > 0) {
    const ns = nrpt.matching
      .flatMap((r) => r.namespaces)
      .filter(Boolean)
      .join(", ");
    return {
      cause: "nrpt",
      repairable: false,
      summary: `a Name Resolution Policy Table rule covers this domain (namespace: ${ns}) — Windows routes its lookups to a policy DNS server, stepping over the hosts file. NRPT rules usually come from corporate VPN/management software`,
      advice:
        "Ask IT to exclude the dev domain from the NRPT rule, or use a public A record pointing the dev domain at 127.0.0.1 (works regardless of NRPT).",
    };
  }
  return {
    cause: "stale-cache-or-acl",
    repairable: true,
    summary:
      "no structural problem found — most likely a stubborn DNS Client cache or a hosts ACL the service can't read",
    advice:
      "Rewriting the file in place (regrants the read ACL), restarting the Dnscache service, and re-checking with a control entry.",
  };
}

module.exports = {
  DEFAULT_DATABASE_PATH,
  expandWindowsEnv,
  parseDataBasePath,
  readDataBasePath,
  scanHostsEncoding,
  PS_SERVICE_AND_NRPT,
  parseServiceAndNrpt,
  probeServiceAndNrpt,
  dnsCacheHasEntry,
  collectProbes,
  classifyResolutionFailure,
};
