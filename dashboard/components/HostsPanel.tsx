"use client";

import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { IconServer } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  api,
  type Host,
  type HostAdoptionToken,
  type HostAgentsResponse,
} from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";

// HostsPanel (feat/cell-control-plane) — instance-level machines (VPSs).
//
// Hosts are gated to instance-admin server-side, so the list 403s for
// ordinary project members. Like TopologyPanel, this panel HIDES itself on
// 401/403 rather than flashing a red error on every project page — the
// common self-hosted operator IS the instance admin and sees it fully;
// non-admin teammates simply don't see a section they can't use.
//
// The synapse-agent runtime (heartbeat / observed state) is a later block;
// today hosts are registered manually + issued one-time adoption tokens.
export function HostsPanel() {
  const { data, error, isLoading, mutate } = useSWR<Host[]>(
    ["/hosts"],
    () => api.hosts.list(),
    { shouldRetryOnError: false, revalidateOnFocus: false },
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [tokenHost, setTokenHost] = useState<Host | null>(null);
  const [detailsHost, setDetailsHost] = useState<Host | null>(null);
  const [drainHost, setDrainHost] = useState<Host | null>(null);

  // Instance-admin gate: hide entirely for non-admins (and unauthenticated).
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return null;
  }
  if (isLoading && !data) return null;

  const hosts = data ?? [];

  return (
    <Card className="overflow-hidden" data-testid="hosts-panel">
      <div className="flex items-center justify-between border-b border-neutral-800/80 px-5 py-3.5">
        <div className="flex items-baseline gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
            <IconServer className="opacity-70" />
            Hosts
          </h3>
          <span className="text-xs text-neutral-500">
            — machines that run deployments
          </span>
        </div>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          data-testid="create-host-button"
        >
          + Create host
        </Button>
      </div>

      <div className="space-y-3 p-5">
        <p className="rounded border border-neutral-800/80 bg-neutral-900/40 px-3 py-2 text-[11px] text-neutral-500">
          The synapse-agent is observe-only: register a host, issue an adoption
          token, and run the agent there to get live heartbeat + observed
          container state. The host running Synapse itself shows online
          automatically.
        </p>

        {error && !(error instanceof ApiError) && (
          <p className="text-xs text-red-400">Failed to load hosts.</p>
        )}
        {error instanceof ApiError && (
          <p className="text-xs text-red-400">
            Failed to load hosts: {error.message}
          </p>
        )}

        {!data && !error && (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {data && hosts.length === 0 && (
          <EmptyState
            title="No hosts yet"
            description="Create a host to represent a VPS the control plane can place deployments on. The host this Synapse runs on is created automatically when cells are enabled."
            testId="hosts-empty"
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                Create host
              </Button>
            }
          />
        )}

        {hosts.length > 0 && (
          <div className="space-y-3" data-testid="hosts-list">
            {hosts.map((host) => (
              <HostCard
                key={host.id}
                host={host}
                onToken={() => setTokenHost(host)}
                onDetails={() => setDetailsHost(host)}
                onDrain={() => setDrainHost(host)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateHostDialog
        key={String(createOpen)}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void mutate()}
      />
      <AdoptionTokenDialog
        key={tokenHost?.id ?? "token-closed"}
        host={tokenHost}
        onClose={() => setTokenHost(null)}
      />
      <HostDetailsDialog
        key={detailsHost?.id ?? "host-details-closed"}
        host={detailsHost}
        onClose={() => setDetailsHost(null)}
      />
      <DrainHostDialog
        host={drainHost}
        onClose={() => setDrainHost(null)}
        onDrained={() => void mutate()}
      />
    </Card>
  );
}

function hostStatusTone(status: string): "green" | "yellow" | "red" | "neutral" {
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

// hostStatus prefers the computed effectiveStatus (online/stale/offline),
// falling back to the stored status for older/stubbed payloads.
function hostStatus(host: Host): string {
  return host.effectiveStatus || host.status;
}

// timeAgo renders a compact relative time ("42s ago", "3m ago", "2d ago").
function timeAgo(iso?: string): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function HostCard({
  host,
  onToken,
  onDetails,
  onDrain,
}: {
  host: Host;
  onToken: () => void;
  onDetails: () => void;
  onDrain: () => void;
}) {
  return (
    <Card data-testid="host-card" data-host-name={host.name}>
      <CardBody className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-neutral-100">
              {host.name}
            </span>
            <Badge tone={hostStatusTone(hostStatus(host))}>{hostStatus(host)}</Badge>
            {host.isSynapseHost && <Badge tone="violet">this host</Badge>}
            <Badge tone="neutral">{host.provider}</Badge>
            {host.region && <Badge tone="neutral">{host.region}</Badge>}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-neutral-400">
            {host.publicIp && (
              <span>
                <span className="text-neutral-600">IP:</span>{" "}
                <span className="font-mono">{host.publicIp}</span>
              </span>
            )}
            {host.cpuCores != null && <span>{host.cpuCores} vCPU</span>}
            {host.memoryMb != null && <span>{formatMb(host.memoryMb)}</span>}
            {host.diskGb != null && <span>{host.diskGb} GB disk</span>}
            <span title={host.lastHeartbeatAt ? formatDate(host.lastHeartbeatAt) : undefined}>
              <span className="text-neutral-600">Last seen:</span>{" "}
              {timeAgo(host.lastHeartbeatAt)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Button variant="secondary" size="sm" onClick={onToken}>
            Adoption token
          </Button>
          <Button variant="ghost" size="sm" onClick={onDetails}>
            Details
          </Button>
          {host.status !== "draining" && (
            <Button variant="ghost" size="sm" onClick={onDrain}>
              Drain
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

/* -------------------- create host -------------------- */

function CreateHostDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [region, setRegion] = useState("");
  const [publicIp, setPublicIp] = useState("");
  const [privateIp, setPrivateIp] = useState("");
  const [labels, setLabels] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setPending(true);
    try {
      await api.hosts.create({
        name: name.trim(),
        provider: provider.trim() || undefined,
        region: region.trim() || undefined,
        publicIp: publicIp.trim() || undefined,
        privateIp: privateIp.trim() || undefined,
        labels: parseLabels(labels),
      });
      onCreated();
      onClose();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not create host",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Create host">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="host-name" className="block text-xs text-neutral-400">
            Name
          </label>
          <Input
            id="host-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="vps-br-1"
            required
            autoFocus
            maxLength={200}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <label htmlFor="host-provider" className="block text-xs text-neutral-400">
              Provider <span className="text-neutral-600">(optional)</span>
            </label>
            <Input
              id="host-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="hostinger"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="host-region" className="block text-xs text-neutral-400">
              Region <span className="text-neutral-600">(optional)</span>
            </label>
            <Input
              id="host-region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="br"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <label htmlFor="host-public-ip" className="block text-xs text-neutral-400">
              Public IP <span className="text-neutral-600">(optional)</span>
            </label>
            <Input
              id="host-public-ip"
              value={publicIp}
              onChange={(e) => setPublicIp(e.target.value)}
              placeholder="203.0.113.10"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="host-private-ip" className="block text-xs text-neutral-400">
              Private IP <span className="text-neutral-600">(optional)</span>
            </label>
            <Input
              id="host-private-ip"
              value={privateIp}
              onChange={(e) => setPrivateIp(e.target.value)}
              placeholder="10.0.0.4"
            />
          </div>
        </div>
        <div className="space-y-2">
          <label htmlFor="host-labels" className="block text-xs text-neutral-400">
            Labels <span className="text-neutral-600">(optional, key=value, comma-separated)</span>
          </label>
          <Input
            id="host-labels"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="tier=prod, rack=a1"
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

// parseLabels turns "tier=prod, rack=a1" into { tier: "prod", rack: "a1" }.
// Returns undefined when empty so the body omits the field.
function parseLabels(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, ...rest] = pair.split("=");
    const key = k.trim();
    const value = rest.join("=").trim();
    if (key && value) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/* -------------------- adoption token (once-shown) -------------------- */

function AdoptionTokenDialog({
  host,
  onClose,
}: {
  host: Host | null;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<HostAdoptionToken | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!host) {
    return (
      <Dialog open={false} onClose={onClose}>
        <></>
      </Dialog>
    );
  }

  const generate = async () => {
    setFormError(null);
    setPending(true);
    try {
      const tok = await api.hosts.createAdoptionToken(host.id, {});
      setIssued(tok);
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not generate token",
      );
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!issued) return;
    const ok = await copyToClipboard(issued.joinCommand);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setFormError("Could not copy — select the command manually and Ctrl+C");
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={issued ? "Adoption token created" : `Adoption token for ${host.name}`}
    >
      {!issued ? (
        <div className="space-y-4">
          <p className="text-sm text-neutral-300">
            Generate a one-time token to connect a synapse-agent on{" "}
            <span className="font-mono">{host.name}</span>. The token is shown
            only once and expires in 1 hour.
          </p>
          {formError && <p className="text-xs text-red-400">{formError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={generate} disabled={pending}>
              {pending ? "Generating…" : "Generate token"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="rounded bg-yellow-900/40 px-3 py-2 text-xs text-yellow-200">
            This token appears only once. Run the command below on the VPS now —
            if you lose it, generate a new one.
          </p>
          <p className="text-xs text-neutral-400">Run on the host:</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-neutral-800/80 bg-neutral-950 p-3 font-mono text-[11px] leading-snug text-neutral-200">
            {issued.joinCommand}
          </pre>
          {issued.expiresAt && (
            <p className="text-[11px] text-neutral-500">
              Expires {formatDate(issued.expiresAt)}.
            </p>
          )}
          {formError && <p className="text-xs text-red-400">{formError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={copy} data-testid="copy-join-command">
              {copied ? "Copied!" : "Copy join command"}
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/* -------------------- host details -------------------- */

function agentTone(status: string): "green" | "yellow" | "red" | "neutral" {
  switch (status) {
    case "online":
      return "green";
    case "offline":
      return "yellow";
    case "revoked":
      return "red";
    default:
      return "neutral";
  }
}

function HostDetailsDialog({
  host,
  onClose,
}: {
  host: Host | null;
  onClose: () => void;
}) {
  // Fetch this host's agents while the dialog is open (null key → no fetch).
  // Hooks run unconditionally (before the !host early-return) per the rules
  // of hooks.
  const { data, error, mutate } = useSWR<HostAgentsResponse>(
    host ? ["/host-agents", host.id] : null,
    () => api.hosts.agents(host!.id),
    { revalidateOnFocus: false },
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [rotated, setRotated] = useState<{ agentId: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  if (!host) {
    return (
      <Dialog open={false} onClose={onClose}>
        <></>
      </Dialog>
    );
  }
  const labelEntries = Object.entries(host.labels ?? {});
  const agents = data?.items ?? [];

  const revoke = async (agentId: string) => {
    setActionError(null);
    setBusyAgentId(agentId);
    try {
      await api.hosts.revokeAgent(agentId);
      await mutate();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Could not revoke agent");
    } finally {
      setBusyAgentId(null);
    }
  };
  const rotate = async (agentId: string) => {
    setActionError(null);
    setBusyAgentId(agentId);
    try {
      const r = await api.hosts.rotateAgentToken(agentId);
      setRotated({ agentId, token: r.agentToken });
      setCopied(false);
      await mutate();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Could not rotate token");
    } finally {
      setBusyAgentId(null);
    }
  };

  return (
    <Dialog open onClose={onClose} title={host.name} className="max-w-lg">
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={hostStatusTone(hostStatus(host))}>{hostStatus(host)}</Badge>
          {host.isSynapseHost && <Badge tone="violet">this host</Badge>}
          <Badge tone="neutral">{host.provider}</Badge>
          {host.region && <Badge tone="neutral">{host.region}</Badge>}
        </div>
        <dl className="grid grid-cols-3 gap-y-1 text-xs">
          <Meta label="Public IP" value={host.publicIp || "—"} mono />
          <Meta label="Private IP" value={host.privateIp || "—"} mono />
          <Meta label="Agent version" value={host.agentVersion || "—"} />
          <Meta label="Docker version" value={host.dockerVersion || "—"} />
          <Meta label="vCPU" value={host.cpuCores != null ? String(host.cpuCores) : "—"} />
          <Meta label="Memory" value={host.memoryMb != null ? formatMb(host.memoryMb) : "—"} />
          <Meta label="Disk" value={host.diskGb != null ? `${host.diskGb} GB` : "—"} />
          <Meta label="Last seen" value={timeAgo(host.lastHeartbeatAt)} />
          <Meta label="Created" value={formatDate(host.createdAt)} />
        </dl>
        {labelEntries.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-neutral-200">Labels</p>
            <div className="flex flex-wrap gap-1.5">
              {labelEntries.map(([k, v]) => (
                <Badge key={k} tone="neutral">
                  {k}={v}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Agents on this host (Bloco 6.5). */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-neutral-200">
            Agents{agents.length ? ` (${agents.length})` : ""}
          </p>
          {error instanceof ApiError && (
            <p className="text-xs text-red-400">{error.message}</p>
          )}
          {agents.length === 0 ? (
            <p className="text-[11px] text-neutral-500">
              No agent has registered on this host yet. Generate an adoption
              token and run <code>synapse-agent join</code> on the VPS.
            </p>
          ) : (
            <div className="space-y-1.5">
              {agents.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between gap-2 rounded border border-neutral-800/80 px-2.5 py-1.5"
                >
                  <div className="min-w-0 text-[11px]">
                    <div className="flex items-center gap-1.5">
                      <Badge tone={agentTone(a.status)}>{a.status}</Badge>
                      <span className="text-neutral-500">{a.connectionMode}</span>
                      <span className="text-neutral-500">seen {timeAgo(a.lastSeenAt)}</span>
                    </div>
                    {a.observed && (
                      <p className="mt-0.5 text-neutral-600">
                        docker {a.observed.dockerAvailable ? "up" : "down"} ·{" "}
                        {a.observed.managedContainerCount} managed
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {a.status !== "revoked" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyAgentId === a.id}
                        onClick={() => revoke(a.id)}
                      >
                        Revoke
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyAgentId === a.id}
                      onClick={() => rotate(a.id)}
                    >
                      Rotate
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {actionError && <p className="text-xs text-red-400">{actionError}</p>}
          {rotated && (
            <div className="space-y-1 rounded border border-yellow-900/60 bg-yellow-900/20 px-2.5 py-2">
              <p className="text-[11px] text-yellow-200">
                New agent token (shown once) — update the VPS config or re-run{" "}
                <code>synapse-agent join</code>:
              </p>
              <pre className="overflow-x-auto break-all rounded bg-neutral-950 p-2 font-mono text-[11px] text-neutral-200">
                {rotated.token}
              </pre>
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    if (await copyToClipboard(rotated.token)) {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }
                  }}
                >
                  {copied ? "Copied!" : "Copy token"}
                </Button>
              </div>
            </div>
          )}
        </div>

        <p className="rounded border border-neutral-800/80 bg-neutral-900/40 px-3 py-2 text-[11px] text-neutral-500">
          The agent is observe-only — live heartbeat + metrics; no
          apply/reconcile yet.
        </p>
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

/* -------------------- drain confirm -------------------- */

function DrainHostDialog({
  host,
  onClose,
  onDrained,
}: {
  host: Host | null;
  onClose: () => void;
  onDrained: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!host) {
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
      await api.hosts.drain(host.id);
      onDrained();
      onClose();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not drain host");
      setPending(false);
    }
  };

  return (
    <Dialog open onClose={pending ? () => {} : onClose} title="Drain host">
      <div className="space-y-4">
        <p className="text-sm text-neutral-300">
          Mark{" "}
          <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs">
            {host.name}
          </code>{" "}
          as <Badge tone="yellow" className="align-middle">draining</Badge>? This
          is a status change only — no containers are stopped or moved.
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
            data-testid="confirm-drain-host"
          >
            {pending ? "Draining…" : "Drain host"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
