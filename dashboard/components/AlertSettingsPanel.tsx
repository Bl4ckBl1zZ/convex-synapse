"use client";

import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, type AlertSettings } from "@/lib/api";
import { useT } from "@/lib/i18n";

// AlertSettingsPanel — instance-admin surface for deployment-down alerts.
// Two channels: email to team admins (rides the Email/Resend settings — if
// email isn't configured there, no alert emails go out) and a generic
// webhook (Slack / Discord / custom JSON receivers). The full webhook URL
// embeds the receiver's secret, so the server only ever returns a masked
// hint; the input below is always blank and "leave blank" means "keep".
// Auth: /admin/layout.tsx enforces is_instance_admin and the backend
// re-checks.
export function AlertSettingsPanel() {
  const { t } = useT();
  const { data, error, isLoading, mutate } = useSWR<AlertSettings>(
    "/v1/admin/alert_settings",
    () => api.admin.alertSettings.get(),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const [emailEnabled, setEmailEnabled] = useState(true);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Mirror the loaded toggle once data lands (the webhook input stays
  // blank by design — see the header comment).
  useEffect(() => {
    if (data) setEmailEnabled(data.emailEnabled);
  }, [data]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      // Blank input = keep the saved webhook (undefined omits the field);
      // removal goes through the explicit "Remove webhook" button.
      const url = webhookUrl.trim();
      await api.admin.alertSettings.set(emailEnabled, url === "" ? undefined : url);
      setWebhookUrl("");
      await mutate();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : t("Could not save alert settings"),
      );
    } finally {
      setSaving(false);
    }
  };

  const removeWebhook = async () => {
    if (
      !window.confirm(
        t("Remove the alert webhook? Deployment-down alerts will no longer be posted to it."),
      )
    ) {
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      await api.admin.alertSettings.set(emailEnabled, "");
      await mutate();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : t("Could not save alert settings"),
      );
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (
      !window.confirm(
        t(
          "Reset alert settings to defaults? Email alerts turn back on and the webhook reverts to the host .env (SYNAPSE_ALERT_WEBHOOK_URL), if set.",
        ),
      )
    ) {
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      await api.admin.alertSettings.clear();
      setWebhookUrl("");
      await mutate();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : t("Could not reset alert settings"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="alert-settings-panel">
      <Card>
        <CardHeader>
          <CardTitle>{t("Deployment alerts")}</CardTitle>
          <CardDescription>
            {t(
              "Get notified when a deployment goes down (stopped or failed). Email goes to the admins of the team that owns the deployment and requires the Email settings to be configured; the webhook accepts Slack and Discord URLs out of the box, or any endpoint that takes a JSON POST.",
            )}
          </CardDescription>
        </CardHeader>
        <CardBody className="space-y-4">
          {isLoading && <Skeleton className="h-4 w-1/3" />}

          {error && (
            <p className="text-xs text-red-400" data-testid="alert-settings-load-error">
              {error instanceof ApiError
                ? error.message
                : t("Could not load alert settings")}
            </p>
          )}

          {!isLoading && data && (
            <div
              className="flex flex-wrap items-center gap-2 text-xs"
              data-testid="alert-settings-status"
            >
              {data.emailEnabled ? (
                <Badge tone="green">{t("Email alerts on")}</Badge>
              ) : (
                <Badge tone="neutral">{t("Email alerts off")}</Badge>
              )}
              {data.webhookConfigured ? (
                <>
                  <Badge tone="green">{t("Webhook configured")}</Badge>
                  <span className="text-neutral-400" data-testid="alert-settings-webhook-hint">
                    {data.webhookHint}
                  </span>
                </>
              ) : (
                <Badge tone="neutral">{t("No webhook")}</Badge>
              )}
              {data.source === "env" && (
                <span className="text-neutral-500">
                  {t("via host .env (SYNAPSE_ALERT_WEBHOOK_URL)")}
                </span>
              )}
            </div>
          )}

          <form onSubmit={save} className="space-y-3" data-testid="alert-settings-form">
            <label
              className="flex items-start gap-2 text-sm text-neutral-300"
              htmlFor="alert-email-enabled"
            >
              <input
                id="alert-email-enabled"
                type="checkbox"
                checked={emailEnabled}
                onChange={(e) => setEmailEnabled(e.target.checked)}
                className="mt-1 h-3.5 w-3.5 rounded border-neutral-700 bg-neutral-950 text-violet-500"
              />
              <span>{t("Email team admins when a deployment goes down")}</span>
            </label>

            <div>
              <label
                className="mb-1 block text-xs text-neutral-400"
                htmlFor="alert-webhook-url"
              >
                {t("Webhook URL")}
              </label>
              <Input
                id="alert-webhook-url"
                placeholder={
                  data?.webhookConfigured
                    ? t("Leave blank to keep the current webhook")
                    : "https://hooks.slack.com/services/…"
                }
                value={webhookUrl}
                autoComplete="off"
                onChange={(e) => setWebhookUrl(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-neutral-500">
                {t(
                  "Slack incoming webhooks and Discord webhook URLs work as-is. The URL is stored server-side and never shown again — only the host is echoed back.",
                )}
              </p>
            </div>

            {formError && <p className="text-xs text-red-400">{formError}</p>}

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={saving} data-testid="alert-settings-save">
                {t("Save")}
              </Button>
              {data?.webhookConfigured && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={saving}
                  onClick={removeWebhook}
                  data-testid="alert-settings-remove-webhook"
                >
                  {t("Remove webhook")}
                </Button>
              )}
              {data?.source === "db" && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={saving}
                  onClick={reset}
                  data-testid="alert-settings-clear"
                >
                  {t("Reset to defaults")}
                </Button>
              )}
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
