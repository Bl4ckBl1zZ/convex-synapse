"use client";

import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError, api, type EnvVar, type EnvSyncResult } from "@/lib/api";
import { useT } from "@/lib/i18n";

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

// v1.17.1+: env vars are stored per (name, deploymentType), so the
// same NAME can carry DIFFERENT values for dev / prod / preview — the
// Convex Cloud model. The list comes back with one entry per
// (name, type); we group by name on render to show one card per
// variable with per-type rows underneath. Saving a value pushes it
// to that deployment's Convex function runtime store; failures
// surface inline.
export function EnvVarsPanel({ projectId }: Props) {
  const { t } = useT();
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
  // In-flight delete guard: keyed by name (delete-all) or name:type (one row)
  // so a double-click doesn't fire two delete+push requests at the runtime
  // env store.
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

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

  const toggleReveal = (key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
      setFormError(t("Pick at least one deployment type (DEV / PROD / PREVIEW)."));
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
        err instanceof ApiError ? err.message : t("Could not save env var"),
      );
    } finally {
      setPending(false);
    }
  };

  const markDeleting = (key: string, on: boolean) =>
    setDeleting((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const removeOne = async (n: string, type: DeploymentTypeOption) => {
    const key = n + ":" + type;
    if (deleting.has(key)) return;
    setFormError(null);
    markDeleting(key, true);
    try {
      const resp = await api.projects.updateEnvVars(projectId, [
        { op: "delete", name: n, deploymentTypes: [type] },
      ]);
      setLastAutoSync(resp.syncResult ?? null);
      setLastAutoSyncAt(Date.now());
      setRevealed((prev) => {
        const next = new Set(prev);
        next.delete(n + ":" + type);
        return next;
      });
      await mutate();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : t("Could not delete env var"),
      );
    } finally {
      markDeleting(key, false);
    }
  };

  const removeAllForName = async (n: string) => {
    if (deleting.has(n)) return;
    if (
      !window.confirm(
        t(
          'Delete "{name}" from every environment? It\'s a live function-runtime variable — running deployments stop seeing process.env.{name} as soon as this syncs. This cannot be undone.',
          { name: n },
        ),
      )
    ) {
      return;
    }
    setFormError(null);
    markDeleting(n, true);
    try {
      const resp = await api.projects.updateEnvVars(projectId, [
        { op: "delete", name: n },
      ]);
      setLastAutoSync(resp.syncResult ?? null);
      setLastAutoSyncAt(Date.now());
      // Strip every revealed key for this name.
      setRevealed((prev) => {
        const next = new Set(prev);
        for (const k of Array.from(prev)) {
          if (k === n || k.startsWith(n + ":")) next.delete(k);
        }
        return next;
      });
      await mutate();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : t("Could not delete env var"),
      );
    } finally {
      markDeleting(n, false);
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
        err instanceof ApiError ? err.message : t("Could not sync env vars"),
      );
    } finally {
      setSyncing(false);
    }
  };

  const hasEnvVars = data && data.length > 0;

  // Group the flat list of (name, deploymentTypes:[type]) entries into
  // per-name buckets. Order: alphabetic by name, then dev / prod / preview
  // per the canonical lifecycle order (not alphabetic, because that puts
  // preview before prod which reads wrong).
  const TYPE_ORDER: Record<string, number> = { dev: 0, prod: 1, preview: 2, custom: 3 };
  const grouped = new Map<string, EnvVar[]>();
  if (data) {
    for (const v of data) {
      const arr = grouped.get(v.name) ?? [];
      arr.push(v);
      grouped.set(v.name, arr);
    }
    for (const [, arr] of grouped) {
      arr.sort((a, b) => {
        const ai = TYPE_ORDER[a.deploymentTypes[0] ?? ""] ?? 99;
        const bi = TYPE_ORDER[b.deploymentTypes[0] ?? ""] ?? 99;
        return ai - bi;
      });
    }
  }
  const groupedEntries = Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="space-y-3" data-testid="env-vars-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-200">
            {t("Environment variables")}
          </h2>
          <p className="text-xs text-neutral-500">
            {t("Available inside every Convex function in this project via")}{" "}
            <code className="text-neutral-300">process.env.NAME</code>.{" "}
            {t("Same store the Convex Dashboard env panel writes to.")}{" "}
            <strong>{t("Same name can carry different values per deployment type")}</strong> {t("— e.g.")}{" "}
            <code className="text-neutral-300">BETTER_AUTH_SECRET</code>{" "}
            {t("with one value for dev and another for prod. Saves push to every running deployment automatically; use")}{" "}
            <span className="text-neutral-300">{t("Re-sync to deployments")}</span>{" "}
            {t("to retry if a push failed.")}
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
            {t("Re-sync to deployments")}
          </Button>
        )}
      </div>

      {isLoading && <p className="text-xs text-neutral-500">{t("Loading…")}</p>}
      {error && (
        <p className="text-xs text-red-400">
          {t("Failed to load env vars: {message}", { message: (error as Error).message })}
        </p>
      )}

      {data && data.length === 0 && (
        <p className="text-xs text-neutral-500">{t("No env vars yet.")}</p>
      )}

      {hasEnvVars && (
        <Card>
          <CardBody className="divide-y divide-neutral-800 p-0">
            {groupedEntries.map(([name, rows]) => (
              <div key={name} className="px-4 py-3" data-testid={`env-var-group-${name}`}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="truncate font-mono text-sm text-neutral-100">{name}</p>
                  <button
                    type="button"
                    onClick={() => removeAllForName(name)}
                    disabled={deleting.has(name)}
                    className="text-[11px] text-neutral-500 hover:text-red-400 disabled:opacity-50"
                    aria-label={t("Delete all values for {name}", { name })}
                    data-testid={`env-var-delete-all-${name}`}
                  >
                    {t("Delete all")}
                  </button>
                </div>
                <div className="space-y-1.5">
                  {rows.map((v) => {
                    const dt = (v.deploymentTypes[0] ?? "dev") as DeploymentTypeOption;
                    const isRevealed = revealed.has(v.name + ":" + dt);
                    return (
                      <div
                        key={v.name + ":" + dt}
                        className="flex flex-wrap items-center gap-3 text-sm"
                        data-testid={`env-var-row-${v.name}`}
                      >
                        <Badge
                          tone={TYPE_TONE[dt] ?? "neutral"}
                          className="px-1.5 py-0 text-[10px]"
                        >
                          {dt.toUpperCase()}
                        </Badge>
                        <p
                          className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-500"
                          data-testid={`env-var-value-${v.name}`}
                        >
                          {!v.value ? (
                            <span className="italic">{t("(empty)")}</span>
                          ) : isRevealed ? (
                            v.value
                          ) : (
                            "•".repeat(Math.max(8, Math.min(24, v.value.length)))
                          )}
                        </p>
                        {v.value && (
                          <button
                            type="button"
                            onClick={() => toggleReveal(v.name + ":" + dt)}
                            className="text-[11px] text-neutral-500 hover:text-neutral-200"
                            aria-label={isRevealed ? t("Hide value for {name} on {type}", { name: v.name, type: dt }) : t("Reveal value for {name} on {type}", { name: v.name, type: dt })}
                            aria-pressed={isRevealed}
                            data-testid={`env-var-toggle-${v.name}`}
                          >
                            {isRevealed ? t("Hide") : t("Reveal")}
                          </button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeOne(v.name, dt)}
                          disabled={deleting.has(v.name + ":" + dt) || deleting.has(v.name)}
                          aria-label={t("Delete {name} ({type})", { name: v.name, type: dt })}
                        >
                          {t("Delete")}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      <form onSubmit={add} className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[10rem] space-y-1">
            <label htmlFor="envvar-name" className="block text-xs text-neutral-400">
              {t("Name")}
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
              {t("Value")}
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
            {pending ? t("Saving…") : t("Add")}
          </Button>
        </div>
        <fieldset className="space-y-1">
          <legend className="block text-xs text-neutral-400">
            {t("Apply to deployment types")}
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
            {t("Select multiple types to apply the same value to each. Add the same NAME again with different types to use a different value per type (e.g. one secret for dev, another for prod).")}
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
              {t("✓ synced to")} <strong>{lastAutoSync.synced}</strong>{" "}
              {lastAutoSync.synced === 1 ? t("deployment") : t("deployments")}
            </span>
          )}
          {lastAutoSync.skipped > 0 && (
            <span className="text-neutral-400">
              <strong>{lastAutoSync.skipped}</strong> {t("skipped (not running)")}
            </span>
          )}
          {lastAutoSync.failed && lastAutoSync.failed.length > 0 && (
            <span className="text-amber-400">
              <strong>{lastAutoSync.failed.length}</strong> {t("failed — click Re-sync to retry")}
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
              {t("Re-sync env vars to deployments?")}
            </h3>
            <p className="mt-1 text-xs text-neutral-400">
              {t("Pushes the current env vars to the Convex function runtime store of every running deployment in this project. No container restart, no downtime — just a single API call per deployment.")}
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              {t("Use this only if an automatic push failed (e.g. a deployment was offline during the last save). Stopped / non-running deployments are skipped.")}
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
                {syncing ? t("Syncing…") : t("Re-sync now")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setSyncOpen(false)}
                disabled={syncing}
              >
                {t("Cancel")}
              </Button>
            </div>
          )}

          {syncError && (
            <div className="space-y-2">
              <p className="text-xs text-red-400">{syncError}</p>
              <Button variant="ghost" onClick={() => setSyncOpen(false)}>
                {t("Close")}
              </Button>
            </div>
          )}

          {syncResult && (
            <div
              className="space-y-2 rounded border border-neutral-800 bg-neutral-900/40 p-3 text-xs"
              data-testid="env-vars-sync-result"
            >
              <p className="text-neutral-200">
                <strong>{syncResult.synced}</strong> {t("synced ·")}{" "}
                <strong>{syncResult.skipped}</strong> {t("skipped ·")}{" "}
                <strong>{syncResult.total}</strong> {t("total")}
                {syncResult.failed && syncResult.failed.length > 0 && (
                  <>
                    {" "}·{" "}
                    <span className="text-amber-400">
                      <strong>{syncResult.failed.length}</strong> {t("failed")}
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
              <Button onClick={() => setSyncOpen(false)}>{t("Done")}</Button>
            </div>
          )}
        </div>
      </Dialog>
    </section>
  );
}
