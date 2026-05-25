// redactJson walks an arbitrary JSON value and replaces the value of any
// suspiciously-named key with "[redacted]". Defense-in-depth for the State &
// Drift / OperationRuns UI: the backend already keeps secrets out of
// diff/plan/result JSON, but the dashboard renders whatever it receives, so we
// scrub here too before anything reaches the DOM.
//
// Matched (case-insensitive substring): token, secret, password, key, env,
// admin, instance, database. Note "key" deliberately catches adminKey /
// instanceSecret / *_key — the trade-off (redacting an innocent "key" field) is
// acceptable for a diagnostics view where no real secret should ever appear.
const SENSITIVE = [
  "token",
  "secret",
  "password",
  "key",
  "env",
  "admin",
  "instance",
  "database",
];

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE.some((bad) => k.includes(bad));
}

export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactJson);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? "[redacted]" : redactJson(v);
    }
    return out;
  }
  return value;
}

// safeStringify pretty-prints a redacted value, tolerating cycles.
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(redactJson(value), null, 2);
  } catch {
    return "[unserializable]";
  }
}
