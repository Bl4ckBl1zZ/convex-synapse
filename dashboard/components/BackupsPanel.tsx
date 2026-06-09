"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconArchive } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { ApiError, api, type Deployment, type DeploymentBackup } from "@/lib/api";
import { useT } from "@/lib/i18n";

type Props = {
  deploymentName: string;
};

// BackupsPanel — per-deployment snapshot backups (v1.25+), the
// self-hosted answer to Cloud's Backups page. Each backup is a real
// `npx convex export` zip stored on the synapse-backups volume; restore
// feeds it back with `convex import --replace` (destructive, confirmed).
// Collapsed by default like the other per-deployment panels so the row
// only pays for the list when the operator opens it.
export function BackupsPanel({ deploymentName }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return open ? (
    <BackupsPanelExpanded deploymentName={deploymentName} onCollapse={() => setOpen(false)} />
  ) : (
    <div className="flex items-center gap-2 text-xs">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={t("Manage backups for {deploymentName}", { deploymentName })}
      >
        <IconArchive className="mr-1.5 inline-block opacity-70" />
        {t("Backups")}
      </Button>
    </div>
  );
}

function humanSize(bytes?: number): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function BackupsPanelExpanded({
  deploymentName,
  onCollapse,
}: {
  deploymentName: string;
  onCollapse: () => void;
}) {
  const { t } = useT();
  // A restore in flight doesn't change the backup row's status (the
  // archive stays 'complete'); only restoredAt moves when the import
  // lands. Track it locally so the poll below keeps running until then.
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreStartedAt, setRestoreStartedAt] = useState<string | null>(null);

  const {
    data: backupsList,
    error,
    mutate,
    isLoading,
  } = useSWR<DeploymentBackup[]>(
    ["/v1/deployments", deploymentName, "backups"],
    () => api.deployments.backups.list(deploymentName),
    {
      // Export jobs flip the row pending/running → poll on status; a
      // restore is invisible in status → poll while we know one is out.
      refreshInterval: (latest) =>
        restoringId !== null ||
        latest?.some((b) => b.status === "pending" || b.status === "running")
          ? 2000
          : 0,
    },
  );

  // Stop the restore poll once restoredAt moved past the click time.
  useEffect(() => {
    if (!restoringId || !backupsList) return;
    const b = backupsList.find((x) => x.id === restoringId);
    if (b?.restoredAt && (!restoreStartedAt || b.restoredAt >= restoreStartedAt)) {
      setRestoringId(null);
      setRestoreStartedAt(null);
    }
  }, [backupsList, restoringId, restoreStartedAt]);
  // Schedule + retention live on the deployment row.
  const { data: dep, mutate: mutateDep } = useSWR<Deployment>(
    ["/v1/deployments", deploymentName, "for-backups"],
    () => api.deployments.get(deploymentName),
    { revalidateOnFocus: false },
  );

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [schedule, setSchedule] = useState<"none" | "daily" | null>(null);
  const [retention, setRetention] = useState<string | null>(null);

  const effSchedule = schedule ?? dep?.backupSchedule ?? "none";
  const effRetention = retention ?? String(dep?.backupRetention ?? 7);

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
      await mutate();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("Backup action failed"));
    } finally {
      setBusy(false);
    }
  };

  const backupNow = () => run(() => api.deployments.backups.create(deploymentName));

  const restore = async (b: DeploymentBackup) => {
    if (
      !confirm(
        t(
          "Restore this backup? The deployment's CURRENT data is replaced wholesale with the snapshot from {date} — anything written since is lost. This cannot be undone.",
          { date: new Date(b.createTime).toLocaleString() },
        ),
      )
    ) {
      return;
    }
    setRestoringId(b.id);
    setRestoreStartedAt(new Date().toISOString());
    await run(() => api.deployments.backups.restore(deploymentName, b.id));
    // restoringId stays set until the poll sees restoredAt move (effect
    // above) — that's the "Restoring…" signal on the row.
  };

  const remove = async (b: DeploymentBackup) => {
    if (!confirm(t("Delete this backup? The archive is removed from disk. This cannot be undone."))) {
      return;
    }
    await run(() => api.deployments.backups.delete(deploymentName, b.id));
  };

  const download = async (b: DeploymentBackup) => {
    setActionError(null);
    try {
      const blob = await api.deployments.backups.download(deploymentName, b.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${deploymentName}-${b.createTime.slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("Could not download the backup archive"));
    }
  };

  const saveSettings = () =>
    run(async () => {
      await api.deployments.backups.updateSettings(
        deploymentName,
        effSchedule,
        Number(effRetention),
      );
      await mutateDep();
      setSchedule(null);
      setRetention(null);
    });

  return (
    <div className="space-y-3 text-xs" data-testid={`backups-panel-${deploymentName}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-neutral-200">
            <IconArchive className="mr-1.5 inline-block opacity-70" />
            {t("Backups")}
          </span>
          {dep?.backupSchedule === "daily" && (
            <Badge tone="green" data-testid={`backups-daily-${deploymentName}`}>
              {t("daily")}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={backupNow}
            disabled={busy}
            data-testid={`backup-now-${deploymentName}`}
          >
            {t("Back up now")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCollapse}>
            {t("Hide")}
          </Button>
        </div>
      </div>

      <p className="text-[11px] text-neutral-500">
        {t(
          "A backup is a full Convex snapshot export (the same archive `npx convex export` produces), stored on this server. Restore replaces the deployment's data with the snapshot.",
        )}
      </p>

      {actionError && <p className="text-red-400">{actionError}</p>}
      {error && (
        <p className="text-red-400">
          {error instanceof ApiError ? error.message : t("Could not load backups")}
        </p>
      )}
      {isLoading && <p className="text-neutral-500">{t("Loading…")}</p>}

      {backupsList && backupsList.length === 0 && (
        <p className="text-neutral-500" data-testid={`backups-empty-${deploymentName}`}>
          {t("No backups yet.")}
        </p>
      )}

      {backupsList && backupsList.length > 0 && (
        <ul className="divide-y divide-neutral-900 rounded-md border border-neutral-900">
          {backupsList.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <Badge
                tone={
                  b.status === "complete"
                    ? "green"
                    : b.status === "failed"
                      ? "red"
                      : "neutral"
                }
              >
                {b.status}
              </Badge>
              <span className="text-neutral-300">
                {new Date(b.createTime).toLocaleString()}
              </span>
              <span className="text-neutral-500">{humanSize(b.sizeBytes)}</span>
              {!b.requestedBy && <span className="text-neutral-600">{t("(scheduled)")}</span>}
              {b.restoredAt && (
                <span className="text-violet-300" data-testid={`backup-restored-${b.id}`}>
                  {t("restored {date}", { date: new Date(b.restoredAt).toLocaleString() })}
                </span>
              )}
              {b.status === "failed" && b.error && (
                <span className="max-w-[28rem] truncate text-red-400" title={b.error}>
                  {b.error}
                </span>
              )}
              <span className="ml-auto flex shrink-0 gap-1.5">
                {b.status === "complete" && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => download(b)}>
                      {t("Download")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => restore(b)}
                      aria-label={t("Restore backup from {date}", {
                        date: new Date(b.createTime).toLocaleString(),
                      })}
                      data-testid={`backup-restore-${b.id}`}
                    >
                      {restoringId === b.id ? t("Restoring…") : t("Restore")}
                    </Button>
                  </>
                )}
                {(b.status === "complete" || b.status === "failed") && (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() => remove(b)}
                    aria-label={t("Delete backup from {date}", {
                      date: new Date(b.createTime).toLocaleString(),
                    })}
                  >
                    {t("Delete")}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 rounded-md border border-neutral-900 px-3 py-2">
        <div>
          <label
            htmlFor={`backup-schedule-${deploymentName}`}
            className="mb-1 block text-[11px] text-neutral-400"
          >
            {t("Automatic backups")}
          </label>
          <select
            id={`backup-schedule-${deploymentName}`}
            value={effSchedule}
            onChange={(e) => setSchedule(e.target.value as "none" | "daily")}
            className="block h-8 rounded-md border border-neutral-700 bg-neutral-900 px-2 text-xs text-neutral-100 focus:border-neutral-500 focus:outline-none"
          >
            <option value="none">{t("Off")}</option>
            <option value="daily">{t("Daily")}</option>
          </select>
        </div>
        <div>
          <label
            htmlFor={`backup-retention-${deploymentName}`}
            className="mb-1 block text-[11px] text-neutral-400"
          >
            {t("Keep last")}
          </label>
          <Input
            id={`backup-retention-${deploymentName}`}
            type="number"
            min={1}
            max={90}
            value={effRetention}
            onChange={(e) => setRetention(e.target.value)}
            className="h-8 w-20 text-xs"
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={saveSettings}
          data-testid={`backup-settings-save-${deploymentName}`}
        >
          {t("Save")}
        </Button>
        <p className="basis-full text-[11px] text-neutral-500">
          {t("Daily backups run server-side; older complete backups beyond the retention count are pruned automatically.")}
        </p>
      </div>
    </div>
  );
}
