"use client";

import { safeStringify } from "@/lib/redact";

// JsonDetails renders a small JSON object inside a collapsed <details>, with
// sensitive keys redacted (see lib/redact). Used for drift diffs and operation
// run input/plan/result so the raw payload never floods the page and never
// leaks a token/secret that slipped through.
export function JsonDetails({
  label,
  value,
  testId,
}: {
  label: string;
  value: unknown;
  testId?: string;
}) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && Object.keys(value as object).length === 0) {
    return null;
  }
  return (
    <details className="group" data-testid={testId}>
      <summary className="cursor-pointer select-none text-[11px] text-neutral-400 hover:text-neutral-200">
        {label}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded border border-neutral-800/80 bg-neutral-950/60 p-2 text-[11px] leading-relaxed text-neutral-300">
        {safeStringify(value)}
      </pre>
    </details>
  );
}
