"use client";

import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { IconTerminal } from "@/components/ui/icon";
import { JsonDetails } from "@/components/JsonDetails";
import { useT } from "@/lib/i18n";
import {
  ApiError,
  api,
  type OperationRun,
  type OperationRunDetail,
} from "@/lib/api";

type Props = { projectId: string };

// OperationRunsPanel (Bloco 9c) — audit-grade history of the control plane's
// operations (sync_desired_from_placements / compute_drift / reconcile_dry_run).
// Read-only. Details show the (redacted) input/plan/result + planned steps; the
// dashboard never surfaces tokens, secrets, or an Apply control.
export function OperationRunsPanel({ projectId }: Props) {
  const { t } = useT();
  const { data, error, isLoading } = useSWR<OperationRun[]>(
    ["/operation-runs", projectId],
    () => api.operationRuns.project(projectId),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const [selected, setSelected] = useState<string | null>(null);

  // Hide entirely for non-members (the GET 403s) — the project page already
  // gates access, this is belt-and-suspenders like the other CCP panels.
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return null;
  }

  const runs = data ?? [];

  return (
    <Card className="overflow-hidden" data-testid="operation-runs-panel">
      <div className="flex items-center justify-between border-b border-neutral-800/80 px-5 py-3.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
          <IconTerminal className="opacity-70" />
          {t("Operations")}
          <span className="text-xs font-normal text-neutral-500">{t("— sync · drift · dry-run")}</span>
        </h3>
        <Badge tone="violet">{t("read-only")}</Badge>
      </div>

      <div className="space-y-2 p-5">
        {isLoading && !data && <p className="text-xs text-neutral-500">{t("Loading…")}</p>}
        {!isLoading && runs.length === 0 && (
          <p className="text-xs text-neutral-500" data-testid="operation-runs-empty">
            {t("No operations yet. Sync desired state or recompute drift to create one.")}
          </p>
        )}
        {runs.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-800/80 bg-neutral-900/30 px-3 py-2"
            data-testid="operation-run"
            data-op-type={r.type}
          >
            <Badge tone="neutral">{r.type}</Badge>
            <Badge tone={runStatusTone(r.status)}>{r.status}</Badge>
            <span className="text-[11px] text-neutral-500">{scopeLabel(r)}</span>
            <span className="text-[10px] text-neutral-600">{duration(r)}</span>
            {r.error && <span className="text-[11px] text-red-400">{r.error}</span>}
            <div className="ml-auto">
              <Button variant="ghost" size="sm" onClick={() => setSelected(r.id)}>
                {t("View details")}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <OperationRunDetailDialog
        runId={selected}
        onClose={() => setSelected(null)}
      />
    </Card>
  );
}

function OperationRunDetailDialog({
  runId,
  onClose,
}: {
  runId: string | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const { data, error, isLoading } = useSWR<OperationRunDetail>(
    runId ? ["/operation-run", runId] : null,
    () => api.operationRuns.get(runId as string),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const run = data?.operationRun;
  const steps = data?.steps ?? [];

  return (
    <Dialog open={runId !== null} onClose={onClose} title={t("Operation run")}>
      <div className="space-y-3" data-testid="operation-run-detail">
        {isLoading && <p className="text-xs text-neutral-500">{t("Loading…")}</p>}
        {error && (
          <p className="text-xs text-red-400">
            {error instanceof ApiError ? error.message : t("Could not load operation run.")}
          </p>
        )}
        {run && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{run.type}</Badge>
              <Badge tone={runStatusTone(run.status)}>{run.status}</Badge>
              <span className="text-[11px] text-neutral-500">{scopeLabel(run)}</span>
              <span className="text-[10px] text-neutral-600">{duration(run)}</span>
            </div>
            {run.error && (
              <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {run.error}
              </p>
            )}

            {steps.length > 0 && (
              <div className="space-y-1" data-testid="operation-run-steps">
                <p className="text-xs font-semibold text-neutral-300">{t("Steps ({count})", { count: steps.length })}</p>
                {steps.map((st) => (
                  <div
                    key={st.id}
                    className="flex flex-wrap items-center gap-2 rounded border border-neutral-800/80 px-2.5 py-1.5 text-[11px]"
                  >
                    <span className="text-neutral-600">#{st.stepIndex}</span>
                    <Badge tone="neutral">{st.action}</Badge>
                    <Badge tone="neutral">{st.status}</Badge>
                    <span className="font-mono text-neutral-300">{st.resourceKey}</span>
                    {st.reason && <span className="text-neutral-500">— {st.reason}</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1">
              <JsonDetails label="input" value={run.input} testId="op-input" />
              <JsonDetails label="plan" value={run.plan} testId="op-plan" />
              <JsonDetails label="result" value={run.result} testId="op-result" />
            </div>

            <p className="text-[11px] text-neutral-500">
              {t("Operations are diagnosis + planning only. The agent is observe-only; no host change was applied.")}
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

function scopeLabel(r: OperationRun): string {
  if (r.hostId) return `host ${r.hostId.slice(0, 8)}`;
  if (r.cellId) return `cell ${r.cellId.slice(0, 8)}`;
  if (r.deploymentId) return `deployment ${r.deploymentId.slice(0, 8)}`;
  if (r.projectId) return "project";
  return "—";
}

function duration(r: OperationRun): string {
  if (r.startedAt && r.finishedAt) {
    const ms = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
    if (ms >= 0 && ms < 60_000) return `${ms} ms`;
    if (ms >= 60_000) return `${Math.round(ms / 1000)} s`;
  }
  return r.createdAt ? new Date(r.createdAt).toLocaleString() : "";
}

function runStatusTone(status: string): "green" | "yellow" | "red" | "neutral" {
  switch (status) {
    case "succeeded":
      return "green";
    case "running":
    case "queued":
      return "yellow";
    case "failed":
      return "red";
    default:
      return "neutral";
  }
}
