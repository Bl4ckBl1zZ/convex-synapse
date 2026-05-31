"use client";

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
  type DNSCredential,
  type HostDomainChangeInput,
  type HostDomainConfig,
  type HostDomainDNSAutoResult,
  type HostDomainJobStatus,
} from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";

// HostDomainPanel — instance-admin-only surface for swapping the public
// domain of a running Synapse host. Pairs with backend PR B
// (/v1/admin/host_domain) and installer PR A (setup.sh --change-domain).
//
// Three configuration modes the operator can pick:
//   - tls               : single domain, HTTPS via Caddy + Let's Encrypt
//   - tls_with_wildcard : same + a wildcard base for per-deployment subs
//   - plain             : raw IP, no domain, no TLS
//
// The panel wraps the apply path in two modals — a confirm step (so a
// stray click doesn't take the dashboard offline) and an apply step
// that polls the host-side daemon's job status, tails its log, and
// auto-redirects to the new URL once /install_status responds 200.
//
// IMPORTANT: rendering this panel is gated outside of the component
// itself (the parent reads is_instance_admin). The UI here trusts that
// gate; the backend re-checks anyway.

const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// Lax email check — backend re-validates. We just want to short-circuit
// the obvious typos before round-tripping.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Mode = "tls" | "tls_with_wildcard" | "plain";

function modeLabel(mode: HostDomainConfig["mode"]): string {
  switch (mode) {
    case "tls":
      return "HTTPS";
    case "tls_with_wildcard":
      return "HTTPS + wildcard";
    case "plain":
      return "Plain HTTP";
    default:
      return mode;
  }
}

function modeTone(
  mode: HostDomainConfig["mode"],
): "green" | "yellow" | "neutral" {
  if (mode === "tls" || mode === "tls_with_wildcard") return "green";
  if (mode === "plain") return "yellow";
  return "neutral";
}

export function HostDomainPanel() {
  const { t } = useT();
  const { data, error, isLoading, mutate } = useSWR<HostDomainConfig>(
    "/v1/admin/host_domain",
    () => api.admin.hostDomain.get(),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const [formOpen, setFormOpen] = useState(false);
  const [formInitialMode, setFormInitialMode] = useState<Mode | undefined>(undefined);

  return (
    <div className="space-y-6" data-testid="host-domain-panel">
      <Card>
        <CardHeader>
          <CardTitle>{t("Public host configuration")}</CardTitle>
          <CardDescription>
            {t(
              "How operators and Convex CLIs reach this Synapse host. Changing this re-renders Caddy and restarts the front door.",
            )}
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
            <p className="text-xs text-red-400" data-testid="host-domain-load-error">
              {error instanceof ApiError
                ? error.message
                : t("Could not load host configuration")}
            </p>
          )}
          {data && <CurrentConfig config={data} />}
        </CardBody>
      </Card>

      {/*
        v1.9.0: prominent suggestion when the host is on plain `tls` mode.
        Without this most operators don't realize the "Change..." panel
        can ALSO enable wildcard subdomain — they only discover it after
        a frustrating SSH session. Skipping when mode is already
        `tls_with_wildcard` (no upgrade needed) or `plain` (different
        problem entirely; suggesting wildcard would be confusing).
      */}
      {data && data.mode === "tls" && !formOpen && (
        <Card
          className="border-cyan-500/30 bg-cyan-500/5"
          data-testid="host-domain-wildcard-suggestion"
        >
          <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-cyan-200">
                {t("Enable wildcard subdomain")}
              </p>
              <p className="mt-1 max-w-xl text-xs text-neutral-300">
                {t("Without wildcard, deployment URLs fall back to")}{" "}
                <code className="rounded bg-neutral-900 px-1 py-0.5 text-[0.7rem] text-neutral-200">
                  {data.domain || "your-host"}:&lt;dynamic-port&gt;
                </code>{" "}
                {t(
                  "— broken in browsers, embedded dashboards refuse to load. Add a wildcard like",
                )}{" "}
                <code className="rounded bg-neutral-900 px-1 py-0.5 text-[0.7rem] text-neutral-200">
                  *.app.{data.domain || "your-host"}
                </code>{" "}
                {t(
                  "in your DNS, point it at this VPS, then enable below — every deployment automatically becomes",
                )}{" "}
                <code className="rounded bg-neutral-900 px-1 py-0.5 text-[0.7rem] text-neutral-200">
                  &lt;name&gt;.app.{data.domain || "your-host"}
                </code>{" "}
                {t("with on-demand TLS.")}
              </p>
            </div>
            <Button
              onClick={() => {
                setFormInitialMode("tls_with_wildcard");
                setFormOpen(true);
              }}
              data-testid="host-domain-wildcard-suggestion-open"
            >
              {t("Configure wildcard…")}
            </Button>
          </CardBody>
        </Card>
      )}

      {data && !formOpen && (
        <Card>
          <CardBody className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-neutral-200">
                {t("Change configuration")}
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                {t(
                  "Swap to a new domain, add a wildcard, or fall back to plain HTTP. The dashboard will be unreachable for ~30 seconds while Caddy reloads.",
                )}
              </p>
            </div>
            <Button
              onClick={() => {
                setFormInitialMode(undefined);
                setFormOpen(true);
              }}
              data-testid="host-domain-change-open"
            >
              {t("Change…")}
            </Button>
          </CardBody>
        </Card>
      )}

      {data && formOpen && (
        <ChangeForm
          current={data}
          initialMode={formInitialMode}
          onCancel={() => setFormOpen(false)}
          onApplied={async () => {
            setFormOpen(false);
            await mutate();
          }}
        />
      )}
    </div>
  );
}

function CurrentConfig({ config }: { config: HostDomainConfig }) {
  const { t } = useT();
  return (
    <dl
      className="grid grid-cols-[8rem_1fr] gap-y-3 text-sm"
      data-testid="host-domain-current"
    >
      <dt className="text-neutral-500">{t("Mode")}</dt>
      <dd>
        <Badge
          tone={modeTone(config.mode)}
          data-testid="host-domain-mode-badge"
        >
          {t(modeLabel(config.mode))}
        </Badge>
      </dd>

      <dt className="text-neutral-500">{t("Domain")}</dt>
      <dd className="text-neutral-100" data-testid="host-domain-domain">
        {config.domain ? (
          <code className="rounded bg-neutral-900 px-2 py-0.5 font-mono text-xs text-neutral-200">
            {config.domain}
          </code>
        ) : (
          <span className="text-neutral-500">
            {t("Plain HTTP — reachable by IP only")}
          </span>
        )}
      </dd>

      {config.baseDomain && (
        <>
          <dt className="text-neutral-500">{t("Wildcard base")}</dt>
          <dd
            className="text-neutral-100"
            data-testid="host-domain-base-domain"
          >
            <code className="rounded bg-neutral-900 px-2 py-0.5 font-mono text-xs text-neutral-200">
              *.{config.baseDomain}
            </code>
            <p className="mt-1 text-xs text-neutral-500">
              {t("Per-deployment subdomains live under this.")}
            </p>
          </dd>
        </>
      )}

      {config.publicUrl && (
        <>
          <dt className="text-neutral-500">{t("Public URL")}</dt>
          <dd className="flex items-center gap-2">
            <code
              className="truncate rounded bg-neutral-900 px-2 py-0.5 font-mono text-xs text-neutral-200"
              data-testid="host-domain-public-url"
            >
              {config.publicUrl}
            </code>
            <CopyButton
              value={config.publicUrl}
              label={t("Copy public URL")}
              testid="host-domain-copy-public-url"
            />
          </dd>
        </>
      )}

      {config.publicIp && (
        <>
          <dt className="text-neutral-500">{t("Public IP")}</dt>
          <dd className="text-neutral-100" data-testid="host-domain-public-ip">
            <code className="rounded bg-neutral-900 px-2 py-0.5 font-mono text-xs text-neutral-200">
              {config.publicIp}
            </code>
          </dd>
        </>
      )}

      {config.acmeEmail && (
        <>
          <dt className="text-neutral-500">{t("ACME contact")}</dt>
          <dd className="text-neutral-100" data-testid="host-domain-acme-email">
            {config.acmeEmail}
          </dd>
        </>
      )}

      {config.fallbackUrls && config.fallbackUrls.length > 0 && (
        <>
          <dt className="text-neutral-500">{t("Fallback URLs")}</dt>
          <dd
            className="space-y-1.5"
            data-testid="host-domain-fallback-urls"
          >
            {config.fallbackUrls.map((u) => (
              <div key={u} className="flex items-center gap-2">
                <code className="truncate rounded bg-neutral-900 px-2 py-0.5 font-mono text-xs text-neutral-200">
                  {u}
                </code>
                <CopyButton
                  value={u}
                  label={t("Copy fallback URL {u}", { u })}
                  testid={`host-domain-copy-fallback-${u}`}
                />
              </div>
            ))}
            <p className="text-xs text-neutral-500">
              {t(
                "These addresses keep working during a domain change. Bookmark one before applying anything destructive.",
              )}
            </p>
          </dd>
        </>
      )}
    </dl>
  );
}

function CopyButton({
  value,
  label,
  testid,
}: {
  value: string;
  label: string;
  testid?: string;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={copy}
      aria-label={label}
      data-testid={testid}
    >
      {copied ? t("Copied!") : t("Copy")}
    </Button>
  );
}

function ChangeForm({
  current,
  initialMode,
  onCancel,
  onApplied,
}: {
  current: HostDomainConfig;
  initialMode?: Mode;
  onCancel: () => void;
  onApplied: () => Promise<void>;
}) {
  const { t } = useT();
  const [mode, setMode] = useState<Mode>(() => {
    if (initialMode) return initialMode;
    if (current.mode === "tls_with_wildcard") return "tls_with_wildcard";
    if (current.mode === "plain") return "plain";
    return "tls";
  });
  const [domain, setDomain] = useState(current.domain ?? "");
  const [baseDomain, setBaseDomain] = useState(current.baseDomain ?? "");
  const [acmeEmail, setAcmeEmail] = useState(current.acmeEmail ?? "");
  const [plainConfirm, setPlainConfirm] = useState(false);
  const [autoConfigureDns, setAutoConfigureDns] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Pull DNS credentials so we can light up the auto-config checkbox
  // when at least one Cloudflare credential is on file. Hidden when
  // none — clicking a no-op checkbox would just confuse operators.
  const { data: credentials } = useSWR<DNSCredential[]>(
    "/v1/admin/dns_credentials",
    () => api.admin.dnsCredentials.list(),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const matchingCredential = useMemo(() => {
    if (!credentials || credentials.length === 0) return null;
    if (!domain) return null;
    const d = domain.trim().toLowerCase().replace(/\.$/, "");
    if (!d) return null;
    let best: { cred: DNSCredential; zone: string } | null = null;
    for (const c of credentials) {
      if (c.provider !== "cloudflare") continue;
      for (const z of c.zones ?? []) {
        const zn = (z.name ?? "").trim().toLowerCase().replace(/\.$/, "");
        if (!zn) continue;
        if (d === zn || d.endsWith("." + zn)) {
          if (!best || zn.length > best.zone.length) {
            best = { cred: c, zone: zn };
          }
        }
      }
    }
    return best;
  }, [credentials, domain]);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyJob, setApplyJob] = useState<{
    jobId: string;
    targetUrl: string;
    dnsAuto?: HostDomainDNSAutoResult;
  } | null>(null);

  // The "would-be" URL after applying. Used in the confirm modal so the
  // operator sees exactly what they're committing to before clicking
  // Apply. Falls back to "(plain HTTP)" when there's no domain.
  const targetUrl = useMemo(() => {
    if (mode === "plain") return current.publicUrl ?? t("(plain HTTP via IP)");
    if (mode === "tls_with_wildcard" && domain) return `https://${domain}`;
    if (mode === "tls" && domain) return `https://${domain}`;
    return t("(unknown)");
  }, [mode, domain, current.publicUrl, t]);

  const fallbackUrl = useMemo(() => {
    if (current.fallbackUrls && current.fallbackUrls.length > 0) {
      return current.fallbackUrls[0];
    }
    if (current.publicIp) return `http://${current.publicIp}`;
    return t("your VPS IP");
  }, [current, t]);

  // Form-level validation. Checks the inputs the chosen mode actually
  // uses; ignores the fields the other modes care about. Sets
  // validationError for the inline message AND short-circuits the
  // submit-disabled check.
  const validationMessage: string | null = useMemo(() => {
    if (mode === "plain") {
      return plainConfirm
        ? null
        : t("Tick the confirmation to switch to plain HTTP");
    }
    if (!domain.trim()) return t("Domain is required");
    if (!HOSTNAME_RE.test(domain.trim().toLowerCase())) {
      return t("Domain must be a valid hostname (e.g. synapse.example.com)");
    }
    if (mode === "tls_with_wildcard") {
      if (!baseDomain.trim()) return t("Base domain is required");
      if (!HOSTNAME_RE.test(baseDomain.trim().toLowerCase())) {
        return t("Base domain must be a valid hostname (e.g. example.com)");
      }
    }
    if (acmeEmail && !EMAIL_RE.test(acmeEmail.trim())) {
      return t("ACME email must be a valid email");
    }
    return null;
  }, [mode, domain, baseDomain, acmeEmail, plainConfirm, t]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validationMessage) {
      setValidationError(validationMessage);
      return;
    }
    setValidationError(null);
    setConfirmOpen(true);
  };

  const buildPayload = (): HostDomainChangeInput => {
    if (mode === "plain") return { plainHttp: true };
    const out: HostDomainChangeInput = { domain: domain.trim().toLowerCase() };
    if (mode === "tls_with_wildcard") {
      out.baseDomain = baseDomain.trim().toLowerCase();
    }
    if (acmeEmail.trim()) out.acmeEmail = acmeEmail.trim();
    if (autoConfigureDns && matchingCredential) {
      out.autoConfigureDns = true;
    }
    return out;
  };

  const startApply = async (): Promise<void> => {
    const payload = buildPayload();
    try {
      const r = await api.admin.hostDomain.change(payload);
      setApplyJob({ jobId: r.jobId, targetUrl, dnsAuto: r.dnsAuto });
      setConfirmOpen(false);
      setApplyOpen(true);
    } catch (err) {
      setValidationError(
        err instanceof ApiError ? err.message : t("Could not start the change"),
      );
      setConfirmOpen(false);
    }
  };

  return (
    <Card data-testid="host-domain-change-form">
      <CardHeader>
        <CardTitle>{t("Change configuration")}</CardTitle>
        <CardDescription>
          {t("Pick the mode you want, then Apply. The dashboard will stay reachable at")}{" "}
          <code className="font-mono">{fallbackUrl}</code>{" "}
          {t("if anything goes wrong.")}
        </CardDescription>
      </CardHeader>
      <CardBody>
        <form
          onSubmit={onSubmit}
          className="space-y-5"
          aria-label={t("Change host domain")}
        >
          <fieldset className="space-y-3">
            <legend className="text-xs font-medium text-neutral-400">
              {t("Mode")}
            </legend>

            <ModeRadio
              id="host-domain-mode-tls"
              testid="host-domain-mode-tls"
              label={t("Set or change a domain (HTTPS via Caddy + Let's Encrypt)")}
              description={t(
                "A single hostname like synapse.example.com. Caddy issues a TLS cert on first request.",
              )}
              checked={mode === "tls"}
              onChange={() => setMode("tls")}
            />

            <ModeRadio
              id="host-domain-mode-wildcard"
              testid="host-domain-mode-wildcard"
              label={t("Add or change a wildcard base (per-deployment subdomains)")}
              description={t(
                "Per-deployment URLs become https://<name>.<base> instead of path-based. Requires a wildcard A record.",
              )}
              checked={mode === "tls_with_wildcard"}
              onChange={() => setMode("tls_with_wildcard")}
            />

            <ModeRadio
              id="host-domain-mode-plain"
              testid="host-domain-mode-plain"
              label={t("Switch to plain HTTP (no domain, just the IP)")}
              description={t(
                "Useful for testing on a fresh VPS before DNS is ready. The dashboard becomes reachable over HTTP only.",
              )}
              checked={mode === "plain"}
              onChange={() => setMode("plain")}
            />
          </fieldset>

          {(mode === "tls" || mode === "tls_with_wildcard") && (
            <div className="space-y-2">
              <label
                htmlFor="host-domain-domain-input"
                className="block text-xs text-neutral-400"
              >
                {t("Domain")}
              </label>
              <Input
                id="host-domain-domain-input"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="synapse.example.com"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="host-domain-domain-input"
              />
              <p
                className="rounded border border-yellow-900/60 bg-yellow-900/20 px-3 py-2 text-[11px] text-yellow-200"
                data-testid="host-domain-dns-hint"
              >
                <span className="font-semibold">{t("DNS first:")}</span>{" "}
                {t("point an")}{" "}
                <code className="font-mono">A</code> {t("record for")}{" "}
                <code className="font-mono">{domain || "<domain>"}</code> {t("at")}{" "}
                <code className="font-mono">
                  {current.publicIp || t("this host's IP")}
                </code>{" "}
                <strong>{t("before")}</strong>{" "}
                {t("applying. The change will fail if DNS isn’t pointing yet.")}
              </p>

              {matchingCredential && (
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-md border border-emerald-900/60 bg-emerald-900/15 px-3 py-2.5 text-[11px] text-emerald-100"
                  data-testid="host-domain-auto-dns-row"
                >
                  <input
                    type="checkbox"
                    checked={autoConfigureDns}
                    onChange={(e) => setAutoConfigureDns(e.target.checked)}
                    className="mt-0.5"
                    data-testid="host-domain-auto-dns-checkbox"
                  />
                  <span className="space-y-0.5">
                    <span className="block font-medium text-emerald-100">
                      {t("Auto-configure DNS via Cloudflare credential “{label}”", {
                        label: matchingCredential.cred.label,
                      })}
                    </span>
                    <span className="block text-emerald-200/80">
                      {t("Synapse will upsert")}{" "}
                      <code className="font-mono">A {domain || "<domain>"}</code>{" "}
                      {t("→ this host’s IP in zone")}{" "}
                      <code className="font-mono">
                        {matchingCredential.zone}
                      </code>{" "}
                      {t("before applying. Skip this if you manage DNS by hand.")}
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          {mode === "tls_with_wildcard" && (
            <div className="space-y-2">
              <label
                htmlFor="host-domain-base-input"
                className="block text-xs text-neutral-400"
              >
                {t("Wildcard base domain")}
              </label>
              <Input
                id="host-domain-base-input"
                value={baseDomain}
                onChange={(e) => setBaseDomain(e.target.value)}
                placeholder="example.com"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="host-domain-base-input"
              />
              <p className="text-[11px] text-neutral-500">
                {t("Add a wildcard")}{" "}
                <code className="font-mono">A</code> {t("record (")}
                <code className="font-mono">*.{baseDomain || "<base>"}</code>
                {t(") pointing at the same IP. Caddy issues per-subdomain certs on demand.")}
              </p>
              {/* v1.9.0: live URL preview — concrete sample URL so the
                  operator can visualise the shape before submitting. */}
              {baseDomain.trim() && HOSTNAME_RE.test(baseDomain.trim().toLowerCase()) && (
                <div
                  className="rounded border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-[11px] text-neutral-300"
                  data-testid="host-domain-wildcard-preview"
                >
                  <span className="text-neutral-500">{t("Deployments will appear as:")} </span>
                  <code className="font-mono text-cyan-200">
                    https://&lt;name&gt;.{baseDomain.trim().toLowerCase()}
                  </code>
                </div>
              )}
            </div>
          )}

          {(mode === "tls" || mode === "tls_with_wildcard") && (
            <div className="space-y-2">
              <label
                htmlFor="host-domain-acme-input"
                className="block text-xs text-neutral-400"
              >
                {t("ACME contact email")}{" "}
                <span className="text-neutral-600">{t("(optional)")}</span>
              </label>
              <Input
                id="host-domain-acme-input"
                value={acmeEmail}
                onChange={(e) => setAcmeEmail(e.target.value)}
                placeholder="ops@example.com"
                autoComplete="off"
                spellCheck={false}
                data-testid="host-domain-acme-input"
              />
              <p className="text-[11px] text-neutral-500">
                {t(
                  "Let’s Encrypt uses this for cert-expiry warnings. Leaving it blank keeps the existing contact.",
                )}
              </p>
            </div>
          )}

          {mode === "plain" && (
            <label
              className="flex cursor-pointer items-start gap-3 rounded-md border border-yellow-900/60 bg-yellow-900/20 px-3 py-2 text-[11px] text-yellow-200"
              data-testid="host-domain-plain-confirm-row"
            >
              <input
                type="checkbox"
                checked={plainConfirm}
                onChange={(e) => setPlainConfirm(e.target.checked)}
                className="mt-0.5"
                data-testid="host-domain-plain-confirm"
              />
              <span>
                {t("I understand this strips TLS and the dashboard will be reachable over plain HTTP only. The CLI and any browser bookmarks pointing at the current")}{" "}
                <code className="font-mono">https://</code>{" "}
                {t("URL will stop working until I update them.")}
              </span>
            </label>
          )}

          {validationError && (
            <p
              className="text-xs text-red-400"
              role="alert"
              data-testid="host-domain-form-error"
            >
              {validationError}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={validationMessage !== null}
              data-testid="host-domain-apply"
            >
              {t("Apply…")}
            </Button>
          </div>
        </form>
      </CardBody>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        currentUrl={current.publicUrl ?? "—"}
        targetUrl={targetUrl}
        fallbackUrl={fallbackUrl}
        mode={mode}
        onConfirm={startApply}
      />

      {applyJob && (
        <ApplyDialog
          open={applyOpen}
          onClose={async () => {
            setApplyOpen(false);
            setApplyJob(null);
            await onApplied();
          }}
          jobId={applyJob.jobId}
          targetUrl={applyJob.targetUrl}
          dnsAuto={applyJob.dnsAuto}
        />
      )}
    </Card>
  );
}

function ModeRadio({
  id,
  testid,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  testid: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors ${
        checked
          ? "border-violet-500/60 bg-violet-500/10"
          : "border-neutral-800 bg-neutral-950/40 hover:border-neutral-700 hover:bg-neutral-900/40"
      }`}
    >
      <input
        id={id}
        type="radio"
        name="host-domain-mode"
        checked={checked}
        onChange={onChange}
        className="mt-1"
        data-testid={testid}
      />
      <span className="flex-1">
        <span className="block text-sm font-medium text-neutral-100">
          {label}
        </span>
        <span className="mt-0.5 block text-xs text-neutral-500">
          {description}
        </span>
      </span>
    </label>
  );
}

// Wrapper that remounts on every open. Lets the inner component
// initialise its own state instead of needing an effect to reset it,
// which keeps eslint's react-hooks/set-state-in-effect rule happy.
function ConfirmDialog(props: {
  open: boolean;
  onClose: () => void;
  currentUrl: string;
  targetUrl: string;
  fallbackUrl: string;
  mode: Mode;
  onConfirm: () => Promise<void>;
}) {
  if (!props.open) return null;
  return <ConfirmDialogInner {...props} />;
}

function ConfirmDialogInner({
  open,
  onClose,
  currentUrl,
  targetUrl,
  fallbackUrl,
  mode,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  currentUrl: string;
  targetUrl: string;
  fallbackUrl: string;
  mode: Mode;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("Could not start the change"),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !pending && onClose()}
      title={t("Confirm host change")}
    >
      <div className="space-y-3" data-testid="host-domain-confirm-dialog">
        <div className="space-y-1 rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs">
          <div className="flex items-baseline gap-2">
            <span className="w-16 text-neutral-500">{t("From")}</span>
            <code className="font-mono text-neutral-200">{currentUrl}</code>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="w-16 text-neutral-500">{t("To")}</span>
            <code
              className="font-mono text-neutral-100"
              data-testid="host-domain-confirm-target"
            >
              {targetUrl}
            </code>
          </div>
        </div>

        <p className="text-xs text-neutral-300">
          {mode === "plain"
            ? t(
                "Synapse will switch to plain HTTP in ~30s. The browser tab will redirect automatically when it's reachable.",
              )
            : t(
                "Synapse will be reachable at the new domain in ~30s. The page will redirect automatically when the new URL is live.",
              )}
        </p>

        <p
          className="rounded border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
          data-testid="host-domain-confirm-fallback"
        >
          <span className="font-semibold">{t("If anything goes wrong,")}</span>{" "}
          {t("the dashboard will still be reachable at")}{" "}
          <code className="font-mono">{fallbackUrl}</code>. {t("Bookmark it now.")}
        </p>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={pending}
            data-testid="host-domain-confirm-cancel"
          >
            {t("Cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={pending}
            data-testid="host-domain-confirm-apply"
          >
            {pending ? t("Starting…") : t("Apply")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// Polls the daemon's job status every 2s. Once the job hits 'succeeded'
// we start probing the new URL's /v1/install_status; first 200 wins
// and we redirect. 90s of probe failures flips us to a "manual visit"
// fallback so the operator isn't left staring at a spinner forever.
function ApplyDialog({
  open,
  onClose,
  jobId,
  targetUrl,
  dnsAuto,
}: {
  open: boolean;
  onClose: () => void;
  jobId: string;
  targetUrl: string;
  dnsAuto?: HostDomainDNSAutoResult;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<HostDomainJobStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [probeTimedOut, setProbeTimedOut] = useState(false);
  const probeStartRef = useRef<number | null>(null);
  // Track "probe loop already started" with a ref instead of state so
  // we don't trigger react-hooks/set-state-in-effect on the probe
  // start path. The flag is purely a re-entrancy guard — it never
  // needs to drive a re-render.
  const probingRef = useRef(false);

  // Poll job status every 2s while the modal is open and not done.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let consecutiveFailures = 0;

    const tick = async () => {
      try {
        const s = await api.admin.hostDomain.status(jobId);
        if (cancelled) return;
        consecutiveFailures = 0;
        setStatus(s);
        setPollError(null);
      } catch (err) {
        if (cancelled) return;
        consecutiveFailures += 1;
        // The synapse-api itself can briefly disappear while Caddy
        // reloads. Accept up to 3 consecutive misses before surfacing
        // an error — the next poll usually recovers.
        if (consecutiveFailures >= 3) {
          setPollError(
            err instanceof ApiError
              ? err.message
              : t("Lost contact with the host updater"),
          );
        }
      }
    };

    void tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, jobId, t]);

  // When the job succeeds, kick off the new-URL probe. We hit
  // /v1/install_status (public, no auth) every 3s; first 200 wins.
  useEffect(() => {
    if (!open) return;
    if (status?.state !== "succeeded") return;
    if (!targetUrl || targetUrl.startsWith("(")) return;
    if (probingRef.current) return;

    probingRef.current = true;
    probeStartRef.current = Date.now();
    let cancelled = false;

    const probe = async () => {
      // 90s budget for TLS to issue + Caddy to come back. Hetzner
      // CPX22 + plain-domain renew is sub-30s; wildcard issue can be
      // slower.
      if (
        probeStartRef.current !== null &&
        Date.now() - probeStartRef.current > 90_000
      ) {
        if (!cancelled) setProbeTimedOut(true);
        return false;
      }
      try {
        const url = `${targetUrl.replace(/\/$/, "")}/v1/install_status`;
        const res = await fetch(url, {
          method: "GET",
          cache: "no-store",
          // Don't send our bearer to a potentially-fresh origin — the
          // endpoint is public anyway.
          credentials: "omit",
        });
        if (res.ok) {
          if (!cancelled) {
            window.location.href = `${targetUrl.replace(/\/$/, "")}/teams`;
          }
          return true;
        }
      } catch {
        // Probe errors are expected during the cutover window.
      }
      return false;
    };

    const tick = async () => {
      const done = await probe();
      if (done || cancelled) return;
    };

    void tick();
    const id = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [status?.state, open, targetUrl]);

  const stateBadge = (() => {
    if (!status) return { tone: "neutral" as const, label: t("starting…") };
    switch (status.state) {
      case "queued":
        return { tone: "neutral" as const, label: t("queued") };
      case "running":
        return { tone: "yellow" as const, label: t("running") };
      case "succeeded":
        return { tone: "green" as const, label: t("succeeded") };
      case "failed":
        return { tone: "red" as const, label: t("failed") };
    }
  })();

  const log = status?.log ?? [];
  const lastLines = log.slice(-20);

  const dialogTitle =
    status?.state === "failed"
      ? t("Host change failed")
      : status?.state === "succeeded"
        ? probeTimedOut
          ? t("Almost there — TLS may still be issuing")
          : t("Waiting for the new URL to come up")
        : t("Changing host configuration…");

  return (
    <Dialog
      open={open}
      onClose={() => {
        // Disallow close while running so the operator doesn't
        // accidentally lose progress visibility. Failure / success
        // both unblock close.
        if (status?.state === "running" || status?.state === "queued") return;
        onClose();
      }}
      title={dialogTitle}
    >
      <div className="space-y-3" data-testid="host-domain-apply-dialog">
        <div className="flex items-center gap-2 text-xs">
          <Badge tone={stateBadge.tone} data-testid="host-domain-apply-state">
            {stateBadge.label}
          </Badge>
          <span className="text-neutral-500">{t("target")}</span>
          <code className="truncate rounded bg-neutral-900 px-2 py-0.5 font-mono text-[11px] text-neutral-200">
            {targetUrl}
          </code>
        </div>

        {dnsAuto?.attempted && dnsAuto.success && (
          <p
            className="rounded border border-emerald-900/60 bg-emerald-900/20 px-3 py-2 text-[11px] text-emerald-100"
            data-testid="host-domain-dns-auto-success"
          >
            {t("✓ Created A record")}{" "}
            <code className="font-mono">{dnsAuto.recordName}</code> →{" "}
            <code className="font-mono">{dnsAuto.ip}</code>{" "}
            {t("in zone")} <code className="font-mono">{dnsAuto.zone}</code>{" "}
            {t("via Cloudflare")}
            {dnsAuto.ipDetectedVia ? ` (${dnsAuto.ipDetectedVia})` : ""}.
          </p>
        )}
        {dnsAuto?.attempted && !dnsAuto.success && (
          <p
            className="rounded border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-200"
            data-testid="host-domain-dns-auto-failure"
          >
            <span className="font-semibold">{t("Auto DNS skipped:")}</span>{" "}
            {dnsAuto.reason ?? t("unknown reason")}.{" "}
            {t("Create the A record by hand and re-apply if the reconfigure fails below.")}
          </p>
        )}

        {pollError && (
          <p className="rounded border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-200">
            {pollError} {t("— the synapse-api might be restarting. Will keep polling.")}
          </p>
        )}

        {lastLines.length > 0 && (
          <pre
            className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-neutral-800/80 bg-neutral-950 p-3 font-mono text-xs leading-snug text-neutral-300"
            data-testid="host-domain-apply-log"
          >
            {lastLines.join("\n")}
          </pre>
        )}

        {status?.state === "succeeded" && !probeTimedOut && (
          <p className="rounded bg-emerald-900/40 px-3 py-2 text-xs text-emerald-200">
            {t(
              "Setup completed. Probing the new URL — the page will redirect automatically once it answers.",
            )}
          </p>
        )}

        {status?.state === "succeeded" && probeTimedOut && (
          <div className="space-y-2">
            <p className="rounded border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
              {t(
                "The host change finished, but the new URL isn’t answering yet. TLS issuance can take a couple of minutes the first time. Open the URL manually when you’re ready.",
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t("Close")}
              </Button>
              <a
                href={targetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center justify-center rounded-md bg-violet-500 px-3.5 text-sm font-medium text-white hover:bg-violet-400"
              >
                {t("Open new URL")}
              </a>
            </div>
          </div>
        )}

        {status?.state === "failed" && (
          <div className="space-y-2">
            <p className="rounded bg-red-900/40 px-3 py-2 text-xs text-red-200">
              <span className="font-semibold">{t("Change failed.")}</span>{" "}
              {status.error || t("setup.sh exited non-zero.")}{" "}
              {t("A rollback may be needed — SSH to your VPS and run")}{" "}
              <code className="rounded bg-neutral-900 px-1 py-0.5 font-mono">
                ./setup.sh --status
              </code>{" "}
              {t("to inspect the current state, then")}{" "}
              <code className="rounded bg-neutral-900 px-1 py-0.5 font-mono">
                ./setup.sh --change-domain
              </code>{" "}
              {t("to retry.")}
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={onClose} data-testid="host-domain-apply-close">
                {t("Close")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
