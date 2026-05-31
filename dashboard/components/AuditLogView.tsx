"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import clsx from "clsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, type ActivityEvent, type ActivityResponse, type AuditEvent, type ListAuditLogResponse } from "@/lib/api";
import { useT } from "@/lib/i18n";

// AuditLogView — shared table used by:
//   - /teams/<ref>/audit              (team-wide audit, admin-only on the API)
//   - /teams/<ref>/<project>/settings/audit (project-scoped activity, member+)
//
// The two routes pass different `source` props:
//
//   { kind: "team", teamRef }                         → api.teams.auditLog
//   { kind: "project", projectId }                    → api.projects.activity
//
// Same renderer because the underlying event shape is essentially
// identical — both come from audit_events with optional metadata.
// v1.10.0 polished:
//   - Filter chips (actor / verb / target type / search)
//   - Date-range chips (today / 7d / 30d / all)
//   - Action icon + color tone (constructive/destructive/neutral)
//   - Group by day with a sticky-ish header row
//   - Expand row to show full metadata JSON
//   - Download as CSV or JSON (v1.10.0 Wave D)

type TeamSource = { kind: "team"; teamRef: string };
type ProjectSource = { kind: "project"; projectId: string };
export type AuditLogSource = TeamSource | ProjectSource;

type Props = {
  source: AuditLogSource;
  // When set, the component renders without the bordered Card chrome
  // (used inside the project settings shell which has its own chrome).
  embedded?: boolean;
};

// Normalised event shape the renderer consumes. Both audit_log and
// activity payloads map onto this — actorName is project-only, so it
// stays optional.
type NormalEvent = {
  id: string;
  createTime: string;
  action: string;
  actorId?: string;
  actorEmail?: string;
  actorName?: string;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  metadata?: Record<string, unknown>;
};

function normaliseTeam(e: AuditEvent): NormalEvent {
  return {
    id: e.id,
    createTime: e.createTime,
    action: e.action,
    actorId: e.actorId,
    actorEmail: e.actorEmail,
    targetType: e.targetType,
    targetId: e.targetId,
    metadata: e.metadata,
  };
}
function normaliseProject(e: ActivityEvent): NormalEvent {
  return {
    id: e.id,
    createTime: e.createTime,
    action: e.action,
    actorId: e.actorId,
    actorEmail: e.actorEmail,
    actorName: e.actorName,
    targetType: e.targetType,
    targetId: e.targetId,
    targetName: e.targetName,
    metadata: e.metadata,
  };
}

export function AuditLogView({ source, embedded = false }: Props) {
  const { t } = useT();
  const key =
    source.kind === "team"
      ? ["/audit", source.teamRef]
      : ["/project-audit", source.projectId];
  const fetcher =
    source.kind === "team"
      ? () => api.teams.auditLog(source.teamRef, { limit: 200 })
      : () => api.projects.activity(source.projectId, { limit: 200 });

  const { data, error, isLoading } = useSWR<ListAuditLogResponse | ActivityResponse>(
    key,
    fetcher,
    {
      refreshInterval: 30_000,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const events: NormalEvent[] = useMemo(() => {
    if (!data) return [];
    if ("items" in data) return (data as ListAuditLogResponse).items.map(normaliseTeam);
    return (data as ActivityResponse).events.map(normaliseProject);
  }, [data]);

  // --- Filter state ---
  const [actorFilter, setActorFilter] = useState<string>("");
  const [verbFilter, setVerbFilter] = useState<VerbBucket | "all">("all");
  const [targetFilter, setTargetFilter] = useState<string>("all");
  const [rangeFilter, setRangeFilter] = useState<RangeKey>("7d");
  const [searchText, setSearchText] = useState<string>("");

  // Actor + target type lists for the dropdowns — derived from data so
  // operators only see filters that actually have matches.
  const actorOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) {
      if (e.actorId) {
        map.set(e.actorId, e.actorName || e.actorEmail || e.actorId.slice(0, 8));
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [events]);

  const targetOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) {
      if (e.targetType) set.add(e.targetType);
    }
    return Array.from(set).sort();
  }, [events]);

  // Apply filters.
  const filtered = useMemo(() => {
    const now = Date.now();
    const rangeMs = RANGE_MS[rangeFilter];
    const search = searchText.trim().toLowerCase();
    return events.filter((e) => {
      if (actorFilter && e.actorId !== actorFilter) return false;
      if (verbFilter !== "all" && verbBucketOf(e.action) !== verbFilter) return false;
      if (targetFilter !== "all" && e.targetType !== targetFilter) return false;
      if (rangeMs != null) {
        const t = Date.parse(e.createTime);
        if (!Number.isFinite(t) || now - t > rangeMs) return false;
      }
      if (search) {
        const haystack = [
          e.action,
          e.actorEmail,
          e.actorName,
          e.targetType,
          e.targetId,
          e.targetName,
          e.metadata ? JSON.stringify(e.metadata) : "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }, [events, actorFilter, verbFilter, targetFilter, rangeFilter, searchText]);

  const grouped = useMemo(() => groupByDay(filtered), [filtered]);

  const Chrome = embedded ? FragmentShell : CardShell;

  return (
    <Chrome>
      {/* Header — title + summary + download */}
      <div className="flex items-center justify-between gap-4 border-b border-neutral-800/80 px-5 py-3.5">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-neutral-100">
            {source.kind === "team" ? t("Audit log") : t("Project activity")}
          </h3>
          <span className="text-xs text-neutral-500">
            {filtered.length} {filtered.length === 1 ? t("event") : t("events")}
            {events.length !== filtered.length && (
              <span className="text-neutral-600"> {t("(of {count})", { count: events.length })}</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ExportButton events={filtered} sourceKind={source.kind} />
        </div>
      </div>

      {/* Filter bar */}
      <div className="border-b border-neutral-800/80 px-5 py-3" data-testid="audit-filters">
        <div className="flex flex-wrap items-center gap-2">
          <RangeChips value={rangeFilter} onChange={setRangeFilter} />
          {actorOptions.length > 0 && (
            <FilterSelect
              value={actorFilter}
              onChange={setActorFilter}
              placeholder={t("All actors")}
              options={[
                { value: "", label: t("All actors") },
                ...actorOptions.map(([id, label]) => ({ value: id, label })),
              ]}
              testid="audit-filter-actor"
            />
          )}
          <FilterSelect
            value={verbFilter}
            onChange={(v) => setVerbFilter(v as VerbBucket | "all")}
            options={[
              { value: "all", label: t("All actions") },
              ...VERB_BUCKETS.map((b) => ({ value: b, label: t(VERB_LABEL[b]) })),
            ]}
            testid="audit-filter-verb"
          />
          {targetOptions.length > 0 && (
            <FilterSelect
              value={targetFilter}
              onChange={setTargetFilter}
              options={[
                { value: "all", label: t("All targets") },
                ...targetOptions.map((tt) => ({ value: tt, label: tt })),
              ]}
              testid="audit-filter-target"
            />
          )}
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder={t("Search metadata, names…")}
            className="h-7 flex-1 min-w-[160px] text-xs"
            data-testid="audit-filter-search"
          />
        </div>
      </div>

      {/* Body */}
      <div className="p-0">
        {isLoading && !data && (
          <div className="space-y-2 p-5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        )}
        {error instanceof ApiError && error.status === 403 && (
          <p className="px-5 py-6 text-sm text-neutral-300">
            {source.kind === "team"
              ? t("Only team admins can view the audit log.")
              : t("You don't have permission to view this project's activity.")}
          </p>
        )}
        {error && !(error instanceof ApiError && error.status === 403) && (
          <p className="px-5 py-6 text-sm text-red-400">
            {t("Failed to load audit log: {message}", { message: (error as Error).message })}
          </p>
        )}
        {data && filtered.length === 0 && (
          <p className="px-5 py-6 text-center text-sm text-neutral-500">
            {events.length === 0
              ? t("No audit events recorded yet.")
              : t("No events match the current filters.")}
          </p>
        )}
        {data && filtered.length > 0 && (
          <div className="divide-y divide-neutral-900" data-testid="audit-log-grouped">
            {grouped.map((dayGroup) => (
              <DaySection key={dayGroup.label} day={dayGroup} />
            ))}
          </div>
        )}
      </div>
    </Chrome>
  );
}

/* -------------------- Chrome wrappers -------------------- */

function CardShell({ children }: { children: React.ReactNode }) {
  return <Card className="overflow-hidden">{children}</Card>;
}
function FragmentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-800/80 bg-neutral-900/40">
      {children}
    </div>
  );
}

/* -------------------- Filter primitives -------------------- */

type RangeKey = "1d" | "7d" | "30d" | "all";
const RANGE_MS: Record<RangeKey, number | null> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};
const RANGE_LABEL: Record<RangeKey, string> = { "1d": "24h", "7d": "7 days", "30d": "30 days", all: "All time" };

function RangeChips({ value, onChange }: { value: RangeKey; onChange: (k: RangeKey) => void }) {
  const { t } = useT();
  return (
    <div className="inline-flex rounded-md border border-neutral-800 bg-neutral-950 p-0.5">
      {(["1d", "7d", "30d", "all"] as RangeKey[]).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={clsx(
            "rounded px-2 py-0.5 text-[11px] transition-colors",
            value === k
              ? "bg-violet-500/20 text-violet-200"
              : "text-neutral-400 hover:text-neutral-200",
          )}
          data-testid={`audit-range-${k}`}
        >
          {t(RANGE_LABEL[k])}
        </button>
      ))}
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
  testid,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  testid?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-[11px] text-neutral-200 focus:border-neutral-600 focus:outline-none"
      data-testid={testid}
    >
      {placeholder && options[0]?.value !== "" && (
        <option value="">{placeholder}</option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/* -------------------- Verb buckets -------------------- */

const VERB_BUCKETS = ["create", "delete", "update", "auth", "domain", "settings"] as const;
type VerbBucket = (typeof VERB_BUCKETS)[number];
const VERB_LABEL: Record<VerbBucket, string> = {
  create: "Create/Add",
  delete: "Delete/Remove",
  update: "Update/Rename",
  auth: "Members & Tokens",
  domain: "Domains & DNS",
  settings: "Settings",
};

function verbBucketOf(action: string): VerbBucket {
  const a = action.toLowerCase();
  if (a.startsWith("create") || a.startsWith("add") || a.startsWith("adopt")) return "create";
  if (a.startsWith("delete") || a.startsWith("remove") || a.startsWith("revoke") || a.startsWith("cancel")) return "delete";
  if (a.startsWith("update") || a.startsWith("rename") || a.startsWith("transfer") || a.startsWith("upgrade") || a.startsWith("reissue")) return "update";
  if (a.startsWith("invite") || a.startsWith("accept") || a.includes("token") || a.includes("member") || a === "login") return "auth";
  if (a.startsWith("domain") || a.includes("dns") || a.includes("host_domain")) return "domain";
  return "settings";
}

/* -------------------- Day grouping -------------------- */

type DayGroup = { label: string; events: NormalEvent[]; iso: string };

function groupByDay(events: NormalEvent[]): DayGroup[] {
  const out: DayGroup[] = [];
  for (const e of events) {
    const d = new Date(e.createTime);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const label = humanDayLabel(d);
    const last = out[out.length - 1];
    if (last && last.iso === iso) {
      last.events.push(e);
    } else {
      out.push({ label, events: [e], iso });
    }
  }
  return out;
}

function humanDayLabel(d: Date): string {
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

function DaySection({ day }: { day: DayGroup }) {
  const { t } = useT();
  return (
    <section data-testid={`audit-day-${day.iso}`}>
      <div className="sticky top-0 z-10 border-b border-neutral-900 bg-neutral-950/80 px-5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-neutral-500 backdrop-blur">
        {t(day.label)}
      </div>
      <ul>
        {day.events.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
      </ul>
    </section>
  );
}

/* -------------------- Event row -------------------- */

const VERB_TONE: Record<VerbBucket, { border: string; text: string; icon: string }> = {
  create: { border: "border-l-emerald-500", text: "text-emerald-300", icon: "+" },
  delete: { border: "border-l-rose-500", text: "text-rose-300", icon: "−" },
  update: { border: "border-l-violet-500", text: "text-violet-300", icon: "✎" },
  auth: { border: "border-l-cyan-500", text: "text-cyan-300", icon: "👤" },
  domain: { border: "border-l-amber-500", text: "text-amber-300", icon: "🌐" },
  settings: { border: "border-l-neutral-600", text: "text-neutral-300", icon: "⚙" },
};

function EventRow({ event }: { event: NormalEvent }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const bucket = verbBucketOf(event.action);
  const tone = VERB_TONE[bucket];
  const hasMeta = event.metadata && Object.keys(event.metadata).length > 0;

  return (
    <li
      className={clsx(
        "border-b border-neutral-900 px-5 py-2.5 text-sm transition-colors hover:bg-neutral-900/40",
        "border-l-[3px]",
        tone.border,
      )}
      data-testid={`audit-row-${event.id}`}
      data-action={event.action}
    >
      <button
        type="button"
        onClick={() => hasMeta && setOpen((v) => !v)}
        className={clsx("flex w-full items-start gap-3 text-left", !hasMeta && "cursor-default")}
        aria-expanded={hasMeta ? open : undefined}
      >
        <span
          aria-hidden
          className={clsx(
            "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold",
            tone.text,
            "bg-neutral-900",
          )}
        >
          {tone.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-[12.5px] text-neutral-100">{event.action}</span>
            {event.targetType && (
              <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                {event.targetType}
              </Badge>
            )}
            {(event.targetName || event.targetId) && (
              <code className="font-mono text-[11px] text-cyan-300">
                {event.targetName || event.targetId?.slice(0, 8) + "…"}
              </code>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[10.5px] text-neutral-500">
            {event.actorName || event.actorEmail || t("system")} ·{" "}
            <span title={event.createTime}>{formatTime(event.createTime)}</span>
            {hasMeta && (
              <span className="ml-2 text-neutral-600">
                {open ? t("▼ hide details") : t("▶ show details")}
              </span>
            )}
          </p>
        </div>
      </button>
      {open && hasMeta && (
        <pre className="mt-2 ml-7 max-h-64 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-[10.5px] text-neutral-300">
          {JSON.stringify(event.metadata, null, 2)}
        </pre>
      )}
    </li>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/* -------------------- Export -------------------- */

function ExportButton({ events, sourceKind }: { events: NormalEvent[]; sourceKind: "team" | "project" }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const filename = `synapse-${sourceKind}-audit-${new Date().toISOString().slice(0, 10)}`;
  return (
    <div className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        disabled={events.length === 0}
        data-testid="audit-export-open"
      >
        {t("Export…")}
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-neutral-800 bg-neutral-950 shadow-xl">
          <button
            type="button"
            onClick={() => {
              triggerDownload(`${filename}.csv`, toCSV(events), "text/csv");
              setOpen(false);
            }}
            className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-900"
            data-testid="audit-export-csv"
          >
            {t("Download CSV")}
          </button>
          <button
            type="button"
            onClick={() => {
              triggerDownload(`${filename}.json`, JSON.stringify(events, null, 2), "application/json");
              setOpen(false);
            }}
            className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-900"
            data-testid="audit-export-json"
          >
            {t("Download JSON")}
          </button>
        </div>
      )}
    </div>
  );
}

function toCSV(events: NormalEvent[]): string {
  const header = [
    "id",
    "createTime",
    "action",
    "actorEmail",
    "actorName",
    "targetType",
    "targetId",
    "targetName",
    "metadata",
  ];
  const escape = (v: unknown): string => {
    if (v == null) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = events.map((e) =>
    [
      e.id,
      e.createTime,
      e.action,
      e.actorEmail ?? "",
      e.actorName ?? "",
      e.targetType ?? "",
      e.targetId ?? "",
      e.targetName ?? "",
      e.metadata ? JSON.stringify(e.metadata) : "",
    ]
      .map(escape)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

function triggerDownload(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Pure-helper exports for unit tests.
export const __auditTesting__ = { verbBucketOf, groupByDay, toCSV, humanDayLabel };
