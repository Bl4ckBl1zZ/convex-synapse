"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { IconLayers } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  api,
  type Cell,
  type CellEnvironment,
  type CellIsolationTier,
  type CellKind,
  type CellResourcesResponse,
  type Deployment,
  type Host,
} from "@/lib/api";

type Props = { projectId: string };

// CellsPanel (feat/cell-control-plane) — project-scoped operational units.
// A self-contained section (like TopologyPanel / ActivityFeed): it owns its
// own SWR keys and renders below the deployments list. Shows the
// Project → Cell → Deployment tree the operator reasons about, plus the
// create / attach / drain operations the backend exposes.
//
// Cells are project-scoped so this never 403s for a project member. It does
// pull the instance-level hosts list to resolve primary-host names, but
// tolerates a 403 there (non-admin operators just see the host id instead of
// the friendly name — Cells themselves stay fully usable).
export function CellsPanel({ projectId }: Props) {
  const cells = useSWR<Cell[]>(["/cells", projectId], () =>
    api.cells.listByProject(projectId),
  );
  // Shared cache with the project page's deployments list (same key) — no
  // extra round-trip. Used to render the attached deployment's NAME (the
  // cell stores only its UUID) and to populate the attach dropdown.
  const deployments = useSWR<Deployment[]>(["/deployments", projectId], () =>
    api.projects.listDeployments(projectId),
  );
  // Instance-level; may 403 for non-admins. shouldRetryOnError:false so a
  // 403 doesn't spin. Empty map → host shown by short id.
  const hosts = useSWR<Host[]>(["/hosts"], () => api.hosts.list(), {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [detailsCell, setDetailsCell] = useState<Cell | null>(null);
  const [attachDepCell, setAttachDepCell] = useState<Cell | null>(null);
  const [attachHostCell, setAttachHostCell] = useState<Cell | null>(null);
  const [drainCell, setDrainCell] = useState<Cell | null>(null);
  const [deleteCellTarget, setDeleteCellTarget] = useState<Cell | null>(null);

  const deploymentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of deployments.data ?? []) if (d.id) m.set(d.id, d.name);
    return m;
  }, [deployments.data]);

  const hostNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of hosts.data ?? []) m.set(h.id, h.name);
    return m;
  }, [hosts.data]);

  // Deployment ids that are already the primary of some cell — filtered out
  // of the attach dropdown so operators don't pick an obviously-taken one.
  // (Non-primary attachments aren't tracked here; the backend 409s those.)
  const attachedDeploymentIds = useMemo(() => {
    const s = new Set<string>();
    for (const c of cells.data ?? [])
      if (c.primaryDeploymentId) s.add(c.primaryDeploymentId);
    return s;
  }, [cells.data]);

  const list = cells.data ?? [];

  return (
    <Card className="overflow-hidden" data-testid="cells-panel">
      <div className="flex items-center justify-between border-b border-neutral-800/80 px-5 py-3.5">
        <div className="flex items-baseline gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
            <IconLayers className="opacity-70" />
            Cells
          </h3>
          <span className="text-xs text-neutral-500">
            — operational units in this project
          </span>
        </div>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          data-testid="create-cell-button"
        >
          + Create cell
        </Button>
      </div>

      <div className="p-5">
        {cells.error && !(cells.error instanceof ApiError) && (
          <p className="text-xs text-red-400">Failed to load cells.</p>
        )}
        {cells.error instanceof ApiError && (
          <p className="text-xs text-red-400">
            Failed to load cells: {cells.error.message}
          </p>
        )}

        {cells.isLoading && !cells.data && (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {cells.data && list.length === 0 && (
          <EmptyState
            title="No cells yet"
            description="Existing deployments are backfilled into core cells when cells are enabled (SYNAPSE_ENABLE_CELLS). You can also create one manually — e.g. a runtime cell for background processing."
            testId="cells-empty"
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                Create cell
              </Button>
            }
          />
        )}

        {list.length > 0 && (
          <div className="space-y-3" data-testid="cells-list">
            {list.map((cell) => (
              <CellCard
                key={cell.id}
                cell={cell}
                deploymentName={
                  cell.primaryDeploymentId
                    ? deploymentNameById.get(cell.primaryDeploymentId)
                    : undefined
                }
                hostName={
                  cell.primaryHostId
                    ? hostNameById.get(cell.primaryHostId)
                    : undefined
                }
                onDetails={() => setDetailsCell(cell)}
                onAttachDeployment={() => setAttachDepCell(cell)}
                onAttachHost={() => setAttachHostCell(cell)}
                onDrain={() => setDrainCell(cell)}
                onDelete={() => setDeleteCellTarget(cell)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateCellDialog
        key={String(createOpen)}
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void cells.mutate()}
      />
      <CellDetailsDialog
        cell={detailsCell}
        deploymentNameById={deploymentNameById}
        hostNameById={hostNameById}
        onClose={() => setDetailsCell(null)}
      />
      <AttachDeploymentDialog
        key={attachDepCell?.id ?? "attach-dep-closed"}
        cell={attachDepCell}
        deployments={deployments.data ?? []}
        attachedDeploymentIds={attachedDeploymentIds}
        onClose={() => setAttachDepCell(null)}
        onAttached={() => void cells.mutate()}
      />
      <AttachHostDialog
        key={attachHostCell?.id ?? "attach-host-closed"}
        cell={attachHostCell}
        hosts={hosts.data ?? []}
        hostsError={hosts.error}
        onClose={() => setAttachHostCell(null)}
        onAttached={() => void cells.mutate()}
      />
      <DrainCellDialog
        cell={drainCell}
        onClose={() => setDrainCell(null)}
        onDrained={() => void cells.mutate()}
      />
      <DeleteCellDialog
        cell={deleteCellTarget}
        onClose={() => setDeleteCellTarget(null)}
        onDeleted={() => void cells.mutate()}
      />
    </Card>
  );
}

/* -------------------- cell card -------------------- */

export function cellKindTone(
  kind: string,
): "violet" | "cyan" | "green" | "yellow" | "amber" | "neutral" {
  switch (kind) {
    case "core":
      return "violet";
    case "runtime":
      return "cyan";
    case "integration":
      return "green";
    case "preview":
      return "yellow";
    case "enterprise-app":
      return "amber";
    default:
      return "neutral";
  }
}

function cellEnvTone(env: string): "amber" | "cyan" | "yellow" | "violet" | "neutral" {
  switch (env) {
    case "prod":
      return "amber";
    case "dev":
      return "cyan";
    case "staging":
      return "yellow";
    case "preview":
      return "violet";
    default:
      return "neutral";
  }
}

function cellStatusTone(status: string): "green" | "yellow" | "neutral" {
  switch (status) {
    case "active":
      return "green";
    case "draining":
    case "migrating":
    case "maintenance":
      return "yellow";
    default:
      return "neutral";
  }
}

function CellCard({
  cell,
  deploymentName,
  hostName,
  onDetails,
  onAttachDeployment,
  onAttachHost,
  onDrain,
  onDelete,
}: {
  cell: Cell;
  deploymentName?: string;
  hostName?: string;
  onDetails: () => void;
  onAttachDeployment: () => void;
  onAttachHost: () => void;
  onDrain: () => void;
  onDelete: () => void;
}) {
  return (
    <Card data-testid="cell-card" data-cell-name={cell.name}>
      <CardBody className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-neutral-100">
              {cell.name}
            </span>
            <Badge tone={cellKindTone(cell.kind)}>{cell.kind}</Badge>
            <Badge tone={cellEnvTone(cell.environment)}>{cell.environment}</Badge>
            <Badge tone={cellStatusTone(cell.status)}>{cell.status}</Badge>
            {cell.region && <Badge tone="neutral">{cell.region}</Badge>}
            {cell.isolationTier && cell.isolationTier !== "shared" && (
              <Badge tone="neutral">{cell.isolationTier}</Badge>
            )}
          </div>

          {/* Project → Cell → Deployment / Host tree. */}
          <div className="space-y-0.5 text-xs text-neutral-400">
            <p>
              <span className="text-neutral-600">Deployment:</span>{" "}
              {cell.primaryDeploymentId ? (
                <span className="font-mono text-neutral-300">
                  {deploymentName ?? cell.primaryDeploymentId.slice(0, 8)}
                </span>
              ) : (
                <span className="text-neutral-600">none attached</span>
              )}
            </p>
            <p>
              <span className="text-neutral-600">Host:</span>{" "}
              {cell.primaryHostId ? (
                <span className="text-neutral-300">
                  {hostName ?? `host ${cell.primaryHostId.slice(0, 8)}`}
                </span>
              ) : (
                <span className="text-neutral-600">none</span>
              )}
            </p>
          </div>
          {cell.description && (
            <p className="text-xs text-neutral-500">{cell.description}</p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Button variant="secondary" size="sm" onClick={onDetails}>
            Details
          </Button>
          <Button variant="ghost" size="sm" onClick={onAttachDeployment}>
            Attach deployment
          </Button>
          <Button variant="ghost" size="sm" onClick={onAttachHost}>
            Attach host
          </Button>
          {cell.status !== "draining" && (
            <Button variant="ghost" size="sm" onClick={onDrain}>
              Drain
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/* -------------------- create cell -------------------- */

const KINDS: CellKind[] = [
  "core",
  "runtime",
  "integration",
  "preview",
  "enterprise-app",
];
const ENVS: CellEnvironment[] = ["dev", "staging", "prod", "preview"];
const TIERS: CellIsolationTier[] = [
  "shared",
  "premium",
  "dedicated",
  "internal",
];

function CreateCellDialog({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("core");
  const [environment, setEnvironment] = useState<string>("dev");
  const [region, setRegion] = useState("");
  const [isolationTier, setIsolationTier] = useState<string>("shared");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setPending(true);
    try {
      await api.cells.create(projectId, {
        name: name.trim(),
        kind: kind as CellKind,
        environment: environment as CellEnvironment,
        region: region.trim() || undefined,
        isolationTier: isolationTier as CellIsolationTier,
        description: description.trim() || undefined,
      });
      onCreated();
      onClose();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not create cell",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Create cell">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="cell-name" className="block text-xs text-neutral-400">
            Name
          </label>
          <Input
            id="cell-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="runtime-prod-br-1"
            required
            autoFocus
            maxLength={200}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Kind" id="cell-kind" value={kind} onChange={setKind} options={KINDS} />
          <SelectField
            label="Environment"
            id="cell-env"
            value={environment}
            onChange={setEnvironment}
            options={ENVS}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <label htmlFor="cell-region" className="block text-xs text-neutral-400">
              Region <span className="text-neutral-600">(optional)</span>
            </label>
            <Input
              id="cell-region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="br"
            />
          </div>
          <SelectField
            label="Isolation tier"
            id="cell-tier"
            value={isolationTier}
            onChange={setIsolationTier}
            options={TIERS}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="cell-desc" className="block text-xs text-neutral-400">
            Description <span className="text-neutral-600">(optional)</span>
          </label>
          <Input
            id="cell-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Background automation runtime"
          />
        </div>

        {formError && <p className="text-xs text-red-400">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SelectField({
  label,
  id,
  value,
  onChange,
  options,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-xs text-neutral-400">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

/* -------------------- cell details -------------------- */

function CellDetailsDialog({
  cell,
  deploymentNameById,
  hostNameById,
  onClose,
}: {
  cell: Cell | null;
  deploymentNameById: Map<string, string>;
  hostNameById: Map<string, string>;
  onClose: () => void;
}) {
  // Only fetch resources while the dialog is open for a given cell.
  const { data, error, isLoading } = useSWR<CellResourcesResponse>(
    cell ? ["/cell-resources", cell.id] : null,
    () => api.cells.resources(cell!.id),
  );

  if (!cell) {
    return (
      <Dialog open={false} onClose={onClose}>
        <></>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={cell.name} className="max-w-lg">
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={cellKindTone(cell.kind)}>{cell.kind}</Badge>
          <Badge tone="neutral">{cell.environment}</Badge>
          <Badge tone={cellStatusTone(cell.status)}>{cell.status}</Badge>
          {cell.region && <Badge tone="neutral">{cell.region}</Badge>}
          <Badge tone="neutral">{cell.isolationTier}</Badge>
        </div>

        <dl className="grid grid-cols-3 gap-y-1 text-xs">
          <Meta label="Slug" value={cell.slug} mono />
          <Meta
            label="Primary deployment"
            value={
              cell.primaryDeploymentId
                ? deploymentNameById.get(cell.primaryDeploymentId) ??
                  cell.primaryDeploymentId
                : "—"
            }
            mono
          />
          <Meta
            label="Primary host"
            value={
              cell.primaryHostId
                ? hostNameById.get(cell.primaryHostId) ?? cell.primaryHostId
                : "—"
            }
          />
          <Meta label="Created" value={formatDate(cell.createdAt)} />
          <Meta label="Updated" value={formatDate(cell.updatedAt)} />
        </dl>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-neutral-200">Resources</p>
          {isLoading && <p className="text-xs text-neutral-500">Loading…</p>}
          {error instanceof ApiError && (
            <p className="text-xs text-red-400">{error.message}</p>
          )}
          {data && data.resources.length === 0 && (
            <p className="text-xs text-neutral-500">
              No resources attached yet.
            </p>
          )}
          {data && data.resources.length > 0 && (
            <div className="overflow-hidden rounded-md border border-neutral-800/80">
              <table className="w-full text-[11px]">
                <thead className="bg-neutral-950 text-neutral-400">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Type</th>
                    <th className="px-3 py-2 text-left font-medium">Resource</th>
                    <th className="px-3 py-2 text-left font-medium">Role</th>
                    <th className="px-3 py-2 text-left font-medium">Observed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-900">
                  {data.resources.map((r) => {
                    const placement = data.placements.find(
                      (p) => p.deploymentId === r.resourceId,
                    );
                    return (
                      <tr key={r.id} className="text-neutral-200">
                        <td className="px-3 py-2">{r.resourceType}</td>
                        <td className="px-3 py-2 font-mono text-neutral-400">
                          {deploymentNameById.get(r.resourceId) ??
                            r.resourceId.slice(0, 8)}
                        </td>
                        <td className="px-3 py-2">{r.role}</td>
                        <td className="px-3 py-2 text-neutral-400">
                          {placement?.observedStatus ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}

function Meta({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="col-span-1 text-neutral-500">{label}</dt>
      <dd
        className={`col-span-2 truncate text-neutral-300 ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </dd>
    </>
  );
}

/* -------------------- attach deployment -------------------- */

function AttachDeploymentDialog({
  cell,
  deployments,
  attachedDeploymentIds,
  onClose,
  onAttached,
}: {
  cell: Cell | null;
  deployments: Deployment[];
  attachedDeploymentIds: Set<string>;
  onClose: () => void;
  onAttached: () => void;
}) {
  const available = deployments.filter(
    (d) => !(d.id && attachedDeploymentIds.has(d.id)),
  );
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!cell) {
    return (
      <Dialog open={false} onClose={onClose}>
        <></>
      </Dialog>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = selected || available[0]?.name;
    if (!name) return;
    setFormError(null);
    setPending(true);
    try {
      await api.cells.attachDeployment(cell.id, name);
      onAttached();
      onClose();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not attach deployment",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Attach deployment to ${cell.name}`}>
      <form onSubmit={submit} className="space-y-4">
        {available.length === 0 ? (
          <p className="text-xs text-neutral-500">
            Every deployment in this project is already attached to a cell. A
            deployment can belong to only one cell at a time.
          </p>
        ) : (
          <div className="space-y-2">
            <label htmlFor="attach-dep" className="block text-xs text-neutral-400">
              Deployment
            </label>
            <select
              id="attach-dep"
              value={selected || available[0]?.name}
              onChange={(e) => setSelected(e.target.value)}
              className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
            >
              {available.map((d) => (
                <option key={d.id ?? d.name} value={d.name}>
                  {d.name}
                  {d.deploymentType || d.type
                    ? ` (${d.deploymentType ?? d.type})`
                    : ""}
                </option>
              ))}
            </select>
            <p className="text-xs text-neutral-500">
              The deployment becomes this cell&apos;s primary resource and is
              placed on the cell&apos;s host (if one is attached).
            </p>
          </div>
        )}

        {formError && <p className="text-xs text-red-400">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || available.length === 0}>
            {pending ? "Attaching…" : "Attach"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* -------------------- attach host -------------------- */

function AttachHostDialog({
  cell,
  hosts,
  hostsError,
  onClose,
  onAttached,
}: {
  cell: Cell | null;
  hosts: Host[];
  hostsError: unknown;
  onClose: () => void;
  onAttached: () => void;
}) {
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!cell) {
    return (
      <Dialog open={false} onClose={onClose}>
        <></>
      </Dialog>
    );
  }

  const forbidden =
    hostsError instanceof ApiError && hostsError.status === 403;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hostId = selected || hosts[0]?.id;
    if (!hostId) return;
    setFormError(null);
    setPending(true);
    try {
      await api.cells.attachHost(cell.id, hostId);
      onAttached();
      onClose();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not attach host",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Attach host to ${cell.name}`}>
      <form onSubmit={submit} className="space-y-4">
        {forbidden ? (
          <p className="text-xs text-neutral-500">
            Hosts are managed by instance admins. Ask an instance admin to
            create a host, or sign in as one.
          </p>
        ) : hosts.length === 0 ? (
          <p className="text-xs text-neutral-500">
            No hosts yet. Create a host in the Hosts section first, then attach
            it here.
          </p>
        ) : (
          <div className="space-y-2">
            <label htmlFor="attach-host" className="block text-xs text-neutral-400">
              Host
            </label>
            <select
              id="attach-host"
              value={selected || hosts[0]?.id}
              onChange={(e) => setSelected(e.target.value)}
              className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
            >
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.region ? ` (${h.region})` : ""}
                </option>
              ))}
            </select>
            <p className="text-xs text-neutral-500">
              Sets the cell&apos;s primary host. Existing placements without a
              host are pinned to it; running deployments are not moved.
            </p>
          </div>
        )}

        {formError && <p className="text-xs text-red-400">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={pending || forbidden || hosts.length === 0}
          >
            {pending ? "Attaching…" : "Attach"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* -------------------- drain confirm -------------------- */

function DrainCellDialog({
  cell,
  onClose,
  onDrained,
}: {
  cell: Cell | null;
  onClose: () => void;
  onDrained: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!cell) {
    return (
      <Dialog open={false} onClose={onClose}>
        <></>
      </Dialog>
    );
  }

  const drain = async () => {
    setFormError(null);
    setPending(true);
    try {
      await api.cells.drain(cell.id);
      onDrained();
      onClose();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not drain cell");
      setPending(false);
    }
  };

  return (
    <Dialog open onClose={pending ? () => {} : onClose} title="Drain cell">
      <div className="space-y-4">
        <p className="text-sm text-neutral-300">
          Mark{" "}
          <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs">
            {cell.name}
          </code>{" "}
          as <Badge tone="yellow" className="align-middle">draining</Badge>? This
          is a status change only — it does not stop or move any deployment.
        </p>
        {formError && <p className="text-xs text-red-400">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={drain}
            disabled={pending}
            data-testid="confirm-drain-cell"
          >
            {pending ? "Draining…" : "Drain cell"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/* -------------------- delete confirm -------------------- */

function DeleteCellDialog({
  cell,
  onClose,
  onDeleted,
}: {
  cell: Cell | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!cell) {
    return (
      <Dialog open={false} onClose={onClose}>
        <></>
      </Dialog>
    );
  }

  const remove = async () => {
    setFormError(null);
    setPending(true);
    try {
      await api.cells.delete(cell.id);
      onDeleted();
      onClose();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not delete cell");
      setPending(false);
    }
  };

  return (
    <Dialog open onClose={pending ? () => {} : onClose} title="Delete cell">
      <div className="space-y-4">
        <p className="text-sm text-neutral-300">
          Delete{" "}
          <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs">
            {cell.name}
          </code>
          ? Any deployments in it become <strong>unassigned</strong> — they keep
          running, they just lose the grouping. A cell with active links can&apos;t
          be deleted; remove its links first. This can&apos;t be undone.
        </p>
        {formError && <p className="text-xs text-red-400">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={remove}
            disabled={pending}
            data-testid="confirm-delete-cell"
          >
            {pending ? "Deleting…" : "Delete cell"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
