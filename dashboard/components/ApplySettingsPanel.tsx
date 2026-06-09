"use client";

import { useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, type ApplySettings } from "@/lib/api";
import { useT } from "@/lib/i18n";

// ApplySettingsPanel — instance-admin toggle for Cell Control Plane APPLY
// (Bloco 10). Apply is OFF by default; flipping it on lets the control plane
// CREATE/RESTART deployments to match desired state (central-driven — the
// agent never mutates). The DB value wins over the .env default and takes
// effect without restarting the api. Auth: /admin/layout.tsx enforces
// is_instance_admin and the backend re-checks.
export function ApplySettingsPanel() {
  const { t } = useT();
  const { data, error, isLoading, mutate } = useSWR<ApplySettings>(
    "/v1/admin/apply_settings",
    () => api.admin.applySettings.get(),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    if (
      next &&
      !window.confirm(
        t(
          "Enable apply? With it on, the control plane can create/restart deployments on their hosts to match desired state — a real change. The agent still never mutates; dangerous actions (stop/remove) stay disabled.",
        ),
      )
    ) {
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await api.admin.applySettings.set(next, data?.dangerous ?? false);
      await mutate(res, { revalidate: false });
    } catch (e) {
      setFormError(
        e instanceof ApiError ? e.message : t("Failed to save — please try again."),
      );
    } finally {
      setSaving(false);
    }
  };

  const enabled = data?.enabled ?? false;

  return (
    <Card data-testid="apply-settings-panel">
      <CardHeader>
        <CardTitle>{t("Reconcile apply")}</CardTitle>
        <CardDescription>
          {t(
            "Let the Cell Control Plane apply its reconcile plans — create a missing deployment's container or restart a stopped one to match desired state. Central-driven: the agent never mutates.",
          )}
        </CardDescription>
      </CardHeader>
      <CardBody className="space-y-4">
        {isLoading && !data && <Skeleton className="h-8 w-48" />}

        {error instanceof ApiError && error.status !== 401 && error.status !== 403 && (
          <p className="text-xs text-red-400" data-testid="apply-settings-load-error">
            {error.status === 404
              ? t("Apply settings are not available on this instance.")
              : t("Failed to load: {message}", { message: error.message })}
          </p>
        )}

        {data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-neutral-300">{t("Status")}:</span>
              <Badge tone={enabled ? "green" : "neutral"} data-testid="apply-status">
                {enabled ? t("enabled") : t("disabled")}
              </Badge>
              <Badge tone="neutral" data-testid="apply-source">
                {data.source === "db" ? t("via dashboard") : t("via .env default")}
              </Badge>
              {data.updatedAt && (
                <span className="text-[11px] text-neutral-500">
                  {t("updated {when}", { when: new Date(data.updatedAt).toLocaleString() })}
                </span>
              )}
            </div>

            <p className="text-[11px] text-neutral-500">
              {enabled
                ? t("Apply is ON. An Apply button appears on the State & Drift dry-run plan for project admins.")
                : t("Apply is OFF. The control plane stays observe + plan only — no Apply button anywhere.")}
            </p>

            {formError && (
              <p className="text-xs text-red-300" data-testid="apply-settings-error">
                {formError}
              </p>
            )}

            <Button
              size="sm"
              variant={enabled ? "outline" : undefined}
              onClick={() => toggle(!enabled)}
              disabled={saving}
              data-testid="apply-toggle"
            >
              {saving
                ? t("Saving…")
                : enabled
                  ? t("Disable apply")
                  : t("Enable apply")}
            </Button>
          </>
        )}
      </CardBody>
    </Card>
  );
}
