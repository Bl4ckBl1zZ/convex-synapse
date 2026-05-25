"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { IconServer, IconLayers } from "@/components/ui/icon";
import { ApiError, api, type CellTopologyResponse, type CellTopologyCell } from "@/lib/api";
import { cellKindTone } from "@/components/CellsPanel";

type Props = { projectId: string };

// CellTopologyPanel (Bloco 8) — the real Host → Cell → Deployment tree plus
// Cell Links + warnings. Hides itself (returns null) when the project has no
// cells (mode=legacy_synthetic); the legacy TopologyPanel renders that case.
export function CellTopologyPanel({ projectId }: Props) {
  const { data, error, isLoading } = useSWR<CellTopologyResponse>(
    ["/cell-topology", projectId],
    () => api.projects.cellTopology(projectId),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const cellName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data?.cells ?? []) m.set(c.id, c.name);
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [data?.cells]);

  if (isLoading && !data) return null;
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
  if (!data || data.mode !== "cell_control_plane") return null;

  const placedHostIds = new Set(data.hosts.map((h) => h.id));
  const cellsByHost = new Map<string, CellTopologyCell[]>();
  const unplaced: CellTopologyCell[] = [];
  for (const c of data.cells) {
    if (c.primaryHostId && placedHostIds.has(c.primaryHostId)) {
      const arr = cellsByHost.get(c.primaryHostId) ?? [];
      arr.push(c);
      cellsByHost.set(c.primaryHostId, arr);
    } else {
      unplaced.push(c);
    }
  }

  return (
    <Card className="overflow-hidden" data-testid="cell-topology-panel">
      <div className="flex items-center justify-between border-b border-neutral-800/80 px-5 py-3.5">
        <div className="flex items-baseline gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
            <IconLayers className="opacity-70" />
            Topology
          </h3>
          <span className="text-xs text-neutral-500">— host → cell → deployment</span>
        </div>
        <Badge tone="violet">cell control plane</Badge>
      </div>

      <div className="space-y-5 p-5">
        {data.warnings.length > 0 && (
          <div
            className="space-y-1 rounded-md border border-yellow-900/60 bg-yellow-900/15 px-3 py-2"
            data-testid="topology-warnings"
          >
            <p className="text-xs font-semibold text-yellow-300">
              Warnings ({data.warnings.length})
            </p>
            <ul className="space-y-0.5">
              {data.warnings.map((w, i) => (
                <li key={i} className="text-[11px] text-yellow-200/90">
                  • {w}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Hosts → their cells. */}
        {data.hosts.map((host) => (
          <div key={host.id} className="space-y-2" data-testid="topology-host" data-host-name={host.name}>
            <div className="flex flex-wrap items-center gap-2">
              <IconServer className="text-neutral-500" />
              <span className="font-mono text-sm text-neutral-100">{host.name}</span>
              <Badge tone={hostTone(host.effectiveStatus)}>{host.effectiveStatus}</Badge>
              {host.isSynapseHost && <Badge tone="violet">this host</Badge>}
              {host.region && <Badge tone="neutral">{host.region}</Badge>}
              <span className="text-[11px] text-neutral-500">
                {host.agentCount} agent{host.agentCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="space-y-2 border-l border-neutral-800/80 pl-4">
              {(cellsByHost.get(host.id) ?? []).map((cell) => (
                <CellBlock key={cell.id} cell={cell} cellName={cellName} />
              ))}
              {(cellsByHost.get(host.id) ?? []).length === 0 && (
                <p className="text-[11px] text-neutral-600">No cells on this host.</p>
              )}
            </div>
          </div>
        ))}

        {unplaced.length > 0 && (
          <div className="space-y-2" data-testid="topology-unplaced-cells">
            <p className="text-xs font-semibold text-neutral-300">
              Unplaced cells <span className="text-neutral-600">(no host)</span>
            </p>
            <div className="space-y-2 border-l border-neutral-800/80 pl-4">
              {unplaced.map((cell) => (
                <CellBlock key={cell.id} cell={cell} cellName={cellName} />
              ))}
            </div>
          </div>
        )}

        {data.unassignedDeployments.length > 0 && (
          <div className="space-y-2" data-testid="topology-unassigned-deployments">
            <p className="text-xs font-semibold text-neutral-300">
              Unassigned deployments <span className="text-neutral-600">(no cell)</span>
            </p>
            <div className="space-y-1 border-l border-neutral-800/80 pl-4">
              {data.unassignedDeployments.map((d) => (
                <div key={d.id} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-neutral-300">{d.name}</span>
                  <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.links.length > 0 && (
          <div className="space-y-2" data-testid="topology-links">
            <p className="text-xs font-semibold text-neutral-300">Cell Links</p>
            <div className="space-y-1">
              {data.links.map((l) => (
                <div
                  key={l.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-neutral-800/80 px-2.5 py-1.5 text-[11px]"
                >
                  <span className="font-mono text-neutral-300">
                    {cellName(l.sourceCellId)} → {cellName(l.targetCellId)}
                  </span>
                  <Badge tone="neutral">{l.protocol}</Badge>
                  <Badge tone={l.status === "active" ? "green" : "neutral"}>{l.status}</Badge>
                  {l.hasEndpoint ? (
                    <Badge tone="green">endpoint: {l.endpointSource}</Badge>
                  ) : (
                    <Badge tone="yellow">endpoint unresolved</Badge>
                  )}
                  <span className="text-neutral-500">
                    {l.allowedCommandsCount} cmd · {l.allowedEventsCount} evt · {l.activeTokenCount} token
                    {l.activeTokenCount === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function CellBlock({
  cell,
  cellName,
}: {
  cell: CellTopologyCell;
  cellName: (id: string) => string;
}) {
  return (
    <div className="rounded-md border border-neutral-800/80 bg-neutral-900/30 px-3 py-2" data-testid="topology-cell" data-cell-name={cell.name}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-neutral-100">{cell.name}</span>
        <Badge tone={cellKindTone(cell.kind)}>{cell.kind}</Badge>
        <Badge tone="neutral">{cell.environment}</Badge>
        <Badge tone={cell.status === "active" ? "green" : "yellow"}>{cell.status}</Badge>
      </div>

      {cell.deployments.length > 0 ? (
        <div className="mt-1.5 space-y-1 border-l border-neutral-800 pl-3">
          {cell.deployments.map((d) => (
            <div key={d.id} className="text-[11px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-neutral-300">{d.name}</span>
                <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                {d.placement && (
                  <span className="text-neutral-600">
                    desired {d.placement.desiredStatus} / observed {d.placement.observedStatus}
                  </span>
                )}
              </div>
              {d.url && <div className="truncate text-neutral-600">{d.url}</div>}
              {d.routes.length > 0 && (
                <div className="text-neutral-600">
                  routes: {d.routes.map((r) => r.domain).join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-neutral-600">No deployment attached.</p>
      )}

      {(cell.outgoingLinks.length > 0 || cell.incomingLinks.length > 0) && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-[10px] text-neutral-500">
          {cell.outgoingLinks.map((l) => (
            <span key={l.id}>→ {cellName(l.targetCellId)} ({l.protocol})</span>
          ))}
          {cell.incomingLinks.map((l) => (
            <span key={l.id}>← {cellName(l.sourceCellId)} ({l.protocol})</span>
          ))}
        </div>
      )}

      {cell.warnings.length > 0 && (
        <div className="mt-1 text-[10px] text-yellow-300/80">
          {cell.warnings.map((w, i) => (
            <span key={i} className="mr-2">
              ⚠ {w}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function hostTone(status: string): "green" | "yellow" | "red" | "neutral" {
  switch (status) {
    case "online":
      return "green";
    case "stale":
    case "draining":
      return "yellow";
    case "offline":
      return "red";
    default:
      return "neutral";
  }
}

function statusTone(status: string): "green" | "yellow" | "red" | "neutral" {
  const s = status.toLowerCase();
  if (s.includes("running") || s === "active") return "green";
  if (s.includes("provision") || s.includes("pending")) return "yellow";
  if (s.includes("fail") || s.includes("error")) return "red";
  return "neutral";
}
