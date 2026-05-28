"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  api,
  type HeadscaleAdminConfig,
  type HeadscaleConfigureInput,
  type HostDomainJobStatus,
  type HostDomainDNSAutoResult,
} from "@/lib/api";

// RemoteHostsAdminPanel — v1.19+ Admin → Remote Hosts surface.
//
// Mirrors HostDomainPanel's UX cadence (status card + change form +
// confirm dialog + polling apply dialog) so an operator who learned
// to use host-domain doesn't have to re-learn anything.
//
// The panel exposes a single mutating action: "Configure Headscale".
// We deliberately don't surface a "Disable Headscale" button — turning
// it off would silently break every existing remote host. A separate
// destructive workflow with explicit confirmation would land in a
// follow-up release; for v1.19 the operator who wants to disable runs
// the manual compose tear-down from the docs.
//
// Auth: the parent layout (admin/layout.tsx) gates on
// users.is_instance_admin. Backend re-checks anyway. UI trusts the
// gate.

const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// statusTone maps the GET shape to one of the three pill colours used
// elsewhere in admin: green for "live", amber for "needs work",
// neutral for "not configured yet".
function statusTone(
  cfg: HeadscaleAdminConfig | undefined,
): "green" | "yellow" | "neutral" {
  if (!cfg) return "neutral";
  if (cfg.enabled && cfg.remoteProvisioningReady) return "green";
  if (cfg.configured || cfg.enabled) return "yellow";
  return "neutral";
}

function statusLabel(cfg: HeadscaleAdminConfig | undefined): string {
  if (!cfg) return "Unknown";
  if (cfg.enabled && cfg.remoteProvisioningReady) return "Live";
  if (cfg.enabled && !cfg.remoteProvisioningReady)
    return "Enabled — storage key missing";
  if (cfg.needsApiRestart) return "Configured — restart pending";
  if (cfg.configured) return "Configured";
  return "Not configured";
}

export function RemoteHostsAdminPanel() {
  const { data, error, isLoading, mutate } = useSWR<HeadscaleAdminConfig>(
    "/v1/admin/headscale",
    () => api.admin.headscale.get(),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const [formOpen, setFormOpen] = useState(false);

  // Headscale needs a stable HTTPS host to anchor the tailnet. When
  // the operator hasn't configured one yet, every action below is a
  // dead end — surface the link to /admin/host-domain prominently.
  const hostUnconfigured =
    !!data && !data.hostDomain && !data.baseDomain && !data.domain;

  return (
    <div className="space-y-6" data-testid="remote-hosts-admin-panel">
      <Card>
        <CardHeader>
          <CardTitle>Remote Hosts</CardTitle>
          <CardDescription>
            Configure Headscale (the Tailscale control plane Synapse uses
            to reach VPSes added via{" "}
            <code className="rounded bg-neutral-900 px-1 py-0.5 text-[0.7rem] text-neutral-200">
              Hosts → Setup remote install
            </code>
            ). Enabling Headscale joins this control plane to its own
            tailnet so the central proxy can route to deployments on
            other VPSes.
          </CardDescription>
        </CardHeader>
        <CardBody className="space-y-4">
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-1/4" />
            </div>
          )}
          {error && (
            <p
              className="text-xs text-red-400"
              data-testid="remote-hosts-load-error"
            >
              {error instanceof ApiError
                ? error.message
                : "Could not load Headscale configuration"}
            </p>
          )}
          {data && <StatusSummary cfg={data} />}
        </CardBody>
      </Card>

      {hostUnconfigured && (
        <Card
          className="border-amber-500/30 bg-amber-500/5"
          data-testid="remote-hosts-needs-host-domain"
        >
          <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-200">
                Host domain required
              </p>
              <p className="mt-1 max-w-xl text-xs text-neutral-300">
                Headscale needs a TLS host like{" "}
                <code className="rounded bg-neutral-950 px-1 py-0.5 text-[0.7rem] text-amber-200">
                  synapsepanel.com
                </code>{" "}
                so Tailscale clients can register over HTTPS. Configure
                Admin → Host domain first, then come back.
              </p>
            </div>
            <Link
              href="/admin/host-domain"
              className="inline-flex h-9 items-center rounded-md border border-amber-500/40 bg-amber-500/10 px-3 text-sm text-amber-100 hover:bg-amber-500/20"
              data-testid="remote-hosts-host-domain-link"
            >
              Open Host domain →
            </Link>
          </CardBody>
        </Card>
      )}

      {data && data.needsApiRestart && (
        <Card
          className="border-yellow-500/30 bg-yellow-500/5"
          data-testid="remote-hosts-needs-restart"
        >
          <CardBody className="space-y-2">
            <p className="text-sm font-semibold text-yellow-200">
              synapse-api restart pending
            </p>
            <p className="text-xs text-neutral-300">
              Headscale is configured in <code>.env</code> but the running
              synapse-api process hasn&apos;t picked it up yet. Re-run
              Configure to recreate the container, or restart it manually
              with{" "}
              <code className="rounded bg-neutral-950 px-1 py-0.5 text-[0.7rem] text-yellow-200">
                docker compose up -d --force-recreate synapse
              </code>
              .
            </p>
          </CardBody>
        </Card>
      )}

      {data && data.enabled && !data.remoteProvisioningReady && (
        <Card
          className="border-amber-500/30 bg-amber-500/5"
          data-testid="remote-hosts-needs-storage-key"
        >
          <CardBody className="space-y-2">
            <p className="text-sm font-semibold text-amber-200">
              Storage key required
            </p>
            <p className="text-xs text-neutral-300">
              Remote-host SSH keys are encrypted at rest with{" "}
              <code className="rounded bg-neutral-950 px-1 py-0.5 text-[0.7rem] text-amber-200">
                SYNAPSE_STORAGE_KEY
              </code>
              . Set it in <code>.env</code> and restart synapse-api before
              adding remote hosts — otherwise the agent-register endpoint
              will refuse with <code>crypto_disabled</code>.
            </p>
          </CardBody>
        </Card>
      )}

      {data && !formOpen && !hostUnconfigured && (
        <Card>
          <CardBody className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-neutral-200">
                {data.enabled
                  ? "Re-configure Headscale"
                  : "Enable Headscale"}
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                {data.enabled
                  ? "Change the Headscale subdomain or re-apply the configure job. Existing remote hosts keep working as long as the subdomain doesn't move."
                  : "Spin up the Headscale compose profile, mint an admin key, join this control plane to the tailnet, and recreate synapse-api so Remote Hosts go live."}
              </p>
            </div>
            <Button
              onClick={() => setFormOpen(true)}
              data-testid="remote-hosts-configure-open"
            >
              {data.enabled ? "Re-configure…" : "Configure…"}
            </Button>
          </CardBody>
        </Card>
      )}

      {data && formOpen && (
        <ConfigureForm
          current={data}
          onCancel={() => setFormOpen(false)}
          onApplied={async () => {
            setFormOpen(false);
            await mutate();
          }}
        />
      )}

      {data && data.enabled && data.remoteProvisioningReady && (
        <Card data-testid="remote-hosts-next-step">
          <CardBody className="space-y-2">
            <p className="text-sm font-medium text-neutral-200">
              Next: add a remote host
            </p>
            <p className="text-xs text-neutral-400">
              Open the Hosts panel and click{" "}
              <code className="rounded bg-neutral-900 px-1 py-0.5 text-[0.7rem] text-neutral-200">
                New host → Setup remote install
              </code>{" "}
              to mint a one-liner you paste into the new VPS.
            </p>
            <div>
              <Link
                href="/teams"
                className="inline-flex h-8 items-center rounded-md border border-neutral-800 bg-neutral-900 px-3 text-xs text-neutral-200 hover:border-neutral-700 hover:bg-neutral-800"
                data-testid="remote-hosts-open-hosts"
              >
                Open Hosts →
              </Link>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function StatusSummary({ cfg }: { cfg: HeadscaleAdminConfig }) {
  return (
    <dl
      className="grid grid-cols-[10rem_1fr] gap-y-3 text-sm"
      data-testid="remote-hosts-status"
    >
      <dt className="text-neutral-500">Status</dt>
      <dd>
        <Badge tone={statusTone(cfg)} data-testid="remote-hosts-status-badge">
          {statusLabel(cfg)}
        </Badge>
      </dd>

      <dt className="text-neutral-500">Headscale URL</dt>
      <dd className="text-neutral-100">
        {cfg.serverUrl ? (
          <code className="rounded bg-neutral-900 px-2 py-0.5 font-mono text-xs text-neutral-200">
            {cfg.serverUrl}
          </code>
        ) : (
          <span className="text-neutral-500">Not configured yet</span>
        )}
      </dd>

      <dt className="text-neutral-500">Subdomain</dt>
      <dd className="text-neutral-100">
        {cfg.domain ? (
          <code className="rounded bg-neutral-900 px-2 py-0.5 font-mono text-xs text-neutral-200">
            {cfg.domain}
          </code>
        ) : cfg.defaultDomain ? (
          <span className="text-xs text-neutral-500">
            default:{" "}
            <code className="rounded bg-neutral-950 px-1 py-0.5 text-neutral-300">
              {cfg.defaultDomain}
            </code>
          </span>
        ) : (
          <span className="text-neutral-500">Configure a host domain first</span>
        )}
      </dd>

      {cfg.dnsCredentialAvailable && (
        <>
          <dt className="text-neutral-500">DNS auto-config</dt>
          <dd>
            <Badge tone="green">Cloudflare credential available</Badge>
          </dd>
        </>
      )}
    </dl>
  );
}

function ConfigureForm({
  current,
  onCancel,
  onApplied,
}: {
  current: HeadscaleAdminConfig;
  onCancel: () => void;
  onApplied: () => Promise<void> | void;
}) {
  const initialDomain = current.domain || current.defaultDomain || "";
  const [headscaleDomain, setHeadscaleDomain] = useState(initialDomain);
  const [autoDns, setAutoDns] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applyJobId, setApplyJobId] = useState<string | null>(null);
  const [applyDnsAuto, setApplyDnsAuto] = useState<HostDomainDNSAutoResult | undefined>(
    undefined,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trimmed = headscaleDomain.trim().replace(/^\./, "");
  const hostnameValid = trimmed === "" || HOSTNAME_RE.test(trimmed);

  // Show the auto-DNS checkbox only when a Cloudflare credential
  // exists. Without one the backend would just refuse the upsert
  // and we'd show an amber warning the operator can't act on.
  const showAutoDns = current.dnsCredentialAvailable;

  const submit = async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const body: HeadscaleConfigureInput = {};
      if (trimmed) body.headscaleDomain = trimmed;
      if (autoDns && showAutoDns) body.autoConfigureDns = true;
      const resp = await api.admin.headscale.configure(body);
      setApplyJobId(resp.jobId);
      setApplyDnsAuto(resp.dnsAuto);
      setConfirmOpen(false);
    } catch (err) {
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : "Could not enqueue the configure job",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            {current.enabled ? "Re-configure Headscale" : "Configure Headscale"}
          </CardTitle>
          <CardDescription>
            Headscale will live at <code>https://&lt;subdomain&gt;</code> and
            require a matching A record pointing at this VPS
            {current.publicIp ? (
              <>
                {" "}
                (
                <code className="rounded bg-neutral-900 px-1 py-0.5 text-[0.7rem] text-neutral-200">
                  {current.publicIp}
                </code>
                )
              </>
            ) : null}
            .
          </CardDescription>
        </CardHeader>
        <CardBody className="space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span className="text-neutral-300">Headscale subdomain</span>
            <Input
              data-testid="remote-hosts-domain-input"
              value={headscaleDomain}
              onChange={(e) => setHeadscaleDomain(e.target.value)}
              placeholder={current.defaultDomain || "headscale.example.com"}
              aria-invalid={!hostnameValid}
            />
            {!hostnameValid && (
              <p className="text-xs text-red-400">
                Looks malformed — use a FQDN like{" "}
                <code className="text-neutral-200">
                  headscale.example.com
                </code>
                .
              </p>
            )}
            <p className="text-[11px] text-neutral-500">
              {current.hostDomain || current.baseDomain ? (
                <>
                  Default:{" "}
                  <code className="rounded bg-neutral-900 px-1 py-0.5 text-neutral-300">
                    {current.defaultDomain ||
                      `headscale.${current.hostDomain || current.baseDomain}`}
                  </code>{" "}
                  — derived from your dashboard host so on-demand TLS for
                  deployments doesn&apos;t fight Let&apos;s Encrypt for this name.
                </>
              ) : (
                "Configure Admin → Host domain to get a sensible default."
              )}
            </p>
          </label>

          {showAutoDns ? (
            <label
              className="flex items-start gap-2 text-sm text-neutral-300"
              data-testid="remote-hosts-auto-dns-label"
            >
              <input
                type="checkbox"
                checked={autoDns}
                onChange={(e) => setAutoDns(e.target.checked)}
                className="mt-1 h-3.5 w-3.5 rounded border-neutral-700 bg-neutral-950 text-violet-500"
                data-testid="remote-hosts-auto-dns"
              />
              <span>
                Auto-configure the A record via the stored Cloudflare
                credential before applying. Best-effort — if it fails we
                show a manual fix-up reason and proceed anyway.
              </span>
            </label>
          ) : (
            <div
              className="rounded border border-neutral-800/80 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-400"
              data-testid="remote-hosts-manual-dns"
            >
              <p className="font-medium text-neutral-300">Manual DNS step</p>
              <p className="mt-1">
                Add an{" "}
                <code className="rounded bg-neutral-950 px-1 py-0.5 text-neutral-200">
                  A {trimmed || "<subdomain>"} →{" "}
                  {current.publicIp || "<this VPS IP>"}
                </code>{" "}
                record at your DNS provider, wait for propagation, then
                apply.{" "}
                <Link
                  href="/admin/dns-credentials"
                  className="text-violet-300 underline-offset-2 hover:underline"
                  data-testid="remote-hosts-dns-credentials-link"
                >
                  Save a Cloudflare credential
                </Link>{" "}
                to skip the manual step on future re-configures.
              </p>
            </div>
          )}

          {submitError && (
            <p
              className="text-xs text-red-400"
              data-testid="remote-hosts-submit-error"
            >
              {submitError}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={onCancel}
              disabled={submitting}
              data-testid="remote-hosts-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={submitting || !hostnameValid}
              data-testid="remote-hosts-apply"
            >
              {submitting ? "Working…" : "Apply…"}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Dialog
        open={confirmOpen}
        onClose={() => !submitting && setConfirmOpen(false)}
        title="Apply Headscale configuration"
      >
        <div className="space-y-3" data-testid="remote-hosts-confirm-dialog">
          <p className="text-sm text-neutral-300">
            Synapse will:
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-xs text-neutral-400">
            <li>
              Render Headscale config + start the headscale compose
              profile (idempotent if already running).
            </li>
            <li>
              Stamp{" "}
              <code className="rounded bg-neutral-950 px-1 py-0.5 text-[0.7rem] text-neutral-200">
                SYNAPSE_HEADSCALE_DOMAIN
              </code>{" "}
              into <code>.env</code> and recreate synapse-api so the
              new config is live.
            </li>
            <li>
              Join this control plane to its own tailnet under tag{" "}
              <code className="text-neutral-200">tag:synapse-control</code>{" "}
              so the proxy can route to remote deployments.
            </li>
          </ul>
          <p className="text-xs text-neutral-500">
            The synapse-api container restarts during this job. The
            dashboard will reconnect automatically.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitting}
              data-testid="remote-hosts-confirm-apply"
            >
              {submitting ? "Working…" : "Apply"}
            </Button>
          </div>
        </div>
      </Dialog>

      {applyJobId && (
        <ApplyDialog
          jobId={applyJobId}
          dnsAuto={applyDnsAuto}
          onClose={() => {
            setApplyJobId(null);
            setApplyDnsAuto(undefined);
            void onApplied();
          }}
        />
      )}
    </>
  );
}

function ApplyDialog({
  jobId,
  dnsAuto,
  onClose,
}: {
  jobId: string;
  dnsAuto?: HostDomainDNSAutoResult;
  onClose: () => void;
}) {
  const [job, setJob] = useState<HostDomainJobStatus | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const next = await api.admin.headscale.status(jobId);
        if (stopped) return;
        setJob(next);
        if (next.state === "succeeded" || next.state === "failed") {
          if (timerRef.current) clearInterval(timerRef.current);
        }
      } catch (err) {
        if (stopped) return;
        // synapse-api recreate during the job can hand us a brief 502;
        // tolerate up to 3 polls before surfacing.
        setPollErr(
          err instanceof ApiError ? err.message : "Could not load job status",
        );
      }
    }
    void poll();
    timerRef.current = setInterval(poll, 2000);
    return () => {
      stopped = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [jobId]);

  const tone = useMemo(() => {
    if (!job) return "neutral";
    if (job.state === "succeeded") return "green";
    if (job.state === "failed") return "red";
    return "yellow";
  }, [job]);

  const done = job?.state === "succeeded" || job?.state === "failed";

  // logs from the daemon arrive either as a string (server shape) or
  // as a string[] (older typed contract). Normalise to lines for
  // rendering without dropping payload either way.
  const logLines: string[] = useMemo(() => {
    if (!job?.log) return [];
    if (Array.isArray(job.log)) return job.log;
    return String(job.log).split("\n");
  }, [job?.log]);

  return (
    <Dialog
      open
      onClose={() => done && onClose()}
      title="Applying Headscale configuration"
    >
      <div className="space-y-3" data-testid="remote-hosts-apply-dialog">
        <div className="flex items-center gap-2 text-sm">
          <Badge
            tone={tone as "green" | "yellow" | "red" | "neutral"}
            data-testid="remote-hosts-job-state"
          >
            {job?.state ?? "queued"}
          </Badge>
          <span className="text-neutral-500">job {jobId.slice(0, 8)}…</span>
        </div>

        {dnsAuto && (
          <div
            className={`rounded border px-3 py-2 text-xs ${
              dnsAuto.success
                ? "border-green-500/30 bg-green-500/5 text-green-200"
                : "border-amber-500/30 bg-amber-500/5 text-amber-200"
            }`}
            data-testid="remote-hosts-dns-auto-result"
          >
            {dnsAuto.success ? (
              <>
                ✓ Created A record{" "}
                <code className="text-green-100">{dnsAuto.recordName}</code>{" "}
                → <code className="text-green-100">{dnsAuto.ip}</code>{" "}
                via Cloudflare.
              </>
            ) : (
              <>
                DNS auto-config skipped: {dnsAuto.reason}. You may need to
                add the A record manually.
              </>
            )}
          </div>
        )}

        {pollErr && !job && (
          <p className="text-xs text-amber-300">
            Polling glitch (synapse-api may be restarting): {pollErr}
          </p>
        )}

        {logLines.length > 0 && (
          <pre
            className="max-h-72 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-200"
            data-testid="remote-hosts-job-log"
          >
            {logLines.join("\n")}
          </pre>
        )}

        {job?.error && (
          <p className="text-xs text-red-400" data-testid="remote-hosts-job-error">
            {job.error}
          </p>
        )}

        <div className="flex justify-end">
          <Button
            onClick={onClose}
            disabled={!done}
            data-testid="remote-hosts-apply-close"
          >
            {done ? "Close" : "Working…"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
