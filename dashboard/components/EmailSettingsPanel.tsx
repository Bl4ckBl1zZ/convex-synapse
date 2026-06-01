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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, type EmailSettings } from "@/lib/api";
import { useT } from "@/lib/i18n";

const RESEND_KEYS_URL = "https://resend.com/api-keys";

// EmailSettingsPanel — instance-admin surface for the transactional-email
// provider (Resend) that powers team-invite emails. The API key is stored
// encrypted at rest and never echoed back; this panel only reflects whether
// a sender is configured and where it came from (this dashboard, the host
// .env, or nowhere). Auth: /admin/layout.tsx enforces is_instance_admin and
// the backend re-checks.
export function EmailSettingsPanel() {
  const { t } = useT();
  const { data, error, isLoading, mutate } = useSWR<EmailSettings>(
    "/v1/admin/email_settings",
    () => api.admin.emailSettings.get(),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const [apiKey, setApiKey] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!apiKey.trim() || !fromAddress.trim()) return;
    setSaving(true);
    try {
      await api.admin.emailSettings.set(apiKey.trim(), fromAddress.trim());
      setApiKey("");
      await mutate();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : t("Could not save email settings"),
      );
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setFormError(null);
    setSaving(true);
    try {
      await api.admin.emailSettings.clear();
      await mutate();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : t("Could not clear email settings"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="email-settings-panel">
      <Card>
        <CardHeader>
          <CardTitle>{t("Email (Resend)")}</CardTitle>
          <CardDescription>
            {t(
              "Configure Resend so team invites are emailed a clickable accept link. The API key is encrypted at rest and never shown again. Leave unset to keep invites link-only — the accept link is still returned in the dashboard.",
            )}
          </CardDescription>
        </CardHeader>
        <CardBody className="space-y-4">
          {isLoading && <Skeleton className="h-4 w-1/3" />}

          {error && (
            <p className="text-xs text-red-400" data-testid="email-settings-load-error">
              {error instanceof ApiError
                ? error.message
                : t("Could not load email settings")}
            </p>
          )}

          {!isLoading && data && (
            <div
              className="flex flex-wrap items-center gap-2 text-xs"
              data-testid="email-settings-status"
            >
              {data.configured ? (
                <>
                  <Badge tone="green">{t("Configured")}</Badge>
                  <span className="text-neutral-400">
                    {data.source === "env"
                      ? t("via host .env (SYNAPSE_RESEND_API_KEY)")
                      : `${t("From:")} ${data.fromAddress}`}
                  </span>
                </>
              ) : (
                <Badge tone="neutral">{t("Not configured")}</Badge>
              )}
            </div>
          )}

          <form onSubmit={save} className="space-y-3" data-testid="email-settings-form">
            <div>
              <label
                className="mb-1 block text-xs text-neutral-400"
                htmlFor="resend-api-key"
              >
                {t("Resend API key")}
              </label>
              <Input
                id="resend-api-key"
                type="password"
                placeholder="re_..."
                value={apiKey}
                autoComplete="off"
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-neutral-500">
                {t("Create one at")}{" "}
                <a
                  href={RESEND_KEYS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-violet-300 underline"
                >
                  resend.com/api-keys
                </a>
                {`. ${t("Requires a verified sending domain.")}`}
              </p>
            </div>
            <div>
              <label
                className="mb-1 block text-xs text-neutral-400"
                htmlFor="email-from"
              >
                {t("From address")}
              </label>
              <Input
                id="email-from"
                placeholder="Synapse <no-reply@yourdomain.com>"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
              />
            </div>

            {formError && <p className="text-xs text-red-400">{formError}</p>}

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={saving} data-testid="email-settings-save">
                {data?.configured ? t("Update") : t("Save")}
              </Button>
              {data?.source === "db" && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={saving}
                  onClick={clear}
                  data-testid="email-settings-clear"
                >
                  {t("Clear")}
                </Button>
              )}
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
