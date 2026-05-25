"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { BackendVersionPill } from "@/components/BackendVersionPill";
import { TopologyPanel } from "@/components/TopologyPanel";
import { ActivityFeed } from "@/components/ActivityFeed";
import { CellsPanel } from "@/components/CellsPanel";
import { CellLinksPanel } from "@/components/CellLinksPanel";
import { CellTopologyPanel } from "@/components/CellTopologyPanel";
import { HostsPanel } from "@/components/HostsPanel";
import { CliCredentialsPanel } from "@/components/CliCredentialsPanel";
import { CustomDomainsPanel } from "@/components/CustomDomainsPanel";
import { DeployKeysPanel } from "@/components/DeployKeysPanel";
import { ApiError, api, type Cell, type Deployment, type Project } from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";

type Params = { team: string; project: string };

function statusTone(status?: string): "green" | "yellow" | "red" | "neutral" {
  if (!status) return "neutral";
  const s = status.toLowerCase();
  if (s.includes("running") || s === "ready" || s === "active") return "green";
  if (s.includes("provision") || s.includes("pending") || s.includes("creat"))
    return "yellow";
  if (s.includes("fail") || s.includes("error") || s.includes("crash")) return "red";
  return "neutral";
}

// Environment-type tone. Distinct from statusTone — the two badges sit
// next to each other on every deployment card, and v1.7.2+ paints them
// with different palettes so DEV and PROD stop looking identical.
//   dev     → cyan   (calm, exploratory)
//   prod    → amber  (attention, destructive ops live here)
//   preview → violet (rare, ephemeral CI deploys)
//   *       → neutral fallback
function envTone(type?: string): "amber" | "cyan" | "violet" | "neutral" {
  switch (type) {
    case "prod":
      return "amber";
    case "dev":
      return "cyan";
    case "preview":
      return "violet";
    default:
      return "neutral";
  }
}

// Categorises the URL Synapse emitted for a deployment so the row can
// surface a tiny chip next to the URL — operators see at a glance
// which "form" they're getting and why.
//
//   custom  → operator-added domain (api.client.com): TLS via Caddy
//             catch-all, never breaks the browser.
//   wildcard → SYNAPSE_BASE_DOMAIN subdomain (foo.app.example.com):
//             TLS on-demand via Caddy, always reachable.
//   path    → /d/<name>/* proxied through synapsepanel.com:443:
//             works in the browser, but the Convex CLI host-anchors
//             URLs and strips the /d/<name> prefix → not CLI-OK.
//   host    → <host>:<dynamic-port>: the fallback Caddy doesn't
//             TLS-front. Embed page replaces the iframe with the
//             diagnostic banner (v1.7.1+).
//   unknown → empty / unparseable.
type UrlForm = "custom" | "wildcard" | "path" | "host" | "unknown";

function urlForm(rawUrl: string | undefined, publicUrl: string | undefined): UrlForm {
  if (!rawUrl) return "unknown";
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "unknown";
  }
  if (u.pathname.startsWith("/d/")) return "path";
  // Non-standard port that isn't loopback → the host:port fallback.
  const STANDARD = new Set(["", "443", "80", "6791"]);
  if (
    !STANDARD.has(u.port) &&
    u.hostname !== "localhost" &&
    u.hostname !== "127.0.0.1"
  ) {
    return "host";
  }
  // Standard port, parse-able URL: either a custom domain (different
  // root from PublicURL) or a wildcard subdomain (shares the suffix).
  // Without PublicURL to compare against we can't differentiate the
  // two, so default to "custom" — the chip still tells the operator
  // it's a domain-shaped URL, which is the actionable bit.
  if (!publicUrl) return "custom";
  try {
    const pu = new URL(publicUrl);
    if (u.hostname === pu.hostname) return "custom"; // same host, e.g. synapsepanel.com
    if (u.hostname.endsWith("." + pu.hostname)) return "wildcard";
    return "custom";
  } catch {
    return "custom";
  }
}

const URL_FORM_LABELS: Record<UrlForm, { label: string; tone: "green" | "neutral" | "yellow" | "red" }> = {
  custom: { label: "custom domain", tone: "green" },
  wildcard: { label: "wildcard", tone: "green" },
  path: { label: "path proxy", tone: "neutral" },
  host: { label: "no domain", tone: "red" },
  unknown: { label: "unknown", tone: "neutral" },
};

export default function ProjectPage({ params }: { params: Promise<Params> }) {
  const { team: teamRef, project: projectId } = use(params);
  const router = useRouter();

  const {
    data: project,
    error: projectError,
    isLoading: projectLoading,
    mutate: mutateProject,
  } = useSWR<Project>(
    ["/project", projectId],
    () => api.projects.get(projectId),
  );
  const {
    data: deployments,
    error,
    isLoading,
    mutate,
  } = useSWR<Deployment[]>(
    ["/deployments", projectId],
    () => api.projects.listDeployments(projectId),
    {
      // Poll while any deployment is mid-provisioning (or any other transient
      // state) so the UI catches up without a manual refresh. Once everything
      // is "running" or "deleted" we stop polling to keep the page idle.
      refreshInterval: (latestData) =>
        latestData?.some(
          (d) => d.status !== "running" && d.status !== "deleted",
        )
          ? 2000
          : 0,
    },
  );

  // Cells for this project — used only to badge each deployment with the
  // cell it belongs to (feat/cell-control-plane). Shares the SWR key with
  // <CellsPanel> below so it's a single fetch. shouldRetryOnError:false
  // keeps a transient failure from spinning; a miss just hides the badge.
  const { data: cells } = useSWR<Cell[]>(
    ["/cells", projectId],
    () => api.cells.listByProject(projectId),
    { shouldRetryOnError: false },
  );
  const cellByDeploymentId = new Map<string, Cell>();
  for (const c of cells ?? []) {
    if (c.primaryDeploymentId) cellByDeploymentId.set(c.primaryDeploymentId, c);
  }

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"dev" | "prod">("dev");
  // HA mode. Off by default — single-replica deployments are the common
  // path. When the backend has SYNAPSE_HA_ENABLED=false (most clusters),
  // submitting with this on returns 400 ha_disabled which we surface
  // inline instead of crashing the dialog.
  const [haMode, setHAMode] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [openingName, setOpeningName] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Adopt-existing modal state. Kept separate from the create-deployment
  // state because the two forms have different fields and we don't want a
  // submit on one to leak the other's "pending" spinner.
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [adoptUrl, setAdoptUrl] = useState("");
  const [adoptAdminKey, setAdoptAdminKey] = useState("");
  const [adoptType, setAdoptType] = useState<"dev" | "prod">("prod");
  const [adoptName, setAdoptName] = useState("");
  const [adoptPending, setAdoptPending] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setPending(true);
    try {
      await api.projects.createDeployment(projectId, {
        type,
        ha: haMode || undefined,
      });
      setOpen(false);
      setHAMode(false);
      // v1.9.7: the topology panel below uses its own SWR key, so the
      // deployments-list mutate() above doesn't invalidate it. Force a
      // refetch by signalling the global cache — the panel re-renders
      // with the new deployment instantly instead of waiting for its
      // next poll tick.
      // v1.10.0: invalidate topology + activity feed alongside the
// deployments-list mutate so all three panels reflect the new
// state in the same paint frame.
await Promise.all([
  mutate(),
  globalMutate(["/topology", projectId]),
  globalMutate(["/activity", projectId]),
]);
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not create deployment"
      );
    } finally {
      setPending(false);
    }
  };

  const adopt = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdoptError(null);
    setAdoptPending(true);
    try {
      await api.projects.adoptDeployment(projectId, {
        deploymentUrl: adoptUrl.trim(),
        adminKey: adoptAdminKey.trim(),
        deploymentType: adoptType,
        name: adoptName.trim() || undefined,
      });
      setAdoptOpen(false);
      setAdoptUrl("");
      setAdoptAdminKey("");
      setAdoptName("");
      setAdoptType("prod");
      // v1.10.0: invalidate topology + activity feed alongside the
// deployments-list mutate so all three panels reflect the new
// state in the same paint frame.
await Promise.all([
  mutate(),
  globalMutate(["/topology", projectId]),
  globalMutate(["/activity", projectId]),
]);
    } catch (err) {
      setAdoptError(
        err instanceof ApiError ? err.message : "Could not adopt deployment"
      );
    } finally {
      setAdoptPending(false);
    }
  };

  const openDashboard = (name: string) => {
    // Open a Synapse-hosted embed shell that iframes the open-source
    // Convex Dashboard and answers its postMessage handshake with
    // adminKey + deploymentUrl. The handshake protocol is the only
    // way to auto-login the dashboard without a rebuild — the URL
    // hash format we tried before (`#deploymentName=...`) is silently
    // ignored by the self-hosted build (verified against the source
    // in get-convex/convex-backend's `npm-packages/dashboard-self-hosted/`).
    window.open(
      `/embed/${encodeURIComponent(name)}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [copiedName, setCopiedName] = useState<string | null>(null);

  // v1.9.4: renameOpen/transferOpen/deletingProject state + their
  // handlers (submitRename, submitTransfer, deleteProject) and the
  // myTeams/currentTeam SWRs moved to ProjectGeneralPanel (mounted
  // under /settings/general). Removing them here keeps the project
  // home file focused on its primary view (deployments).

  const copyUrl = async (name: string, url: string) => {
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopiedName(name);
      // Clear the "Copied!" label after a beat — long enough to be noticed,
      // short enough that re-clicking feels responsive.
      setTimeout(() => {
        setCopiedName((current) => (current === name ? null : current));
      }, 1500);
    } else {
      setActionError("Could not copy URL — select it manually and Ctrl+C");
    }
  };

  // v1.9.4: submitRename / submitTransfer / deleteProject moved to
  // ProjectGeneralPanel. The handlers needed nothing the project home
  // still uses (project SWR is duplicated cleanly via the same key).

  // v1.7.2+: replaces the native confirm() — UI lives in the typed
  // ConfirmDeleteDeploymentDialog below. PROD deployments require the
  // operator to type the deployment name (GitHub-repo-delete pattern)
  // because container removal + data-volume wipe is irreversible.
  // DEV / PREVIEW / CUSTOM keep a single-click confirmation.
  const [pendingDelete, setPendingDelete] = useState<Deployment | null>(null);
  const confirmDelete = async (name: string) => {
    setActionError(null);
    setDeletingName(name);
    try {
      await api.deployments.delete(name);
      // v1.10.0: invalidate topology + activity feed alongside the
// deployments-list mutate so all three panels reflect the new
// state in the same paint frame.
await Promise.all([
  mutate(),
  globalMutate(["/topology", projectId]),
  globalMutate(["/activity", projectId]),
]);
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : "Could not delete deployment"
      );
      // Re-throw so the dialog stays open on failure — operator can see
      // the error in the page-level banner and retry without re-typing.
      throw err;
    } finally {
      setDeletingName(null);
    }
  };

  // Top-of-component gate: when the project itself can't be loaded
  // because it doesn't exist (404) or the operator lost access (403),
  // render a single EmptyState INSTEAD of the full chrome + panels.
  // Without this every child panel would fire its own fetch and cascade
  // 5+ "Failed to load X: Project not found" red banners — see
  // docs/V1_8_1_STALE_LINK_FIXES.md Bug 2. Loading state needs to
  // differentiate "first paint" from "have stale data, revalidating",
  // hence the `&& !project` guard on isLoading.
  if (projectLoading && !project) {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-6 w-80" />
        </div>
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardBody className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="mt-2 h-3 w-2/3" />
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    );
  }
  if (
    projectError instanceof ApiError &&
    (projectError.status === 404 || projectError.status === 403)
  ) {
    // Single copy for 404 + 403. Backend returns 403 to non-members or
    // 404 for info-hiding; either way the operator's next step is the
    // same: go back to projects.
    return (
      <EmptyState
        title="Project unavailable"
        description="This project doesn't exist or you don't have access."
        testId="project-unavailable"
        action={
          <Link
            href={`/teams/${encodeURIComponent(teamRef)}`}
            className="text-sm text-cyan-400 hover:text-cyan-300"
          >
            ← Back to projects
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <nav className="text-xs text-neutral-500">
          <Link href="/teams" className="hover:text-neutral-300">
            Teams
          </Link>{" "}
          /{" "}
          <Link
            href={`/teams/${encodeURIComponent(teamRef)}`}
            className="hover:text-neutral-300"
          >
            {teamRef}
          </Link>{" "}
          / <span className="text-neutral-300">{project?.name ?? projectId}</span>
        </nav>
        <div className="mt-3 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">{project?.name ?? "Project"}</h1>
            <p className="text-xs text-neutral-400">
              Deployments are real Convex backend containers.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setOpen(true)}>New deployment</Button>
            <Button
              variant="secondary"
              onClick={() => setAdoptOpen(true)}
              aria-label="Adopt existing deployment"
            >
              Adopt existing
            </Button>
            {/*
              v1.9.4: the project home no longer owns destructive
              actions. Rename / Transfer / Delete live under
              /settings/general so a mis-click on the high-traffic
              page can't accidentally rename a prod project. Settings
              link below opens /general (which lands the operator
              on those exact actions).
            */}
            <Link
              href={`/teams/${encodeURIComponent(teamRef)}/${encodeURIComponent(projectId)}/settings/general`}
              data-testid="project-settings-link"
            >
              <Button variant="secondary" aria-label="Project settings">
                Settings
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {actionError && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {actionError}
        </p>
      )}

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <CardBody className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="mt-2 h-3 w-2/3" />
                </div>
                <div className="flex shrink-0 gap-2">
                  <Skeleton className="h-8 w-28" />
                  <Skeleton className="h-8 w-16" />
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      {error && (
        <p className="text-sm text-red-400">
          Failed to load deployments: {(error as Error).message}
        </p>
      )}

      {deployments && deployments.length === 0 && (
        <Card>
          <CardBody className="text-center">
            <p className="text-sm text-neutral-300">No deployments yet.</p>
            <p className="mt-1 text-xs text-neutral-500">
              Provision a dev or prod backend to start running functions.
            </p>
            <Button className="mt-4" onClick={() => setOpen(true)}>
              Create deployment
            </Button>
          </CardBody>
        </Card>
      )}

      {deployments && deployments.length > 0 && (
        <div className="space-y-3">
          {deployments.map((d) => {
            const dtype = d.deploymentType ?? d.type;
            const isProd = dtype === "prod";
            return (
              <Card
                key={d.name}
                // v1.7.2+: prod cards get a subtle amber accent on the
                // left edge + faint background tint so they're
                // scannable as "the dangerous one" in a vertical list
                // of deployments. Dev / preview cards stay neutral.
                // The right side keeps the standard border so the
                // shape doesn't feel lopsided.
                className={clsx(
                  isProd &&
                    "border-l-[3px] border-l-amber-500/60 bg-amber-500/[0.025]",
                )}
              >
                <CardBody className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-neutral-100">
                        {d.name}
                      </p>
                      {dtype && <Badge tone={envTone(dtype)}>{dtype}</Badge>}
                      {d.status && (
                        <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                      )}
                      {d.isDefault && <Badge tone="neutral">default</Badge>}
                      {d.adopted && <Badge tone="neutral">adopted</Badge>}
                      {d.haEnabled && (
                        <Badge tone="green">
                          HA{d.replicaCount ? ` ×${d.replicaCount}` : ""}
                        </Badge>
                      )}
                      {d.id && cellByDeploymentId.has(d.id) && (
                        <Badge
                          tone="violet"
                          title="Cell this deployment belongs to"
                        >
                          Cell: {cellByDeploymentId.get(d.id)!.name}
                        </Badge>
                      )}
                    </div>
                    {(d.deploymentUrl || d.url) && (
                      <div className="mt-1 space-y-0.5">
                        <div className="flex items-center gap-2">
                          {/* v1.9.1: matches Convex Cloud's "Cloud URL"
                              terminology. Without the label operators
                              read the URL as "the dashboard URL", but
                              that's /embed/<name> — visiting this URL in
                              a browser actually shows the bare
                              "This Convex deployment is running" page
                              from the upstream backend. */}
                          <span
                            className="text-[10px] font-medium uppercase tracking-wider text-neutral-600"
                            title="Equivalent to Convex Cloud's CONVEX_CLOUD_URL — your app's CONVEX_SELF_HOSTED_URL points here."
                          >
                            Cloud URL
                          </span>
                          <p className="truncate text-xs text-neutral-500">
                            {d.deploymentUrl || d.url}
                          </p>
                          {(() => {
                            const form = urlForm(
                              d.deploymentUrl || d.url,
                              typeof window !== "undefined"
                                ? window.location.origin
                                : undefined,
                            );
                            const meta = URL_FORM_LABELS[form];
                            return (
                              <Badge
                                tone={meta.tone}
                                className="shrink-0 normal-case tracking-normal"
                                title={
                                  form === "host"
                                    ? "Caddy doesn't TLS-front dynamic ports — the iframe will replace itself with a diagnostic banner. Add a custom domain or set SYNAPSE_BASE_DOMAIN to fix."
                                    : form === "path"
                                      ? "Works in the browser but the Convex CLI strips paths from base URLs — not ideal for `npx convex` invocations."
                                      : `URL form: ${meta.label}`
                                }
                              >
                                {meta.label}
                              </Badge>
                            );
                          })()}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              copyUrl(d.name, (d.deploymentUrl || d.url) as string)
                            }
                            aria-label="Copy Cloud URL"
                          >
                            {copiedName === d.name ? "Copied!" : "Copy"}
                          </Button>
                        </div>
                        {/* Honesty note: in Convex Cloud the "HTTP
                            Actions URL" is a separate domain
                            (`<name>.convex.site`); in self-hosted the
                            same container serves both surfaces, so they
                            share the URL. Tiny hint avoids confusion
                            when an operator coming from Cloud reads
                            our deployment card. */}
                        <p className="text-[10px] text-neutral-600">
                          HTTP Actions URL: same as Cloud URL in self-hosted.
                        </p>
                      </div>
                    )}
                    {d.status === "running" && (
                      <div className="mt-2">
                        <BackendVersionPill deploymentName={d.name} />
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openDashboard(d.name)}
                      disabled={openingName === d.name}
                    >
                      {openingName === d.name ? "Opening..." : "Open dashboard"}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setPendingDelete(d)}
                      disabled={deletingName === d.name}
                      aria-label={`Delete deployment ${d.name}`}
                    >
                      {deletingName === d.name ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </CardBody>
                <div className="space-y-2 border-t border-neutral-900 px-5 py-3">
                  <CliCredentialsPanel deploymentName={d.name} />
                  <DeployKeysPanel deploymentName={d.name} />
                  <CustomDomainsPanel deploymentName={d.name} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/*
        v1.9.3: env vars, DNS credentials, project members, and access
        tokens used to live below the deployments list on this same
        page — five stacked surfaces that pushed the operator's primary
        view (their deployments) below the fold. They've been moved
        into /teams/<team>/<project>/settings/* with a sidebar nav.
        The Rename/Transfer/Delete project actions still live in the
        header above; a follow-up will move them into /settings/general.

        v1.9.6: the Topology panel shows deployments grouped by host
        (with IP-derived geo metadata) — fills the same space that
        used to scroll forever with stacked settings panels.
      */}
      {/*
        Cell Control Plane (feat/cell-control-plane, Bloco 4). Cells are
        project-scoped operational units; Hosts are the machines they run
        on. Both render as self-contained sections (own SWR) below the
        deployments list. HostsPanel hides itself for non-instance-admins.
      */}
      <CellsPanel projectId={projectId} />
      <CellLinksPanel projectId={projectId} />
      <HostsPanel />

      {/*
        Bloco 8: the real Host→Cell→Deployment topology. Renders only when the
        project has cells (mode=cell_control_plane); otherwise it hides and the
        legacy synthetic TopologyPanel below covers the no-cells case.
      */}
      <CellTopologyPanel projectId={projectId} />

      <TopologyPanel projectId={projectId} />

      {/*
        v1.10.0: project-scoped activity feed. Renders below Topology
        with a timeline view of recent audit_events touching this
        project. Hides itself when there are no events (avoids
        flashing an empty section on fresh projects).
      */}
      <ActivityFeed projectId={projectId} />

      <Dialog open={open} onClose={() => setOpen(false)} title="Create deployment">
        <form onSubmit={create} className="space-y-4">
          <div className="space-y-2">
            <label className="block text-xs text-neutral-400">Type</label>
            <div className="flex gap-2">
              {(["dev", "prod"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`h-9 flex-1 rounded-md border text-sm transition-colors ${
                    type === t
                      ? "border-neutral-300 bg-neutral-800 text-neutral-100"
                      : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <p className="text-xs text-neutral-500">
              Provisions a Convex backend container.
            </p>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              <input
                id="create-ha-toggle"
                type="checkbox"
                checked={haMode}
                onChange={(e) => setHAMode(e.target.checked)}
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-violet-500 focus:ring-violet-500"
              />
              <span>High availability (2 replicas + Postgres + S3)</span>
            </label>
            {haMode && (
              <p className="text-xs text-neutral-500">
                Requires <code className="text-neutral-300">SYNAPSE_HA_ENABLED=true</code> on
                the cluster plus <code className="text-neutral-300">SYNAPSE_BACKEND_*</code>
                {" "}credentials. See <code className="text-neutral-300">docs/V0_5_PLAN.md</code>.
              </p>
            )}
          </div>
          {formError && <p className="text-xs text-red-400">{formError}</p>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={adoptOpen}
        onClose={() => setAdoptOpen(false)}
        title="Adopt existing deployment"
      >
        <form onSubmit={adopt} className="space-y-4">
          <p className="text-xs text-neutral-400">
            Register a Convex backend that&apos;s already running outside Synapse.
            Synapse stores the URL + admin key and skips Docker for delete /
            health on this row — the backend stays under your control.
          </p>
          <div className="space-y-2">
            <label htmlFor="adopt-url" className="block text-xs text-neutral-400">
              Deployment URL
            </label>
            <Input
              id="adopt-url"
              value={adoptUrl}
              onChange={(e) => setAdoptUrl(e.target.value)}
              placeholder="https://convex.example.com:3210"
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="adopt-admin-key" className="block text-xs text-neutral-400">
              Admin key
            </label>
            <Input
              id="adopt-admin-key"
              type="password"
              value={adoptAdminKey}
              onChange={(e) => setAdoptAdminKey(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-neutral-400">Type</label>
            <div className="flex gap-2">
              {(["dev", "prod"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAdoptType(t)}
                  className={`h-9 flex-1 rounded-md border text-sm transition-colors ${
                    adoptType === t
                      ? "border-neutral-300 bg-neutral-800 text-neutral-100"
                      : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="adopt-name" className="block text-xs text-neutral-400">
              Name <span className="text-neutral-600">(optional — auto-allocated if blank)</span>
            </label>
            <Input
              id="adopt-name"
              value={adoptName}
              onChange={(e) => setAdoptName(e.target.value)}
              placeholder="my-existing-app"
            />
          </div>
          {adoptError && <p className="text-xs text-red-400">{adoptError}</p>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAdoptOpen(false)}
              disabled={adoptPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={adoptPending || !adoptUrl.trim() || !adoptAdminKey.trim()}>
              {adoptPending ? "Verifying…" : "Adopt"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Rename/Transfer/Delete project dialogs moved to /settings/general
          in v1.9.4 (inline forms inside ProjectGeneralPanel). */}

      <ConfirmDeleteDeploymentDialog
        key={pendingDelete?.name ?? "closed"}
        deployment={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          await confirmDelete(pendingDelete.name);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

// v1.7.2+: replaces the browser-native confirm() for deployment deletion.
//
// - DEV / PREVIEW / CUSTOM: single confirmation button. Same one-click
//   feel as before, but in our own styled dialog so the experience
//   matches the rest of the dashboard (and so we can later add per-
//   environment richer content without forking again).
// - PROD: GitHub-style typed-name confirmation. The operator MUST type
//   the deployment name verbatim — the action button stays disabled
//   until the input matches. Container removal + data volume wipe
//   is irreversible, so the extra second of friction is worth it.
//
// The dialog re-mounts (via `key` on the caller) every time
// `pendingDelete` changes, so internal state (typed input, error
// banner) resets between deployments without an in-component effect.
function ConfirmDeleteDeploymentDialog({
  deployment,
  onClose,
  onConfirm,
}: {
  deployment: Deployment | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const open = deployment !== null;
  const type = deployment?.deploymentType ?? deployment?.type;
  const isProd = type === "prod";
  const canSubmit = isProd
    ? typed === (deployment?.name ?? "") && !pending
    : !pending;

  const submit = async () => {
    setPending(true);
    setErr(null);
    try {
      await onConfirm();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not delete deployment");
      setPending(false);
    }
  };

  if (!deployment) {
    return (
      <Dialog open={false} onClose={onClose}>
        <></>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={pending ? () => {} : onClose}
      title={isProd ? "Delete production deployment" : "Delete deployment"}
    >
      <div className="space-y-4">
        <p className="text-sm text-neutral-300">
          {isProd ? (
            <>
              You&apos;re about to permanently delete{" "}
              <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs text-amber-300">
                {deployment.name}
              </code>
              . The container is removed, the data volume is wiped, and any
              client pointing at this URL stops working.{" "}
              <strong className="text-amber-300">This cannot be undone.</strong>
            </>
          ) : (
            <>
              Delete the{" "}
              <Badge tone={envTone(type)} className="align-middle">
                {type}
              </Badge>{" "}
              deployment{" "}
              <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs">
                {deployment.name}
              </code>
              ? The container and its data volume are removed.
            </>
          )}
        </p>

        {isProd && (
          <div className="space-y-2">
            <label
              htmlFor="confirm-delete-name"
              className="block text-xs text-neutral-400"
            >
              Type{" "}
              <code className="font-mono text-amber-300">{deployment.name}</code>{" "}
              to confirm
            </label>
            <Input
              id="confirm-delete-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={deployment.name}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              aria-invalid={
                typed.length > 0 && typed !== deployment.name ? true : undefined
              }
            />
          </div>
        )}

        {err && <p className="text-xs text-red-400">{err}</p>}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={!canSubmit}
            onClick={submit}
            data-testid="confirm-delete-deployment"
          >
            {pending ? "Deleting…" : isProd ? "Delete production" : "Delete"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
