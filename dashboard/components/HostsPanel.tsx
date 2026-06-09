"use client";

import { useState } from "react";
import Link from "next/link";
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
  type RemoteSetupBundle,
} from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";

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
  const { t } = useT();
  const { data, error, isLoading, mutate } = useSWR<Host[]>(
    ["/hosts"],
    () => api.hosts.list(),
    { shouldRetryOnError: false, revalidateOnFocus: false },
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [tokenHost, setTokenHost] = useState<Host | null>(null);
  const [detailsHost, setDetailsHost] = useState<Host | null>(null);
  const [drainHost, setDrainHost] = useState<Host | null>(null);
  const [removeHost, setRemoveHost] = useState<Host | null>(null);
  // v1.18+ Remote Hosts: per-row "Setup remote install" modal. Holds the
  // host the operator clicked PLUS the lazily-fetched bundle (or error).
  // Re-mounting via `key={remoteSetupHost?.id}` resets state when the
  // operator opens it for a different host.
  const [remoteSetupHost, setRemoteSetupHost] = useState<Host | null>(null);

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
            {t("Hosts")}
          </h3>
          <span className="text-xs text-neutral-500">
            {t("— machines that run deployments")}
          </span>
        </div>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          data-testid="create-host-button"
        >
          {t("+ Create host")}
        </Button>
      </div>

      <div className="space-y-3 p-5">
        <p className="rounded border border-neutral-800/80 bg-neutral-900/40 px-3 py-2 text-[11px] text-neutral-500">
          {t(
            "The synapse-agent is observe-only: register a host, issue an adoption token, and run the agent there to get live heartbeat + observed container state. The host running Synapse itself shows online automatically.",
          )}
        </p>

        {error && !(error instanceof ApiError) && (
          <p className="text-xs text-red-400">{t("Failed to load hosts.")}</p>
        )}
        {error instanceof ApiError && (
          <p className="text-xs text-red-400">
            {t("Failed to load hosts: {message}", { message: error.message })}
          </p>
        )}

        {!data && !error && (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {data && hosts.length === 0 && (
          <EmptyState
            title={t("No hosts yet")}
            description={t(
              "Create a host to represent a VPS the control plane can place deployments on. The host this Synapse runs on is created automatically when cells are enabled.",
            )}
            testId="hosts-empty"
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                {t("Create host")}
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
                onRemove={() => setRemoveHost(host)}
                onRemoteSetup={() => setRemoteSetupHost(host)}
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
      <RemoveHostDialog
        host={removeHost}
        onClose={() => setRemoveHost(null)}
        onRemoved={() => void mutate()}
      />
      <RemoteSetupDialog
        key={remoteSetupHost?.id ?? "remote-setup-closed"}
        host={remoteSetupHost}
        onClose={() => setRemoteSetupHost(null)}
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
  onRemove,
  onRemoteSetup,
}: {
  host: Host;
  onToken: () => void;
  onDetails: () => void;
  onDrain: () => void;
  onRemove: () => void;
  onRemoteSetup: () => void;
}) {
  const { t } = useT();
  return (
    <Card data-testid="host-card" data-host-name={host.name}>
      <CardBody className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-neutral-100">
              {host.name}
            </span>
            <Badge tone={hostStatusTone(hostStatus(host))}>{hostStatus(host)}</Badge>
            {host.isSynapseHost && <Badge tone="violet">{t("this host")}</Badge>}
            <Badge tone="neutral">{host.provider}</Badge>
            {host.region && <Badge tone="neutral">{host.region}</Badge>}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-neutral-400">
            {host.publicIp && (
              <span>
                <span className="text-neutral-600">{t("IP:")}</span>{" "}
                <span className="font-mono">{host.publicIp}</span>
              </span>
            )}
            {host.cpuCores != null && <span>{t("{cores} vCPU", { cores: host.cpuCores })}</span>}
            {host.memoryMb != null && <span>{formatMb(host.memoryMb)}</span>}
            {host.diskGb != null && <span>{t("{gb} GB disk", { gb: host.diskGb })}</span>}
            <span title={host.lastHeartbeatAt ? formatDate(host.lastHeartbeatAt) : undefined}>
              <span className="text-neutral-600">{t("Last seen:")}</span>{" "}
              {timeAgo(host.lastHeartbeatAt)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Button variant="secondary" size="sm" onClick={onToken}>
            {t("Adoption token")}
          </Button>
          {/* v1.18+ Remote Hosts — only meaningful for adoptable hosts.
              The self-host runs Synapse itself; install-agent.sh there
              would be a no-op (or worse, try to re-tailnet-join the
              control plane). Filter on isSynapseHost mirrors what the
              backend uses to gate /v1/hosts list ordering. */}
          {!host.isSynapseHost && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemoteSetup}
              data-testid={`setup-remote-${host.name}`}
            >
              {t("Setup remote install")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDetails}>
            {t("Details")}
          </Button>
          {host.status !== "draining" && (
            <Button variant="ghost" size="sm" onClick={onDrain}>
              {t("Drain")}
            </Button>
          )}
          {/* Registry-only removal. NEVER offered for the self-host — the
              control plane row that represents the machine Synapse runs on
              must stay. The backend also refuses with cannot_remove_self_host,
              but gating here keeps the destructive button off that row. */}
          {!host.isSynapseHost && (
            <Button
              variant="danger"
              size="sm"
              onClick={onRemove}
              data-testid={`remove-host-${host.name}`}
            >
              {t("Remove")}
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
  const { t } = useT();
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
        err instanceof ApiError ? err.message : t("Could not create host"),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("Create host")}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="host-name" className="block text-xs text-neutral-400">
            {t("Name")}
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
              {t("Provider")} <span className="text-neutral-600">{t("(optional)")}</span>
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
              {t("Region")} <span className="text-neutral-600">{t("(optional)")}</span>
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
              {t("Public IP")} <span className="text-neutral-600">{t("(optional)")}</span>
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
              {t("Private IP")} <span className="text-neutral-600">{t("(optional)")}</span>
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
            {t("Labels")} <span className="text-neutral-600">{t("(optional, key=value, comma-separated)")}</span>
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
            {t("Cancel")}
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending ? t("Creating…") : t("Create")}
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
  const { t } = useT();
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
        err instanceof ApiError ? err.message : t("Could not generate token"),
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
      setFormError(t("Could not copy — select the command manually and Ctrl+C"));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={issued ? t("Adoption token created") : t("Adoption token for {name}", { name: host.name })}
    >
      {!issued ? (
        <div className="space-y-4">
          <p className="text-sm text-neutral-300">
            {t("Generate a one-time token to connect a synapse-agent on")}{" "}
            <span className="font-mono">{host.name}</span>
            {t(". The token is shown only once and expires in 1 hour.")}
          </p>
          {formError && <p className="text-xs text-red-400">{formError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {t("Cancel")}
            </Button>
            <Button type="button" onClick={generate} disabled={pending}>
              {pending ? t("Generating…") : t("Generate token")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="rounded bg-yellow-900/40 px-3 py-2 text-xs text-yellow-200">
            {t(
              "This token appears only once. Run the command below on the VPS now — if you lose it, generate a new one.",
            )}
          </p>
          <p className="text-xs text-neutral-400">{t("Run on the host:")}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-neutral-800/80 bg-neutral-950 p-3 font-mono text-[11px] leading-snug text-neutral-200">
            {issued.joinCommand}
          </pre>
          {issued.expiresAt && (
            <p className="text-[11px] text-neutral-500">
              {t("Expires {date}.", { date: formatDate(issued.expiresAt) })}
            </p>
          )}
          {formError && <p className="text-xs text-red-400">{formError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={copy} data-testid="copy-join-command">
              {copied ? t("Copied!") : t("Copy join command")}
            </Button>
            <Button onClick={onClose}>{t("Done")}</Button>
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
  const { t } = useT();
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
    if (
      !window.confirm(
        t(
          "Revoke this agent? The remote host will lose its connection to the control plane and can no longer be managed until you re-join it with install-agent.sh.",
        ),
      )
    ) {
      return;
    }
    setActionError(null);
    setBusyAgentId(agentId);
    try {
      await api.hosts.revokeAgent(agentId);
      await mutate();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : t("Could not revoke agent"));
    } finally {
      setBusyAgentId(null);
    }
  };
  const rotate = async (agentId: string) => {
    if (
      !window.confirm(
        t(
          "Rotate this agent's token? The current token stops working immediately — the running agent must be re-configured with the new token or the host goes offline.",
        ),
      )
    ) {
      return;
    }
    setActionError(null);
    setBusyAgentId(agentId);
    try {
      const r = await api.hosts.rotateAgentToken(agentId);
      setRotated({ agentId, token: r.agentToken });
      setCopied(false);
      await mutate();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : t("Could not rotate token"));
    } finally {
      setBusyAgentId(null);
    }
  };

  return (
    <Dialog open onClose={onClose} title={host.name} className="max-w-lg">
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={hostStatusTone(hostStatus(host))}>{hostStatus(host)}</Badge>
          {host.isSynapseHost && <Badge tone="violet">{t("this host")}</Badge>}
          <Badge tone="neutral">{host.provider}</Badge>
          {host.region && <Badge tone="neutral">{host.region}</Badge>}
        </div>
        <dl className="grid grid-cols-3 gap-y-1 text-xs">
          <Meta label={t("Public IP")} value={host.publicIp || "—"} mono />
          <Meta label={t("Private IP")} value={host.privateIp || "—"} mono />
          <Meta label={t("Agent version")} value={host.agentVersion || "—"} />
          <Meta label={t("Docker version")} value={host.dockerVersion || "—"} />
          <Meta label={t("vCPU")} value={host.cpuCores != null ? String(host.cpuCores) : "—"} />
          <Meta label={t("Memory")} value={host.memoryMb != null ? formatMb(host.memoryMb) : "—"} />
          <Meta label={t("Disk")} value={host.diskGb != null ? `${host.diskGb} GB` : "—"} />
          <Meta label={t("Last seen")} value={timeAgo(host.lastHeartbeatAt)} />
          <Meta label={t("Created")} value={formatDate(host.createdAt)} />
        </dl>
        {labelEntries.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-neutral-200">{t("Labels")}</p>
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
            {t("Agents")}
            {agents.length ? ` (${agents.length})` : ""}
          </p>
          {error instanceof ApiError && (
            <p className="text-xs text-red-400">{error.message}</p>
          )}
          {agents.length === 0 ? (
            <p className="text-[11px] text-neutral-500">
              {t("No agent has registered on this host yet. Generate an adoption token and run")}{" "}
              <code>synapse-agent join</code> {t("on the VPS.")}
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
                      <span className="text-neutral-500">{t("seen {ago}", { ago: timeAgo(a.lastSeenAt) })}</span>
                    </div>
                    {a.observed && (
                      <p className="mt-0.5 text-neutral-600">
                        {t("docker {state} · {count} managed", {
                          state: a.observed.dockerAvailable ? t("up") : t("down"),
                          count: a.observed.managedContainerCount,
                        })}
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
                        {t("Revoke")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyAgentId === a.id}
                      onClick={() => rotate(a.id)}
                    >
                      {t("Rotate")}
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
                {t("New agent token (shown once) — update the VPS config or re-run")}{" "}
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
                  {copied ? t("Copied!") : t("Copy token")}
                </Button>
              </div>
            </div>
          )}
        </div>

        <p className="rounded border border-neutral-800/80 bg-neutral-900/40 px-3 py-2 text-[11px] text-neutral-500">
          {t(
            "The agent is observe-only — live heartbeat + metrics; no apply/reconcile yet.",
          )}
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>{t("Close")}</Button>
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
  const { t } = useT();
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
      setFormError(err instanceof ApiError ? err.message : t("Could not drain host"));
      setPending(false);
    }
  };

  return (
    <Dialog open onClose={pending ? () => {} : onClose} title={t("Drain host")}>
      <div className="space-y-4">
        <p className="text-sm text-neutral-300">
          {t("Mark")}{" "}
          <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs">
            {host.name}
          </code>{" "}
          {t("as")} <Badge tone="yellow" className="align-middle">{t("draining")}</Badge>
          {t("? This is a status change only — no containers are stopped or moved.")}
        </p>
        {formError && <p className="text-xs text-red-400">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            onClick={drain}
            disabled={pending}
            data-testid="confirm-drain-host"
          >
            {pending ? t("Draining…") : t("Drain host")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/* -------------------- remove confirm -------------------- */

// RemoveHostDialog — registry-only host removal (POST /v1/hosts/{id}/delete).
// The backend refuses the self-host (cannot_remove_self_host), a host that
// still owns deployments (host_has_deployments), or one with queued
// provisioning jobs (host_has_pending_jobs) — all 409 with human-readable
// messages we surface verbatim. The destructive nature is real but narrow:
// it drops the control-plane row only. For a REMOTE host nothing on the VPS
// is touched — see the warning below.
function RemoveHostDialog({
  host,
  onClose,
  onRemoved,
}: {
  host: Host | null;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useT();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!host) {
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
      await api.hosts.delete(host.id);
      onRemoved();
      onClose();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t("Failed to remove host"));
      setPending(false);
    }
  };

  return (
    <Dialog open onClose={pending ? () => {} : onClose} title={t("Remove host")}>
      <div className="space-y-4" data-testid="remove-host-dialog">
        <p className="text-sm text-neutral-300">
          {t("Remove")}{" "}
          <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs">
            {host.name}
          </code>{" "}
          {t("from the control plane? This deletes the host record here. It does not stop or move any deployments — a host that still owns deployments or pending jobs is refused.")}
        </p>
        {host.isRemote && (
          <p className="rounded border border-yellow-900/60 bg-yellow-900/20 px-3 py-2 text-[11px] text-yellow-200">
            {t(
              "Heads up: this only clears the host from Synapse. The VPS itself is untouched — the Headscale tailnet node stays registered and the synapse-agent (its systemd unit, service user, and SSH keys) keeps running. Deregister the tailnet node and uninstall the agent on the host manually if you're decommissioning it.",
            )}
          </p>
        )}
        {formError && <p className="text-xs text-red-400">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={remove}
            disabled={pending}
            data-testid="confirm-remove-host"
          >
            {pending ? t("Removing…") : t("Remove host")}
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

/* -------------------- remote setup (one-liner) -------------------- */

// RemoteSetupDialog (v1.18+) — fetches the one-click bundle
// (adoption token + Headscale pre-auth key + pre-rendered
// install-agent.sh one-liner) the first time the modal renders, then
// shows the operator the copy-pasteable command. Both plaintext
// secrets only exist on the wire + in the DOM of the open modal;
// closing the dialog drops them.
function RemoteSetupDialog({
  host,
  onClose,
}: {
  host: Host | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const [bundle, setBundle] = useState<RemoteSetupBundle | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
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
    setErrorCode(null);
    setPending(true);
    try {
      const b = await api.hosts.remoteSetup(host.id);
      setBundle(b);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorCode(err.code ?? null);
        setFormError(err.message);
      } else {
        setFormError(t("Could not generate one-liner"));
      }
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!bundle) return;
    const ok = await copyToClipboard(bundle.oneLiner);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setFormError(t("Could not copy — select the command manually and Ctrl+C"));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={bundle ? t("Remote install for {name}", { name: host.name }) : t("Set up {name}", { name: host.name })}
    >
      <div className="space-y-4" data-testid="remote-setup-dialog">
        {!bundle && !formError && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-300">
              {t(
                "Generates a one-time bundle so a new VPS can join your tailnet AND register with Synapse in a single SSH paste. Both secrets shown next expire in 1 hour.",
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                {t("Cancel")}
              </Button>
              <Button type="button" onClick={generate} disabled={pending}>
                {pending ? t("Generating…") : t("Generate one-liner")}
              </Button>
            </div>
          </div>
        )}

        {formError && !bundle && (
          <div className="space-y-3">
            <p className="text-xs text-red-400" data-testid="remote-setup-error">
              {formError}
            </p>
            {errorCode === "remote_hosts_disabled" && (
              <p className="rounded border border-neutral-800/80 bg-neutral-900/40 px-3 py-2 text-[11px] text-neutral-400">
                {t("Configure Headscale in")}{" "}
                <Link
                  href="/admin/remote-hosts"
                  className="text-violet-300 underline-offset-2 hover:underline"
                  data-testid="hosts-panel-remote-hosts-link"
                >
                  {t("Admin → Remote Hosts")}
                </Link>{" "}
                {t("to enable this flow.")}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t("Close")}
              </Button>
              <Button onClick={generate} disabled={pending}>
                {t("Retry")}
              </Button>
            </div>
          </div>
        )}

        {bundle && (
          <div className="space-y-3" data-testid="remote-setup-result">
            <p className="rounded bg-yellow-900/40 px-3 py-2 text-xs text-yellow-200">
              {t(
                "This command appears only once. SSH into the new VPS and paste it now — if you lose it, regenerate from this host row.",
              )}
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-xs text-neutral-300">
              <li>{t("SSH into the new VPS as root (or via sudo)")}</li>
              <li>
                {t("Paste the command below — expires")}{" "}
                <span className="font-mono text-neutral-200">
                  {formatDate(bundle.expiresAt)}
                </span>
              </li>
              <li>{t("Wait ~60s; this host will flip to online here")}</li>
            </ol>
            <div className="flex items-start gap-2">
              <pre
                className="flex-1 overflow-x-auto rounded border border-neutral-800/80 bg-neutral-950 p-3 text-[11px] leading-snug text-neutral-100"
                data-testid="remote-setup-oneliner"
              >
                {bundle.oneLiner}
              </pre>
            </div>
            {formError && <p className="text-xs text-red-400">{formError}</p>}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={copy}
                data-testid="remote-setup-copy"
              >
                {copied ? t("Copied!") : t("Copy one-liner")}
              </Button>
              <Button onClick={onClose}>{t("Done")}</Button>
            </div>
            <p className="text-[11px] text-neutral-500">
              {t(
                "Tokens are single-use. If you don't paste within an hour, click “Setup remote install” again to regenerate.",
              )}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
