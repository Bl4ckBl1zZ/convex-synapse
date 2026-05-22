// package.json mutator. Adds / updates / removes the `dev:https`
// script. Preserves formatting (indentation + trailing newline) so
// the diff in the operator's git stays readable.

const fs = require("node:fs");

const SCRIPT_NAME = "dev:https";

// Reads cwd/package.json, returns { exists, raw, parsed, indent,
// finalNewline }. We need the formatting hints so the rewrite
// doesn't churn whitespace.
function readPackageJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, raw: null, parsed: null, indent: "  ", finalNewline: true };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  // Detect indent: look at the first nested key's leading whitespace.
  // Falls back to 2 spaces (npm default).
  let indent = "  ";
  const match = raw.match(/\n([ \t]+)"/);
  if (match) indent = match[1];
  const finalNewline = raw.endsWith("\n");
  return { exists: true, raw, parsed, indent, finalNewline };
}

// Writes a JSON object back to disk with the requested indent and
// trailing newline. Preserves the on-disk shape we read.
function writePackageJson(filePath, obj, { indent = "  ", finalNewline = true } = {}) {
  let body = JSON.stringify(obj, null, indent);
  if (finalNewline) body += "\n";
  fs.writeFileSync(filePath, body);
}

// Sets `scripts["dev:https"] = command`, returning { changed: bool,
// reason }. If the script already exists with the SAME command (mod
// whitespace), returns `changed: false` (idempotent).
function setDevHttpsScript(filePath, command) {
  const info = readPackageJson(filePath);
  if (!info.exists) {
    return { changed: false, reason: "package.json not found", written: false };
  }
  if (!info.parsed) {
    throw new Error(`${filePath} is not valid JSON — refusing to rewrite.`);
  }
  const parsed = info.parsed;
  parsed.scripts = parsed.scripts || {};
  const existing = parsed.scripts[SCRIPT_NAME];
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  if (existing && norm(existing) === norm(command)) {
    return { changed: false, reason: "script already matches" };
  }
  const before = existing || null;
  parsed.scripts[SCRIPT_NAME] = command;
  writePackageJson(filePath, parsed, info);
  return {
    changed: true,
    reason: existing ? "script updated" : "script added",
    before,
    after: command,
  };
}

// Removes `scripts["dev:https"]`. Returns { changed, reason }.
function removeDevHttpsScript(filePath) {
  const info = readPackageJson(filePath);
  if (!info.exists || !info.parsed) {
    return { changed: false, reason: "package.json not found or malformed" };
  }
  const parsed = info.parsed;
  if (!parsed.scripts || !(SCRIPT_NAME in parsed.scripts)) {
    return { changed: false, reason: "script not present" };
  }
  const before = parsed.scripts[SCRIPT_NAME];
  delete parsed.scripts[SCRIPT_NAME];
  writePackageJson(filePath, parsed, info);
  return { changed: true, reason: "script removed", before };
}

module.exports = {
  SCRIPT_NAME,
  readPackageJson,
  writePackageJson,
  setDevHttpsScript,
  removeDevHttpsScript,
};
