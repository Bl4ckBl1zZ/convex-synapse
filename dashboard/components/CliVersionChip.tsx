"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import clsx from "clsx";
import { api, type CLIVersion } from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";

// CliVersionChip — TopBar pill that exposes the npm install command
// for @iann29/synapse and the latest published version.
//
// Discoverability gap this fixes: operators who land on the Synapse
// dashboard often don't know the CLI exists — they configure
// deployments via the UI and reach for `npx convex` directly when
// they want to push code. The chip puts the install command one
// click away with the latest version pre-filled.
//
// Backend: GET /v1/cli_latest_version (public, cached server-side
// 15min). Falls back to a "no version published yet" message if npm
// is unreachable on first fetch.
export function CliVersionChip() {
  const { data, mutate } = useSWR<CLIVersion>(
    "/v1/cli_latest_version",
    () => api.admin.cliLatestVersion(),
    {
      // 24h auto-refresh. The CLI doesn't ship multiple times an hour,
      // and the server already caches at 15min — being polite here.
      refreshInterval: 24 * 60 * 60 * 1000,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"install" | "name" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // First paint with no data → hide the chip rather than flash a
  // placeholder. The SWR is server-cached so subsequent renders are
  // usually instant anyway.
  if (!data) return null;

  const installCmd =
    data.installCommand ??
    (data.latest
      ? `npm install -g ${data.packageName}@${data.latest}`
      : `npm install -g ${data.packageName}@latest`);

  const onCopy = async (value: string, kind: "install" | "name") => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500);
    }
  };

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const fresh = await api.admin.cliLatestVersionRefresh();
      await mutate(fresh, { revalidate: false });
    } catch {
      // Soft-fail — SWR's auto-refresh will retry. Chip stays
      // interactive so a stuck operator can try again.
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="cli-version-chip"
        className={clsx(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200",
        )}
        title={
          data.latest
            ? `Synapse CLI latest: v${data.latest} — click for install command`
            : "Synapse CLI install — click for command"
        }
      >
        <span aria-hidden className="font-mono text-neutral-500">CLI</span>
        <span className="font-mono">
          {data.latest ? `v${data.latest}` : "install"}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Synapse CLI install"
          className="synapse-fade-in absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-lg border border-neutral-800 bg-[#141416] shadow-2xl"
          data-testid="cli-version-popover"
        >
          <div className="border-b border-neutral-800 px-3 py-2">
            <p className="text-xs font-semibold text-neutral-100">
              Synapse CLI
            </p>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              {data.latest ? (
                <>Latest published version: <span className="font-mono text-neutral-300">v{data.latest}</span></>
              ) : (
                "Couldn't reach npm; install command still works."
              )}
            </p>
          </div>

          <div className="space-y-3 px-3 py-3">
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
                Install or upgrade
              </p>
              <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5">
                <code
                  className="flex-1 truncate font-mono text-[11px] text-cyan-300"
                  data-testid="cli-install-command"
                >
                  {installCmd}
                </code>
                <button
                  type="button"
                  onClick={() => onCopy(installCmd, "install")}
                  className="text-[10px] text-neutral-400 hover:text-neutral-200"
                  data-testid="cli-install-copy"
                  aria-label="Copy install command"
                >
                  {copied === "install" ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>

            <div className="rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px] text-neutral-400">
              <p className="font-mono text-neutral-300">
                {data.packageName}
              </p>
              <p className="mt-1 leading-snug">
                Thin wrapper around <span className="font-mono">npx convex</span>.
                Use <span className="font-mono text-neutral-300">synapse login</span>{" "}
                to authenticate this machine against this Synapse host,
                then <span className="font-mono text-neutral-300">synapse select</span>{" "}
                in your project directory.
              </p>
            </div>

            {data.error && (
              <p className="text-[11px] text-amber-300/80">
                npm registry note: {data.error}
              </p>
            )}

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                className="text-[11px] text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
                data-testid="cli-version-refresh"
              >
                {refreshing ? "Checking…" : "Check now"}
              </button>
              <a
                href="https://www.npmjs.com/package/@iann29/synapse"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-neutral-500 hover:text-neutral-300"
              >
                npm ↗
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
