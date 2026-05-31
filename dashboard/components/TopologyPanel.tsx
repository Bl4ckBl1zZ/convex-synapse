"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import clsx from "clsx";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { ApiError, api, type TopologyHost, type TopologyDeployment, type TopologyResponse } from "@/lib/api";
import { useT } from "@/lib/i18n";

type Props = { projectId: string };

// TopologyPanel — Regions-layout topology view (v1.9.6).
// One column per VPS host. Each column has a geographic header (flag,
// city, provider) + a stack of compact deployment tiles. The shape is
// forward-compatible with multi-VPS federation: today exactly one host
// is returned; tomorrow we get N and the grid just wraps.
//
// Data flow: SWR hits /v1/projects/{id}/topology. Auto-refreshes faster
// while any deployment is provisioning so the operator sees state
// transitions without manual reload.
export function TopologyPanel({ projectId }: Props) {
  const { t } = useT();
  const { data, error, isLoading } = useSWR<TopologyResponse>(
    ["/topology", projectId],
    () => api.projects.topology(projectId),
    {
      // Poll fast while anything is in flight (matches the deployments
      // list pattern); slow once everything stabilises so we don't
      // hammer the geo cache / DB.
      refreshInterval: (latest) =>
        latest?.hosts?.some((h) => (h.provisioningCount ?? 0) > 0) ? 3000 : 30000,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  if (isLoading && !data) return null;
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    // Same gate the project page uses — silently hide if not authorised.
    return null;
  }
  if (!data || data.hosts.length === 0) return null;

  const totalRunning = data.hosts.reduce((sum, h) => sum + (h.runningCount ?? 0), 0);
  const totalProvisioning = data.hosts.reduce((sum, h) => sum + (h.provisioningCount ?? 0), 0);
  const totalFailed = data.hosts.reduce((sum, h) => sum + (h.failedCount ?? 0), 0);
  const totalDeployments = data.hosts.reduce((sum, h) => sum + h.deployments.length, 0);

  // Empty state: there ARE hosts but no deployments yet.
  if (totalDeployments === 0) return null;

  return (
    <Card className="overflow-hidden" data-testid="topology-panel">
      <div className="flex items-center justify-between border-b border-neutral-800/80 px-5 py-3.5">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-neutral-100">{t("Topology")}</h3>
          <span className="text-xs text-neutral-500">
            {t("— deployments grouped by host")}
          </span>
        </div>
        <TopologyStatusSummary
          running={totalRunning}
          provisioning={totalProvisioning}
          failed={totalFailed}
        />
      </div>
      <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">
        {data.hosts.map((host, i) => (
          <HostColumn key={host.id} host={host} index={i} />
        ))}
        {/* Only the primary host so far: a subtle hint that federating
            another host (the Hosts panel below) lights up a new column
            here. Disappears the moment a second host joins. */}
        {data.hosts.length === 1 && data.hosts[0].isPrimary && (
          <FederateHostHint />
        )}
      </div>
    </Card>
  );
}

/* -------------------- Status summary -------------------- */

function TopologyStatusSummary({
  running,
  provisioning,
  failed,
}: {
  running: number;
  provisioning: number;
  failed: number;
}) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-3 font-mono text-[11px] text-neutral-500">
      <Stat tone="ok" count={running} label={t("running")} />
      {provisioning > 0 && <Stat tone="warn" count={provisioning} label={t("provisioning")} />}
      {failed > 0 && <Stat tone="fail" count={failed} label={t("failed")} />}
    </div>
  );
}

function Stat({
  tone,
  count,
  label,
}: {
  tone: "ok" | "warn" | "fail";
  count: number;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={clsx(
          "inline-block h-1.5 w-1.5 rounded-full",
          tone === "ok" && "bg-emerald-400 shadow-[0_0_0_3px_rgba(74,222,128,0.2)]",
          tone === "warn" && "bg-amber-400 shadow-[0_0_0_3px_rgba(245,158,11,0.2)]",
          tone === "fail" && "bg-rose-400 shadow-[0_0_0_3px_rgba(251,113,133,0.2)]",
        )}
      />
      <span>{count} {label}</span>
    </span>
  );
}

/* -------------------- Host column -------------------- */

const HOST_TONE = {
  primary: {
    border: "border-t-violet-500/70",
    headBg: "bg-[radial-gradient(ellipse_at_top_right,rgba(168,85,247,0.10),transparent_60%)]",
  },
  federated: {
    border: "border-t-cyan-500/70",
    headBg: "bg-[radial-gradient(ellipse_at_top_right,rgba(34,211,238,0.10),transparent_60%)]",
  },
  adopted: {
    border: "border-t-amber-500/70",
    headBg: "bg-[radial-gradient(ellipse_at_top_right,rgba(245,158,11,0.10),transparent_60%)]",
  },
} as const;

function HostColumn({ host, index }: { host: TopologyHost; index: number }) {
  const { t } = useT();
  // Visual tone alternates so multi-VPS federations don't all look
  // identical. Primary always = violet; subsequent hosts cycle.
  const tone = host.isPrimary
    ? "primary"
    : host.id === "adopted"
      ? "adopted"
      : index % 2 === 0
        ? "federated"
        : "adopted";
  const palette = HOST_TONE[tone];

  return (
    <div
      className={clsx(
        "flex flex-col overflow-hidden rounded-lg border border-neutral-800/80 bg-neutral-950/50",
        "border-t-[3px]",
        palette.border,
      )}
      data-testid={`topology-host-${host.id}`}
    >
      <div className={clsx("relative border-b border-neutral-800/80 p-4", palette.headBg)}>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-lg leading-none" aria-hidden>
            {host.countryFlag || "🌐"}
          </span>
          <span className="rounded bg-neutral-900/70 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
            {host.isPrimary
              ? `${t("primary")}${host.synapseVersion ? ` · v${host.synapseVersion}` : ""}`
              : host.id === "adopted"
                ? t("adopted (external)")
                : t("federated")}
          </span>
        </div>
        <p className="truncate font-mono text-[12.5px] font-semibold text-neutral-100" title={host.name}>
          {host.name}
        </p>
        <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-500">
          {[host.ip, host.provider, host.city || host.region]
            .filter(Boolean)
            .join(" · ") || (host.isPrimary ? t("host metadata unavailable") : "")}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-3 font-mono text-[10px] text-neutral-400">
          {host.runningCount > 0 && (
            <span className="text-emerald-400">● {t("{n} running", { n: host.runningCount })}</span>
          )}
          {host.provisioningCount > 0 && (
            <span className="text-amber-400">◐ {t("{n} provisioning", { n: host.provisioningCount })}</span>
          )}
          {host.failedCount > 0 && (
            <span className="text-rose-400">✗ {t("{n} failed", { n: host.failedCount })}</span>
          )}
          <span className="ml-auto text-neutral-500">
            {host.deployments.length === 1
              ? t("{n} deployment", { n: host.deployments.length })
              : t("{n} deployments", { n: host.deployments.length })}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-3">
        {host.deployments.length === 0 ? (
          <p className="px-2 py-4 text-center font-mono text-[11px] text-neutral-600">
            {t("no deployments here")}
          </p>
        ) : (
          host.deployments.map((d) => <DeploymentTile key={d.name} d={d} />)
        )}
      </div>
    </div>
  );
}

/* -------------------- Deployment tile -------------------- */

const TYPE_TONE = {
  dev: "border-l-cyan-500",
  prod: "border-l-amber-500",
  preview: "border-l-violet-500",
} as const;

const STATUS_PULSE = {
  running: "bg-emerald-400 shadow-[0_0_0_3px_rgba(74,222,128,0.18)]",
  provisioning: "bg-amber-400 shadow-[0_0_0_3px_rgba(251,146,60,0.18)]",
  failed: "bg-rose-400 shadow-[0_0_0_3px_rgba(251,113,133,0.18)]",
} as const;

function DeploymentTile({ d }: { d: TopologyDeployment }) {
  const { t } = useT();
  const typeTone = TYPE_TONE[d.type as keyof typeof TYPE_TONE] ?? "border-l-neutral-600";
  const failed = d.status === "failed";
  const replicas = d.haEnabled
    ? t("{healthy} / {total} healthy", { healthy: d.healthyCount, total: d.replicaCount })
    : d.status === "running"
      ? t("1 (single)")
      : t("0 (single)");

  return (
    <div
      className={clsx(
        "rounded-md border border-neutral-800/80 bg-neutral-900/30 p-2.5 transition-colors hover:border-neutral-700",
        "border-l-[3px]",
        failed ? "border-l-rose-500" : typeTone,
      )}
      data-testid={`topology-deployment-${d.name}`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center font-mono text-[12px] font-semibold text-neutral-100">
          <StatusDot status={d.status} />
          <span className="truncate">{d.name}</span>
        </span>
        <div className="flex shrink-0 flex-wrap gap-1">
          <TypeBadge type={d.type} />
          {d.haEnabled && (
            <Badge tone="red" className="px-1.5 py-0 text-[9px]">
              HA
            </Badge>
          )}
          {d.customDomain && (
            <Badge tone="red" className="px-1.5 py-0 text-[9px]">
              {t("custom")}
            </Badge>
          )}
          {d.adopted && (
            <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
              {t("adopted")}
            </Badge>
          )}
          {d.isDefault && !d.adopted && (
            <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
              {t("default")}
            </Badge>
          )}
          {failed && (
            <Badge tone="red" className="px-1.5 py-0 text-[9px]">
              {t("failed")}
            </Badge>
          )}
          {d.status === "provisioning" && (
            <Badge tone="yellow" className="px-1.5 py-0 text-[9px]">
              {t("prov")}
            </Badge>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[10px]">
        <Row k={t("storage")} v={d.storage} />
        {d.port != null && <Row k={t("port")} v={`:${d.port}`} dim />}
        <Row k={t("replicas")} v={replicas} highlight={failed ? "fail" : undefined} />
        {d.version && <Row k={t("version")} v={`v${d.version}`} dim />}
        <Row k={t("uptime")} v={<UptimeLabel runningSinceMs={d.runningSinceMs} status={d.status} />} />
      </dl>
      {(d.customDomain || d.url) && (
        <p className="mt-1.5 truncate font-mono text-[10px] text-cyan-300" title={d.customDomain ?? d.url}>
          {d.customDomain ?? d.url}
        </p>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const tone = STATUS_PULSE[status as keyof typeof STATUS_PULSE];
  if (!tone) return null;
  return (
    <span aria-hidden className={clsx("mr-1.5 inline-block h-1.5 w-1.5 rounded-full", tone)} />
  );
}

function TypeBadge({ type }: { type: string }) {
  switch (type) {
    case "dev":
      return <Badge tone="cyan" className="px-1.5 py-0 text-[9px]">dev</Badge>;
    case "prod":
      return <Badge tone="amber" className="px-1.5 py-0 text-[9px]">prod</Badge>;
    case "preview":
      return <Badge tone="violet" className="px-1.5 py-0 text-[9px]">preview</Badge>;
    default:
      return <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">{type}</Badge>;
  }
}

function Row({
  k,
  v,
  dim,
  highlight,
}: {
  k: string;
  v: React.ReactNode;
  dim?: boolean;
  highlight?: "fail";
}) {
  return (
    <>
      <dt className="text-neutral-500">{k}</dt>
      <dd
        className={clsx(
          "text-right",
          highlight === "fail" ? "text-rose-400" : dim ? "text-neutral-500" : "text-neutral-200",
        )}
      >
        {v}
      </dd>
    </>
  );
}

// Computes uptime label client-side from runningSinceMs so the value
// updates live without re-fetching. Status-aware: provisioning shows
// the spinner copy, failed shows "—".
function UptimeLabel({
  runningSinceMs,
  status,
}: {
  runningSinceMs?: number;
  status: string;
}) {
  const { t } = useT();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [status]);
  // Reference tick so React keeps the component subscribed; the
  // computation itself just reads Date.now().
  void tick;

  if (status === "provisioning") return <span className="text-amber-400">{t("building…")}</span>;
  if (status === "failed") return <span className="text-rose-400">—</span>;
  if (!runningSinceMs) return <span className="text-neutral-500">—</span>;
  const seconds = Math.max(0, Math.floor((Date.now() - runningSinceMs) / 1000));
  return <span className="text-emerald-400">{formatDuration(seconds)}</span>;
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/* -------------------- Federate-host hint -------------------- */

function FederateHostHint() {
  const { t } = useT();
  return (
    <div className="hidden flex-col items-center justify-center rounded-lg border border-dashed border-neutral-800 bg-neutral-950/40 p-6 opacity-60 xl:flex">
      <p className="text-center font-mono text-[10px] uppercase tracking-widest text-neutral-500">
        {t("Add another host")}
      </p>
      <p className="mt-2 max-w-[200px] text-center font-mono text-[10px] text-neutral-600">
        {t("Federate another host and its deployments show up here.")}
      </p>
    </div>
  );
}
