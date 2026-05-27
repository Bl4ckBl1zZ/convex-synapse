"use client";

import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError, api, type EnvVar, type EnvSyncResult } from "@/lib/api";

type Props = { projectId: string };

// All deployment types the backend will accept. UI defaults to "all
// three checked" because that's also the backend default when the
// `deploymentTypes` field is omitted — keeps semantics consistent with
// pre-v1.9.2 behaviour where the form had no selector.
type DeploymentTypeOption = "dev" | "prod" | "preview";
const ALL_TYPES: DeploymentTypeOption[] = ["dev", "prod", "preview"];

const TYPE_TONE: Record<DeploymentTypeOption, "cyan" | "amber" | "violet"> = {
  dev: "cyan",
  prod: "amber",
  preview: "violet",
};

// v1.17+: env vars here are pushed into the Convex backend's function
// runtime env store (the same one `npx convex env set` writes to).
// Saving auto-syncs to every running deployment in the project;
// failures are surfaced inline so the operator can retry via the
// Re-sync button. No container restart. See docs/ENV_PIPELINE_PLAN.md.
export function EnvVarsPanel({ projectId }: Props) {
  const { data, error, isLoading, mutate } = useSWR<EnvVar[]>(
    ["/env-vars", projectId],
    () => api.projects.listEnvVars(projectId),
  );

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [types, setTypes] = useState<DeploymentTypeOption[]>(ALL_TYPES);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Which env-var values are currently revealed. Default-masked so a
  // shoulder-surfer or screen-share doesn't leak secrets just because
  // the operator opened the project page.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  // Re-sync flow state (manual retry of the per-deployment push).
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<EnvSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Auto-sync result captured from the last updateEnvVars call (add or
  // remove). Surfaced as an inline banner under the form so the operator
  // knows the push happened without opening the manual re-sync dialog.
  const [lastAutoSync, setLastAutoSync] = useState<EnvSyncResult | null>(null);
  const [lastAutoSyncAt, setLastAutoSyncAt] = useState<number | null>(null);

  const toggleReveal = (n: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  };

  const toggleType = (t: DeploymentTypeOption) => {
    setTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) return;
    if (types.length === 0) {
      setFormError("Pick at least one deployment type (DEV / PROD / PREVIEW).");
      return;
    }
    setPending(true);
    try {
      const resp = await api.projects.updateEnvVars(projectId, [
        {
          op: "set",
          name: name.trim(),
          value,
          deploymentTypes: types,
        },
      ]);
      setLastAutoSync(resp.syncResult ?? null);
      setLastAutoSyncAt(Date.now());
      setName("");
      setValue("");
      setTypes(ALL_TYPES);
      await mutate();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not save env var",
      );
    } finally {
      setPending(false);
    }
  };

  const remove = async (n: string) => {
    setFormError(null);
    try {
      const resp = await api.projects.updateEnvVars(projectId, [
        { op: "delete", name: n },
      ]);
      setLastAutoSync(resp.syncResult ?? null);
      setLastAutoSyncAt(Date.now());
      // Clear the reveal flag for the removed name so a future var with
      // the same name doesn't auto-reveal.
      setRevealed((prev) => {
        const next = new Set(prev);
        next.delete(n);
        return next;
      });
      await mutate();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not delete env var",
      );
    }
  };

  const sync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const r = await api.projects.syncEnvToDeployments(projectId);
      setSyncResult(r);
    } catch (err) {
      setSyncError(
        err instanceof ApiError ? err.message : "Could not sync env vars",
      );
    } finally {
      setSyncing(false);
    }
  };

  const hasEnvVars = data && data.length > 0;

  return (
    <section className="space-y-3" data-testid="env-vars-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-200">
            Environment variables
          </h2>
          <p className="text-xs text-neutral-500">
            Available inside every Convex function in this project via{" "}
            <code className="text-neutral-300">process.env.NAME</code>. Same
            store the Convex Dashboard env panel writes to. Changes here
            push to every running deployment automatically; use{" "}
            <span className="text-neutral-300">Re-sync to deployments</span>{" "}
            to retry if a push failed.
          </p>
        </div>
        {hasEnvVars && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSyncResult(null);
              setSyncError(null);
              setSyncOpen(true);
            }}
            data-testid="env-vars-apply-existing-open"
          >
            Re-sync to deployments
          </Button>
        )}
      </div>

      {isLoading && <p className="text-xs text-neutral-500">Loading…</p>}
      {error && (
        <p className="text-xs text-red-400">
          Failed to load env vars: {(error as Error).message}
        </p>
      )}

      {data && data.length === 0 && (
        <p className="text-xs text-neutral-500">No env vars yet.</p>
      )}

      {hasEnvVars && (
        <Card>
          <CardBody className="divide-y divide-neutral-800 p-0">
            {data!.map((v) => {
              const isRevealed = revealed.has(v.name);
              const typeList =
                v.deploymentTypes && v.deploymentTypes.length > 0
                  ? v.deploymentTypes
                  : ALL_TYPES;
              const allTypes = typeList.length === ALL_TYPES.length;
              return (
                <div
                  key={v.name}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm"
                  data-testid={`env-var-row-${v.name}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-mono text-neutral-100">
                        {v.name}
                      </p>
                      {!allTypes && (
                        <div className="flex gap-1">
                          {typeList.map((t) => (
                            <Badge
                              key={t}
                              tone={TYPE_TONE[t as DeploymentTypeOption] ?? "neutral"}
                              className="px-1.5 py-0 text-[10px]"
                            >
                              {t.toUpperCase()}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <p
                        className="truncate font-mono text-xs text-neutral-500"
                        data-testid={`env-var-value-${v.name}`}
                      >
                        {!v.value ? (
                          <span className="italic">(empty)</span>
                        ) : isRevealed ? (
                          v.value
                        ) : (
                          "•".repeat(Math.max(8, Math.min(24, v.value.length)))
                        )}
                      </p>
                      {v.value && (
                        <button
                          type="button"
                          onClick={() => toggleReveal(v.name)}
                          className="text-[11px] text-neutral-500 hover:text-neutral-200"
                          aria-label={isRevealed ? `Hide value for ${v.name}` : `Reveal value for ${v.name}`}
                          aria-pressed={isRevealed}
                          data-testid={`env-var-toggle-${v.name}`}
                        >
                          {isRevealed ? "Hide" : "Reveal"}
                        </button>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(v.name)}
                    aria-label={`Delete env var ${v.name}`}
                  >
                    Delete
                  </Button>
                </div>
              );
            })}
          </CardBody>
        </Card>
      )}

      <form onSubmit={add} className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[10rem] space-y-1">
            <label htmlFor="envvar-name" className="block text-xs text-neutral-400">
              Name
            </label>
            <Input
              id="envvar-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="API_KEY"
              required
            />
          </div>
          <div className="flex-1 min-w-[12rem] space-y-1">
            <label htmlFor="envvar-value" className="block text-xs text-neutral-400">
              Value
            </label>
            <Input
              id="envvar-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="…"
              type="password"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button type="submit" disabled={pending || !name.trim() || types.length === 0}>
            {pending ? "Saving…" : "Add"}
          </Button>
        </div>
        <fieldset className="space-y-1">
          <legend className="block text-xs text-neutral-400">
            Apply to deployment types
          </legend>
          <div className="flex flex-wrap gap-3 text-xs">
            {ALL_TYPES.map((t) => (
              <label
                key={t}
                className="inline-flex items-center gap-1.5 text-neutral-300"
              >
                <input
                  type="checkbox"
                  checked={types.includes(t)}
                  onChange={() => toggleType(t)}
                  data-testid={`envvar-type-${t}`}
                  className="h-3.5 w-3.5 rounded border-neutral-700 bg-neutral-900 text-violet-500 focus:ring-1 focus:ring-violet-500"
                />
                <span className="font-mono text-[11px] uppercase">{t}</span>
              </label>
            ))}
          </div>
          <p className="text-[10px] text-neutral-600">
            All three selected = applied to every deployment in this project (the default).
          </p>
        </fieldset>
      </form>

      {formError && <p className="text-xs text-red-400">{formError}</p>}

      {lastAutoSync && (
        <div
          className="flex flex-wrap items-center gap-3 rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs"
          data-testid="env-vars-autosync-banner"
        >
          {lastAutoSync.synced > 0 && (
            <span className="text-emerald-300">
              ✓ synced to <strong>{lastAutoSync.synced}</strong>{" "}
              deployment{lastAutoSync.synced === 1 ? "" : "s"}
            </span>
          )}
          {lastAutoSync.skipped > 0 && (
            <span className="text-neutral-400">
              <strong>{lastAutoSync.skipped}</strong> skipped (not running)
            </span>
          )}
          {lastAutoSync.failed && lastAutoSync.failed.length > 0 && (
            <span className="text-amber-400">
              <strong>{lastAutoSync.failed.length}</strong> failed — click
              Re-sync to retry
            </span>
          )}
          {lastAutoSync.notice && (
            <span className="text-neutral-500">{lastAutoSync.notice}</span>
          )}
          {lastAutoSyncAt && (
            <span className="text-neutral-600">
              {new Date(lastAutoSyncAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      <Dialog open={syncOpen} onClose={() => !syncing && setSyncOpen(false)}>
        <div className="space-y-4 p-1" data-testid="env-vars-sync-dialog">
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">
              Re-sync env vars to deployments?
            </h3>
            <p className="mt-1 text-xs text-neutral-400">
              Pushes the current env vars to the Convex function runtime store
              of every running deployment in this project. No container restart,
              no downtime — just a single API call per deployment.
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Use this only if an automatic push failed (e.g. a deployment
              was offline during the last save). Stopped / non-running
              deployments are skipped.
            </p>
          </div>

          {!syncResult && !syncError && (
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={sync}
                disabled={syncing}
                data-testid="env-vars-sync-confirm"
              >
                {syncing ? "Syncing…" : "Re-sync now"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setSyncOpen(false)}
                disabled={syncing}
              >
                Cancel
              </Button>
            </div>
          )}

          {syncError && (
            <div className="space-y-2">
              <p className="text-xs text-red-400">{syncError}</p>
              <Button variant="ghost" onClick={() => setSyncOpen(false)}>
                Close
              </Button>
            </div>
          )}

          {syncResult && (
            <div
              className="space-y-2 rounded border border-neutral-800 bg-neutral-900/40 p-3 text-xs"
              data-testid="env-vars-sync-result"
            >
              <p className="text-neutral-200">
                <strong>{syncResult.synced}</strong> synced ·{" "}
                <strong>{syncResult.skipped}</strong> skipped ·{" "}
                <strong>{syncResult.total}</strong> total
                {syncResult.failed && syncResult.failed.length > 0 && (
                  <>
                    {" "}·{" "}
                    <span className="text-amber-400">
                      <strong>{syncResult.failed.length}</strong> failed
                    </span>
                  </>
                )}
              </p>
              {syncResult.failed && syncResult.failed.length > 0 && (
                <ul className="space-y-1 text-neutral-400">
                  {syncResult.failed.map((f) => (
                    <li key={f.deploymentId}>
                      <span className="text-amber-300">{f.deploymentName}</span>:{" "}
                      {f.reason}
                    </li>
                  ))}
                </ul>
              )}
              {syncResult.notice && (
                <p className="text-neutral-500">{syncResult.notice}</p>
              )}
              <Button onClick={() => setSyncOpen(false)}>Done</Button>
            </div>
          )}
        </div>
      </Dialog>
    </section>
  );
}
