"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { IconLink } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  api,
  type Cell,
  type CellLink,
  type ServiceToken,
} from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";

type Props = { projectId: string };

const PROTOCOLS = ["outbox", "http", "convex_action", "webhook", "polling"];
const AUTH_MODES = ["service_token", "mtls", "none"];

// CellLinksPanel (Bloco 7) — the service-to-service contract layer between
// Cells. Renders as a self-contained section below the Hosts panel. Shows
// links (source → target, protocol, allowed command/event counts, token
// count) and lets operators create links, disable them, and mint/revoke
// service tokens. No secret is ever shown except the one-time token.
export function CellLinksPanel({ projectId }: Props) {
  const links = useSWR<CellLink[]>(["/cell-links", projectId], () =>
    api.cellLinks.listByProject(projectId),
  );
  // Shared cache with CellsPanel / the project page (same key).
  const cells = useSWR<Cell[]>(["/cells", projectId], () =>
    api.cells.listByProject(projectId),
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [tokensLink, setTokensLink] = useState<CellLink | null>(null);
  const [disableLink, setDisableLink] = useState<CellLink | null>(null);

  const cellNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cells.data ?? []) m.set(c.id, c.name);
    return m;
  }, [cells.data]);
  const name = (id: string) => cellNameById.get(id) ?? id.slice(0, 8);

  const list = links.data ?? [];
  const hasCells = (cells.data ?? []).length >= 2;

  return (
    <Card className="overflow-hidden" data-testid="cell-links-panel">
      <div className="flex items-center justify-between border-b border-neutral-800/80 px-5 py-3.5">
        <div className="flex items-baseline gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
            <IconLink className="opacity-70" />
            Cell Links
          </h3>
          <span className="text-xs text-neutral-500">
            — service-to-service contracts between cells
          </span>
        </div>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          disabled={!hasCells}
          title={hasCells ? undefined : "Create at least two cells first"}
          data-testid="create-cell-link-button"
        >
          + Create link
        </Button>
      </div>

      <div className="p-5">
        {links.error instanceof ApiError && (
          <p className="text-xs text-red-400">
            Failed to load cell links: {links.error.message}
          </p>
        )}

        {links.isLoading && !links.data && <Skeleton className="h-16 w-full" />}

        {links.data && list.length === 0 && (
          <EmptyState
            title="No cell links yet"
            description="A cell link is a contract that lets one cell talk to another (e.g. core → runtime) over a protocol, with an allow-list of commands and events. Create two cells, then link them."
            testId="cell-links-empty"
            action={
              hasCells ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Create link
                </Button>
              ) : undefined
            }
          />
        )}

        {list.length > 0 && (
          <div className="overflow-hidden rounded-md border border-neutral-800/80" data-testid="cell-links-table">
            <table className="w-full text-xs">
              <thead className="bg-neutral-950 text-neutral-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Source → Target</th>
                  <th className="px-3 py-2 text-left font-medium">Protocol</th>
                  <th className="px-3 py-2 text-left font-medium">Auth</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Cmds</th>
                  <th className="px-3 py-2 text-right font-medium">Events</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-900">
                {list.map((l) => (
                  <tr key={l.id} className="text-neutral-200" data-testid="cell-link-row">
                    <td className="px-3 py-2 font-mono">
                      {name(l.sourceCellId)} <span className="text-neutral-600">→</span>{" "}
                      {name(l.targetCellId)}
                    </td>
                    <td className="px-3 py-2">{l.protocol}</td>
                    <td className="px-3 py-2 text-neutral-400">{l.authMode}</td>
                    <td className="px-3 py-2">
                      <Badge tone={l.status === "active" ? "green" : "neutral"}>
                        {l.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-400">{l.allowedCommands.length}</td>
                    <td className="px-3 py-2 text-right text-neutral-400">{l.allowedEvents.length}</td>
                    <td className="px-3 py-2 text-right text-neutral-400">{l.serviceTokenCount}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setTokensLink(l)}>
                          Tokens
                        </Button>
                        {l.status === "active" && (
                          <Button variant="ghost" size="sm" onClick={() => setDisableLink(l)}>
                            Disable
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateLinkDialog
        key={String(createOpen)}
        open={createOpen}
        projectId={projectId}
        cells={cells.data ?? []}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void links.mutate()}
      />
      <TokensDialog
        key={tokensLink?.id ?? "tokens-closed"}
        link={tokensLink}
        sourceName={tokensLink ? name(tokensLink.sourceCellId) : ""}
        targetName={tokensLink ? name(tokensLink.targetCellId) : ""}
        onClose={() => setTokensLink(null)}
        onChanged={() => void links.mutate()}
      />
      <DisableLinkDialog
        link={disableLink}
        sourceName={disableLink ? name(disableLink.sourceCellId) : ""}
        targetName={disableLink ? name(disableLink.targetCellId) : ""}
        onClose={() => setDisableLink(null)}
        onDisabled={() => void links.mutate()}
      />
    </Card>
  );
}

/* -------------------- create link -------------------- */

function CreateLinkDialog({
  open,
  projectId,
  cells,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  cells: Cell[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [sourceCellId, setSourceCellId] = useState(cells[0]?.id ?? "");
  const [targetCellId, setTargetCellId] = useState(cells[1]?.id ?? "");
  const [protocol, setProtocol] = useState("outbox");
  const [authMode, setAuthMode] = useState("service_token");
  const [commands, setCommands] = useState("");
  const [events, setEvents] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (sourceCellId === targetCellId) {
      setFormError("Source and target must be different cells");
      return;
    }
    setPending(true);
    try {
      await api.cellLinks.create(projectId, {
        sourceCellId,
        targetCellId,
        protocol,
        authMode,
        allowedCommands: splitLines(commands),
        allowedEvents: splitLines(events),
      });
      onCreated();
      onClose();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not create link");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Create cell link" className="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <CellSelect label="Source cell" id="link-source" value={sourceCellId} onChange={setSourceCellId} cells={cells} />
          <CellSelect label="Target cell" id="link-target" value={targetCellId} onChange={setTargetCellId} cells={cells} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <PlainSelect label="Protocol" id="link-protocol" value={protocol} onChange={setProtocol} options={PROTOCOLS} />
          <PlainSelect label="Auth mode" id="link-auth" value={authMode} onChange={setAuthMode} options={AUTH_MODES} />
        </div>
        <div className="space-y-2">
          <label htmlFor="link-commands" className="block text-xs text-neutral-400">
            Allowed commands <span className="text-neutral-600">(one per line)</span>
          </label>
          <textarea
            id="link-commands"
            value={commands}
            onChange={(e) => setCommands(e.target.value)}
            rows={3}
            placeholder={"runtime.runAutomation\nruntime.cancelRun"}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="link-events" className="block text-xs text-neutral-400">
            Allowed events <span className="text-neutral-600">(one per line)</span>
          </label>
          <textarea
            id="link-events"
            value={events}
            onChange={(e) => setEvents(e.target.value)}
            rows={3}
            placeholder={"runtime.runStarted\nruntime.runCompleted\nruntime.runFailed"}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
          />
        </div>
        {formError && <p className="text-xs text-red-400">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !sourceCellId || !targetCellId}>
            {pending ? "Creating…" : "Create link"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CellSelect({
  label,
  id,
  value,
  onChange,
  cells,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (v: string) => void;
  cells: Cell[];
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
        {cells.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.kind})
          </option>
        ))}
      </select>
    </div>
  );
}

function PlainSelect({
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

/* -------------------- tokens dialog -------------------- */

function TokensDialog({
  link,
  sourceName,
  targetName,
  onClose,
  onChanged,
}: {
  link: CellLink | null;
  sourceName: string;
  targetName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, error, isLoading, mutate } = useSWR<ServiceToken[]>(
    link ? ["/service-tokens", link.id] : null,
    () => api.cellLinks.listTokens(link!.id),
    { revalidateOnFocus: false },
  );
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!link) {
    return (
      <Dialog open={false} onClose={onClose}>
        <></>
      </Dialog>
    );
  }
  const tokens = data ?? [];

  const create = async () => {
    setActionError(null);
    setPending(true);
    try {
      const tok = await api.cellLinks.createToken(link.id, { name: name.trim() || undefined });
      setIssued(tok.token ?? null);
      setCopied(false);
      setName("");
      await mutate();
      onChanged();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Could not create token");
    } finally {
      setPending(false);
    }
  };
  const revoke = async (id: string) => {
    setActionError(null);
    setBusyId(id);
    try {
      await api.cellLinks.revokeToken(id);
      await mutate();
      onChanged();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Could not revoke token");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Service tokens" className="max-w-lg">
      <div className="space-y-4 text-sm">
        <p className="text-xs text-neutral-400">
          For link{" "}
          <span className="font-mono text-neutral-300">
            {sourceName} → {targetName}
          </span>
          . A token authenticates the source cell at the discovery endpoint. The
          plaintext is shown once.
        </p>

        {issued && (
          <div className="space-y-1 rounded border border-yellow-900/60 bg-yellow-900/20 px-2.5 py-2">
            <p className="text-[11px] text-yellow-200">
              New service token (shown once) — store it now:
            </p>
            <pre className="overflow-x-auto break-all rounded bg-neutral-950 p-2 font-mono text-[11px] text-neutral-200">
              {issued}
            </pre>
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (await copyToClipboard(issued)) {
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

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label htmlFor="token-name" className="block text-xs text-neutral-400">
              New token name <span className="text-neutral-600">(optional)</span>
            </label>
            <Input
              id="token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="core→runtime"
            />
          </div>
          <Button onClick={create} disabled={pending} data-testid="generate-service-token">
            {pending ? "Generating…" : "Generate"}
          </Button>
        </div>

        {error instanceof ApiError && <p className="text-xs text-red-400">{error.message}</p>}
        {actionError && <p className="text-xs text-red-400">{actionError}</p>}

        {isLoading ? (
          <p className="text-xs text-neutral-500">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-neutral-500">No service tokens yet.</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-neutral-800/80">
            <table className="w-full text-[11px]">
              <thead className="bg-neutral-950 text-neutral-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Last used</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-900">
                {tokens.map((t) => (
                  <tr key={t.id} className="text-neutral-200">
                    <td className="px-3 py-2">{t.name || "—"}</td>
                    <td className="px-3 py-2">
                      <Badge tone={t.status === "active" ? "green" : "red"}>{t.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-neutral-500">
                      {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {t.status === "active" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === t.id}
                          onClick={() => revoke(t.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}

/* -------------------- disable confirm -------------------- */

function DisableLinkDialog({
  link,
  sourceName,
  targetName,
  onClose,
  onDisabled,
}: {
  link: CellLink | null;
  sourceName: string;
  targetName: string;
  onClose: () => void;
  onDisabled: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!link) {
    return (
      <Dialog open={false} onClose={onClose}>
        <></>
      </Dialog>
    );
  }

  const disable = async () => {
    setFormError(null);
    setPending(true);
    try {
      await api.cellLinks.disable(link.id);
      onDisabled();
      onClose();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : "Could not disable link");
      setPending(false);
    }
  };

  return (
    <Dialog open onClose={pending ? () => {} : onClose} title="Disable cell link">
      <div className="space-y-4">
        <p className="text-sm text-neutral-300">
          Disable the link{" "}
          <span className="font-mono">
            {sourceName} → {targetName}
          </span>
          ? Existing service tokens stop appearing in discovery for this link.
          You can create a fresh active link afterwards.
        </p>
        {formError && <p className="text-xs text-red-400">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={disable} disabled={pending} data-testid="confirm-disable-link">
            {pending ? "Disabling…" : "Disable link"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}
