"use client";

import { useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconLayers } from "@/components/ui/icon";
import { JsonDetails } from "@/components/JsonDetails";
import {
  ApiError,
  api,
  type DesiredState,
  type DriftItem,
  type DriftResponse,
  type DriftSummary,
  type DryRunResponse,
} from "@/lib/api";

type Props = { projectId: string };

// StateDriftPanel (Bloco 9c) — the operator's read + diagnose surface for the
// Cell Control Plane. It shows DESIRED state vs the latest DRIFT report and can
// build a reconcile DRY-RUN plan. It is diagnosis + planning ONLY:
//   • the agent is observe-only,
//   • no host change is ever applied,
//   • the dry-run plan is a recommendation (applyAllowed=false),
//   • there is intentionally no Apply button.
export function StateDriftPanel({ projectId }: Props) {
  const { data: desired, mutate: mutateDesired } = useSWR<DesiredState[]>(
    ["/desired", projectId],
    () => api.desired.project(projectId),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const {
    data: drift,
    error: driftError,
    isLoading: driftLoading,
    mutate: mutateDrift,
  } = useSWR<DriftResponse>(
    ["/drift-latest", projectId],
    () => api.drift.project.latest(projectId),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const [busy, setBusy] = useState<null | "sync" | "recompute" | "dryrun">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);

  const refreshRuns = () => globalMutate(["/operation-runs", projectId]);

  async function run(
    kind: "sync" | "recompute" | "dryrun",
    fn: () => Promise<void>,
  ) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : "Action failed — please try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  const onSync = () =>
    run("sync", async () => {
      const res = await api.desired.projectSyncFromPlacements(projectId);
      await Promise.all([mutateDesired(), mutateDrift(), refreshRuns()]);
      setNotice(
        `Desired state synced from placements (${res.created} created, ${res.updated} updated, ${res.superseded} superseded). Nothing was applied to hosts.`,
      );
    });

  const onRecompute = () =>
    run("recompute", async () => {
      const res = await api.drift.project.recompute(projectId);
      await mutateDrift(res, { revalidate: false });
      await refreshRuns();
      setNotice("Drift recomputed. This is a diagnosis only — no host was changed.");
    });

  const onDryRun = () =>
    run("dryrun", async () => {
      const res = await api.reconcile.projectDryRun(projectId);
      setDryRun(res);
      await refreshRuns();
      setNotice("Dry-run plan built. Nothing was sent to the agent.");
    });

  const report = drift?.report ?? null;
  const items = drift?.items ?? [];
  const desiredCount = desired?.length ?? 0;

  return (
    <Card className="overflow-hidden" data-testid="state-drift-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800/80 px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
            <IconLayers className="opacity-70" />
            State &amp; Drift
          </h3>
          <Badge tone="neutral" data-testid="drift-desired-count">
            {desiredCount} desired
          </Badge>
          <Badge tone={reportStatusTone(report?.status)} data-testid="drift-status">
            {report ? report.status : "no report"}
          </Badge>
          <Badge tone="violet">dry-run only</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={onSync} disabled={busy !== null}>
            {busy === "sync" ? "Syncing…" : "Sync desired from placements"}
          </Button>
          <Button size="sm" onClick={onRecompute} disabled={busy !== null}>
            {busy === "recompute" ? "Recomputing…" : "Recompute drift"}
          </Button>
          <Button variant="outline" size="sm" onClick={onDryRun} disabled={busy !== null}>
            {busy === "dryrun" ? "Planning…" : "Dry-run reconcile"}
          </Button>
        </div>
      </div>

      <div className="space-y-4 p-5">
        <p className="text-[11px] text-neutral-500">
          The agent is observe-only. No changes will be applied to hosts; plans are recommendations.
        </p>

        {notice && (
          <p
            className="rounded border border-green-900/50 bg-green-900/15 px-3 py-2 text-xs text-green-300"
            data-testid="drift-notice"
          >
            {notice}
          </p>
        )}
        {error && (
          <p
            className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
            data-testid="drift-error"
          >
            {error}
          </p>
        )}

        {driftLoading && !drift && (
          <p className="text-xs text-neutral-500">Loading drift…</p>
        )}
        {driftError instanceof ApiError &&
          driftError.status !== 401 &&
          driftError.status !== 403 && (
            <p className="text-xs text-red-400">
              Failed to load drift: {driftError.message}
            </p>
          )}

        {/* Empty states. */}
        {!driftLoading && desiredCount === 0 && (
          <p className="text-xs text-neutral-500" data-testid="drift-empty-desired">
            No desired state yet. Click <span className="text-neutral-300">Sync desired from placements</span>.
          </p>
        )}
        {!driftLoading && !report && (
          <p className="text-xs text-neutral-500" data-testid="drift-empty-report">
            No drift report yet. Click <span className="text-neutral-300">Recompute drift</span>.
          </p>
        )}

        {report?.summary && <DriftSummaryView summary={report.summary} />}

        {items.length > 0 && (
          <div className="space-y-2" data-testid="drift-items">
            <p className="text-xs font-semibold text-neutral-300">Drift items ({items.length})</p>
            {items.map((it) => (
              <DriftItemRow key={it.id} item={it} />
            ))}
          </div>
        )}

        {dryRun && <DryRunPlanView dryRun={dryRun} onDismiss={() => setDryRun(null)} />}
      </div>
    </Card>
  );
}

// ---- Drift summary ----

function DriftSummaryView({ summary }: { summary: DriftSummary }) {
  const n = (k: keyof DriftSummary) => summary[k] ?? 0;
  const cells: { label: string; value: number; tone: BadgeTone }[] = [
    { label: "In sync", value: n("inSync"), tone: "green" },
    { label: "Missing", value: n("missing"), tone: "red" },
    { label: "Drifted", value: n("drifted"), tone: "red" },
    { label: "Unmanaged", value: n("unmanaged"), tone: "yellow" },
    { label: "Orphaned", value: n("orphaned"), tone: "yellow" },
    { label: "Host unreachable", value: n("hostUnreachable"), tone: "yellow" },
    { label: "Ignored", value: n("ignored"), tone: "neutral" },
  ];
  return (
    <div className="space-y-2" data-testid="drift-summary">
      <p className="text-xs font-semibold text-neutral-300">Drift summary</p>
      <div className="flex flex-wrap gap-2">
        {cells.map((c) => (
          <span
            key={c.label}
            className="inline-flex items-center gap-1.5 rounded border border-neutral-800/80 bg-neutral-900/40 px-2.5 py-1 text-[11px] text-neutral-300"
          >
            <span className="text-neutral-500">{c.label}</span>
            <Badge tone={c.value > 0 ? c.tone : "neutral"}>{c.value}</Badge>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="text-neutral-500">Severity:</span>
        <Badge tone={n("critical") > 0 ? "red" : "neutral"}>critical {n("critical")}</Badge>
        <Badge tone={n("warning") > 0 ? "yellow" : "neutral"}>warning {n("warning")}</Badge>
        <Badge tone="neutral">info {n("info")}</Badge>
      </div>
    </div>
  );
}

// ---- Drift item ----

function DriftItemRow({ item }: { item: DriftItem }) {
  const note = itemNote(item);
  const dangerous = item.recommendedAction === "remove";
  return (
    <div
      className="rounded-md border border-neutral-800/80 bg-neutral-900/30 px-3 py-2"
      data-testid="drift-item"
      data-drift-status={item.driftStatus}
      data-recommended-action={item.recommendedAction}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={driftStatusTone(item.driftStatus)}>{item.driftStatus}</Badge>
        <Badge tone={severityTone(item.severity)}>{item.severity}</Badge>
        <span className="text-[11px] text-neutral-500">{item.resourceType}</span>
        <span className="font-mono text-xs text-neutral-200">{item.resourceKey}</span>
        <Badge tone={actionTone(item.recommendedAction)}>{item.recommendedAction}</Badge>
        {dangerous && <Badge tone="red">dangerous</Badge>}
        {item.hostId && (
          <span className="text-[10px] text-neutral-600">host {item.hostId.slice(0, 8)}</span>
        )}
        {item.cellId && (
          <span className="text-[10px] text-neutral-600">cell {item.cellId.slice(0, 8)}</span>
        )}
      </div>
      {note && <p className="mt-1 text-[11px] text-neutral-400">{note}</p>}
      <div className="mt-1">
        <JsonDetails label="diff" value={item.diff} testId="drift-item-diff" />
      </div>
    </div>
  );
}

// itemNote returns the plain-language explanation for an item, framed as
// diagnosis/recommendation — never as an action that happened.
function itemNote(item: DriftItem): string | null {
  if (item.driftStatus === "host_unreachable") {
    return "Observation cannot be trusted. Investigate host / agent / docker scan.";
  }
  if (item.recommendedAction === "remove") {
    return "Dry-run only. Removal is not implemented.";
  }
  const diff = item.diff ?? {};
  const reason = typeof diff.reason === "string" ? (diff.reason as string) : "";
  if (reason.toLowerCase().includes("scan")) {
    return "Container scan failed or incomplete.";
  }
  if (diff.lifecycle === "draining") {
    return "Host is draining; drift is still diagnosed because liveness is online.";
  }
  if (item.driftStatus === "missing") {
    return "Desired resource has no matching container. Recommended action: plan create.";
  }
  if (item.driftStatus === "drifted" && item.recommendedAction === "restart") {
    return "Observed container is not running. Recommended action: plan restart.";
  }
  if (item.driftStatus === "drifted" && item.recommendedAction === "stop") {
    return "Observed container is running but desired stopped. Recommended action: plan stop.";
  }
  if (item.driftStatus === "unmanaged") {
    return "Synapse-managed container with no active desired state. Recommended action: investigate.";
  }
  return reason || null;
}

// ---- Dry-run plan ----

function DryRunPlanView({
  dryRun,
  onDismiss,
}: {
  dryRun: DryRunResponse;
  onDismiss: () => void;
}) {
  const plan = (dryRun.operationRun.plan ?? {}) as {
    mode?: string;
    applyAllowed?: boolean;
    summary?: { planned?: number; noOp?: number; skipped?: number; investigate?: number; dangerous?: number };
  };
  const s = plan.summary ?? {};
  const hasAction = dryRun.steps.some((st) =>
    ["create", "restart", "stop", "remove"].includes(st.action),
  );
  return (
    <div
      className="space-y-2 rounded-md border border-violet-900/50 bg-violet-900/10 px-3 py-3"
      data-testid="dry-run-plan"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold text-violet-200">Dry-run plan</p>
          <Badge tone="violet">mode: {plan.mode ?? "dry-run"}</Badge>
          <Badge tone="green" data-testid="dry-run-apply-allowed">
            applyAllowed: {String(plan.applyAllowed ?? false)}
          </Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 text-[11px]">
        <Badge tone="neutral">planned {s.planned ?? 0}</Badge>
        <Badge tone="neutral">no-op {s.noOp ?? 0}</Badge>
        <Badge tone="neutral">skipped {s.skipped ?? 0}</Badge>
        <Badge tone={(s.investigate ?? 0) > 0 ? "yellow" : "neutral"}>investigate {s.investigate ?? 0}</Badge>
        <Badge tone={(s.dangerous ?? 0) > 0 ? "red" : "neutral"}>dangerous {s.dangerous ?? 0}</Badge>
      </div>

      <p className="text-[11px] text-violet-200/80">
        This plan is a recommendation. Nothing was sent to the agent. Apply is intentionally not available.
      </p>

      {dryRun.steps.length === 0 ? (
        <p className="text-[11px] text-neutral-500">No steps — nothing to reconcile.</p>
      ) : (
        <div className="space-y-1">
          {dryRun.steps.map((st, i) => (
            <div
              key={i}
              className="flex flex-wrap items-center gap-2 rounded border border-neutral-800/80 px-2.5 py-1.5 text-[11px]"
              data-testid="dry-run-step"
              data-action={st.action}
            >
              <span className="text-neutral-600">#{i}</span>
              <Badge tone={actionTone(st.action)}>{st.action}</Badge>
              <Badge tone="neutral">{st.status}</Badge>
              {st.action === "remove" && <Badge tone="red">dangerous</Badge>}
              <span className="text-neutral-500">{st.resourceType}</span>
              <span className="font-mono text-neutral-300">{st.resourceKey}</span>
              <Badge tone="neutral">willApply: {String(st.willApply)}</Badge>
              {st.reason && <span className="text-neutral-500">— {st.reason}</span>}
            </div>
          ))}
        </div>
      )}

      {hasAction && (
        <p className="text-[11px] text-neutral-500">
          These are planned actions only. Nothing was sent to the agent.
        </p>
      )}
    </div>
  );
}

// ---- tones ----

type BadgeTone = "green" | "yellow" | "red" | "neutral" | "violet" | "cyan" | "amber";

function reportStatusTone(status?: string): BadgeTone {
  switch (status) {
    case "clean":
      return "green";
    case "warning":
      return "yellow";
    case "drifted":
    case "failed":
      return "red";
    default:
      return "neutral";
  }
}

function driftStatusTone(status: string): BadgeTone {
  switch (status) {
    case "in_sync":
      return "green";
    case "missing":
    case "drifted":
      return "red";
    case "unmanaged":
    case "orphaned":
    case "host_unreachable":
      return "yellow";
    default:
      return "neutral";
  }
}

function severityTone(severity: string): BadgeTone {
  switch (severity) {
    case "critical":
      return "red";
    case "warning":
      return "yellow";
    default:
      return "neutral";
  }
}

function actionTone(action: string): BadgeTone {
  switch (action) {
    case "create":
    case "update":
      return "cyan";
    case "restart":
    case "stop":
      return "yellow";
    case "remove":
      return "red";
    case "investigate":
      return "violet";
    default:
      return "neutral";
  }
}
