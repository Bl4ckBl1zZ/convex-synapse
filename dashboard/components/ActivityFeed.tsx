"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import clsx from "clsx";
import { Card } from "@/components/ui/card";
import { ApiError, api, type ActivityEvent, type ActivityResponse } from "@/lib/api";

type Props = { projectId: string };

// ActivityFeed — project-scoped audit feed in timeline format.
//
// v1.10.0: distinct from the team audit-log table at
// /teams/<ref>/audit. This view is:
//   - Project-scoped (only events touching THIS project)
//   - Visible to members + viewers (not admin-only)
//   - Time-relative ("2h ago" instead of full ISO timestamps)
//   - Smart-grouped (bursts of similar events collapse to one entry
//     with an expand affordance)
//
// Mounted on the project home below the Topology panel. The component
// hides itself entirely when no events exist — newly-created projects
// shouldn't render an empty timeline next to a "no deployments yet"
// state.
export function ActivityFeed({ projectId }: Props) {
  const { data, error, isLoading } = useSWR<ActivityResponse>(
    ["/activity", projectId],
    () => api.projects.activity(projectId, { limit: 30 }),
    {
      // Polling 20s — activity changes are user-triggered (create/delete
      // deployment, change settings, ...) and we want the feed to reflect
      // the operator's own action within a moment. The project page also
      // invalidates this cache via globalMutate on those actions (see
      // page.tsx createDeployment/adopt/delete handlers).
      refreshInterval: 20_000,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  // CRITICAL: every hook MUST be called on every render (rules of
  // hooks). v1.10.0 shipped with the useMemo below the early-return
  // branches → React error #310 the moment data finally arrived.
  // Always call hooks unconditionally; gate rendering AFTER.
  const groups = useMemo(
    () => (data ? groupActivity(data.events) : []),
    [data],
  );

  if (isLoading && !data) return null;
  // Permissions failure (e.g. project moved): hide rather than show
  // an alarming error in the timeline area. Project page's top-level
  // gate handles the actual user-facing message.
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return null;
  }
  if (!data || data.events.length === 0) return null;

  return (
    <Card className="overflow-hidden" data-testid="activity-feed">
      <div className="flex items-center justify-between border-b border-neutral-800/80 px-5 py-3.5">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-neutral-100">Activity</h3>
          <span className="text-xs text-neutral-500">
            — recent events touching this project
          </span>
        </div>
        <span className="font-mono text-[11px] text-neutral-500">
          {data.events.length} {data.events.length === 1 ? "event" : "events"}
        </span>
      </div>
      <div className="px-5 py-4">
        <ol className="relative space-y-1">
          {/* The timeline rail — a soft vertical line behind the dots. */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-[7px] top-1 bottom-1 w-px bg-gradient-to-b from-neutral-800/0 via-neutral-800 to-neutral-800/0"
          />
          {groups.map((g) =>
            g.kind === "single" ? (
              <SingleRow key={g.event.id} event={g.event} />
            ) : (
              <GroupedRow key={g.events[0].id} events={g.events} />
            ),
          )}
        </ol>
      </div>
    </Card>
  );
}

/* -------------------- Smart grouping -------------------- */

type SingleGroup = { kind: "single"; event: ActivityEvent };
type CollapsedGroup = { kind: "group"; events: ActivityEvent[] };
type Group = SingleGroup | CollapsedGroup;

// groupActivity collapses bursts of similar events into one expandable
// entry. The heuristic:
//
//   - Same actor
//   - Same action verb
//   - Same target type
//   - Within 5 minutes of the previous event in the group
//
// This catches "Ian created 3 deployments in 30s" without merging
// unrelated activity. Single events that don't burst pass through as
// SingleGroup. v1.10.0 — heuristic can evolve without breaking the
// rendering layer.
function groupActivity(events: ActivityEvent[]): Group[] {
  if (events.length === 0) return [];
  const BURST_WINDOW_MS = 5 * 60 * 1000;
  const out: Group[] = [];
  let buffer: ActivityEvent[] = [events[0]];
  for (let i = 1; i < events.length; i++) {
    const prev = buffer[buffer.length - 1];
    const next = events[i];
    const sameBurst =
      prev.actorId === next.actorId &&
      prev.action === next.action &&
      prev.targetType === next.targetType &&
      Math.abs(toMillis(prev.createTime) - toMillis(next.createTime)) <= BURST_WINDOW_MS;
    if (sameBurst) {
      buffer.push(next);
    } else {
      out.push(buffer.length === 1 ? { kind: "single", event: buffer[0] } : { kind: "group", events: [...buffer] });
      buffer = [next];
    }
  }
  out.push(buffer.length === 1 ? { kind: "single", event: buffer[0] } : { kind: "group", events: [...buffer] });
  return out;
}

function toMillis(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/* -------------------- Row renderers -------------------- */

function SingleRow({ event }: { event: ActivityEvent }) {
  const visual = visualFor(event.action);
  return (
    <li
      className="relative flex gap-3 pl-6"
      data-testid={`activity-event-${event.id}`}
      data-action={event.action}
    >
      <DotMarker tone={visual.tone} icon={visual.icon} />
      <div className="min-w-0 flex-1 pb-3">
        <p className="text-[13px] text-neutral-200">
          <ActorLabel event={event} />{" "}
          <span className="text-neutral-300">{visual.verb}</span>{" "}
          <TargetLabel event={event} />
        </p>
        <p className="mt-0.5 font-mono text-[10.5px] text-neutral-500">
          <RelativeTime iso={event.createTime} />
          {summariseMetadata(event) && (
            <>
              {" · "}
              <span className="text-neutral-400">{summariseMetadata(event)}</span>
            </>
          )}
        </p>
      </div>
    </li>
  );
}

function GroupedRow({ events }: { events: ActivityEvent[] }) {
  const [open, setOpen] = useState(false);
  const first = events[0];
  const visual = visualFor(first.action);
  const targets = events
    .map((e) => e.targetName || e.targetId)
    .filter(Boolean) as string[];
  const previewTargets = targets.slice(0, 3).join(", ");
  const extra = targets.length > 3 ? `, +${targets.length - 3}` : "";

  return (
    <li className="relative flex gap-3 pl-6" data-testid={`activity-group-${first.id}`}>
      <DotMarker tone={visual.tone} icon={visual.icon} grouped />
      <div className="min-w-0 flex-1 pb-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-left text-[13px] text-neutral-200 hover:text-white"
          aria-expanded={open}
        >
          <ActorLabel event={first} />{" "}
          <span className="text-neutral-300">{visual.verb}</span>{" "}
          <span className="font-mono text-neutral-100">
            {events.length} {first.targetType || "items"}
          </span>{" "}
          <span className="text-neutral-500">— {previewTargets}{extra}</span>
        </button>
        <p className="mt-0.5 font-mono text-[10.5px] text-neutral-500">
          <RelativeTime iso={first.createTime} /> ·{" "}
          <span className="cursor-pointer hover:text-neutral-300" onClick={() => setOpen((v) => !v)}>
            {open ? "hide" : "show all"}
          </span>
        </p>
        {open && (
          <ol className="mt-2 space-y-1 border-l border-neutral-800 pl-3">
            {events.map((e) => (
              <li key={e.id} className="font-mono text-[11px] text-neutral-400">
                <span className="text-cyan-300">{e.targetName || e.targetId}</span>
                <span className="ml-2 text-neutral-600">
                  <RelativeTime iso={e.createTime} />
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

function DotMarker({
  tone,
  icon,
  grouped = false,
}: {
  tone: "violet" | "cyan" | "amber" | "green" | "rose" | "neutral";
  icon: string;
  grouped?: boolean;
}) {
  const toneMap: Record<typeof tone, string> = {
    violet: "border-violet-500/70 bg-violet-500/20 text-violet-200",
    cyan: "border-cyan-500/70 bg-cyan-500/20 text-cyan-200",
    amber: "border-amber-500/70 bg-amber-500/20 text-amber-200",
    green: "border-emerald-500/70 bg-emerald-500/20 text-emerald-200",
    rose: "border-rose-500/70 bg-rose-500/20 text-rose-200",
    neutral: "border-neutral-700 bg-neutral-800 text-neutral-300",
  } as const;
  return (
    <span
      aria-hidden
      className={clsx(
        "absolute left-0 top-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-full border text-[9px] font-bold",
        toneMap[tone],
        grouped && "ring-2 ring-neutral-950",
      )}
    >
      {icon}
    </span>
  );
}

function ActorLabel({ event }: { event: ActivityEvent }) {
  const name = event.actorName || event.actorEmail || "Someone";
  return <span className="font-medium text-white">{name}</span>;
}

function TargetLabel({ event }: { event: ActivityEvent }) {
  const name = event.targetName || event.targetId;
  if (!name) return null;
  return (
    <code className="rounded bg-neutral-900/70 px-1.5 py-0.5 font-mono text-[11.5px] text-cyan-300">
      {name}
    </code>
  );
}

// summariseMetadata picks a few key fields off the metadata bag to show
// inline, so the operator gets context without expanding. Keep it short
// — the audit-log table view is for full forensics.
function summariseMetadata(event: ActivityEvent): string {
  const m = event.metadata;
  if (!m) return "";
  const parts: string[] = [];
  if (typeof m.type === "string") parts.push(m.type);
  if (typeof m.role === "string") parts.push(`role: ${m.role}`);
  if (Array.isArray(m.names) && m.names.length > 0) {
    parts.push(`${m.names.length} vars`);
  }
  if (typeof m.applied === "number") parts.push(`${m.applied} change${m.applied === 1 ? "" : "s"}`);
  if (typeof m.recreated === "number") parts.push(`${m.recreated} recreated`);
  if (typeof m.ha === "boolean" && m.ha) parts.push("HA");
  return parts.join(" · ");
}

/* -------------------- Action visual catalog -------------------- */

type Visual = {
  verb: string;
  tone: "violet" | "cyan" | "amber" | "green" | "rose" | "neutral";
  icon: string;
};

// visualFor maps an audit action string to {verb, tone, icon}. Keeps
// the timeline narrative natural ("Ian *created*" instead of "Ian
// createDeployment") and color-codes by destructive/constructive/
// neutral intent.
function visualFor(action: string): Visual {
  // Most actions follow a "<verb><Noun>" pattern. We pattern-match on
  // both the prefix (create/delete/update/rotate/revoke) and a few
  // bespoke names. New audit constants slot into the prefix branches
  // automatically; unknown actions fall through to a neutral default.
  const a = action.toLowerCase();

  if (a.startsWith("create")) return { verb: "created", tone: "green", icon: "+" };
  if (a.startsWith("delete")) return { verb: "deleted", tone: "rose", icon: "−" };
  if (a.startsWith("add")) return { verb: "added", tone: "green", icon: "+" };
  if (a.startsWith("remove")) return { verb: "removed", tone: "rose", icon: "−" };
  if (a.startsWith("revoke")) return { verb: "revoked", tone: "rose", icon: "×" };
  if (a.startsWith("rename")) return { verb: "renamed", tone: "violet", icon: "✎" };
  if (a.startsWith("update")) return { verb: "updated", tone: "violet", icon: "✎" };
  if (a.startsWith("transfer")) return { verb: "transferred", tone: "violet", icon: "→" };
  if (a.startsWith("adopt")) return { verb: "adopted", tone: "cyan", icon: "↓" };
  if (a.startsWith("upgrade")) return { verb: "upgraded", tone: "amber", icon: "↑" };
  if (a.startsWith("verify")) return { verb: "verified", tone: "green", icon: "✓" };
  if (a.startsWith("invite")) return { verb: "invited", tone: "cyan", icon: "✉" };
  if (a.startsWith("accept")) return { verb: "joined via", tone: "green", icon: "✓" };
  if (a.startsWith("cancel")) return { verb: "cancelled", tone: "neutral", icon: "×" };
  if (a.startsWith("reissue")) return { verb: "rotated", tone: "amber", icon: "↻" };
  if (a.startsWith("sync")) return { verb: "synced", tone: "amber", icon: "↻" };
  if (a === "domain.added") return { verb: "added domain", tone: "green", icon: "+" };
  if (a === "domain.removed") return { verb: "removed domain", tone: "rose", icon: "−" };
  if (a === "domain.verified") return { verb: "verified domain", tone: "green", icon: "✓" };
  if (a === "domain.auto_configured") return { verb: "auto-configured DNS for", tone: "cyan", icon: "★" };
  if (a === "host_domain.change_initiated") return { verb: "started host-domain change", tone: "amber", icon: "↻" };
  return { verb: action, tone: "neutral", icon: "•" };
}

/* -------------------- Relative time -------------------- */

function RelativeTime({ iso }: { iso: string }) {
  // Tick the component so "2h ago" stays fresh without a full SWR
  // refetch. 60s is plenty — we never need sub-minute precision in
  // this view (the underlying timestamp is exposed via title).
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const text = formatRelative(iso);
  return (
    <time title={iso} dateTime={iso}>
      {text}
    </time>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const months = Math.floor(d / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// Re-exports for unit tests of pure helpers (groupActivity + formatRelative).
export const __testing__ = { groupActivity, formatRelative, visualFor };
