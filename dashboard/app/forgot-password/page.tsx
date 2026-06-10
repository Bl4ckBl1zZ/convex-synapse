"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Forgot-password (v1.26+). Submits the email and ALWAYS lands on the same
// "check your inbox" state — the API never reveals whether the account
// exists, and neither do we. The emailed link points at /reset-password.
export default function ForgotPasswordPage() {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      await api.forgotPassword(email.trim());
    } catch {
      // Same outcome on error — no oracle, and the generic message below
      // already tells the user what to do if nothing arrives.
    } finally {
      setPending(false);
      setSent(true);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <LocaleSwitcher variant="pill" className="fixed right-4 top-4 z-50" />
      {sent ? (
        <div
          className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-6"
          data-testid="forgot-password-sent"
        >
          <h1 className="text-lg font-semibold">{t("Check your inbox")}</h1>
          <p className="text-xs leading-relaxed text-neutral-400">
            {t(
              "If an account exists for that email — and this Synapse instance has email configured — a reset link is on its way. It works once and expires in 1 hour.",
            )}
          </p>
          <p className="text-xs leading-relaxed text-neutral-500">
            {t(
              "Nothing arriving? Ask your instance admin — email may not be configured, in which case they can reset your password manually.",
            )}
          </p>
          <p className="text-center text-xs text-neutral-500">
            <Link href="/login" className="text-neutral-200 hover:underline">
              {t("Back to sign in")}
            </Link>
          </p>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-6"
          data-testid="forgot-password-form"
        >
          <div>
            <h1 className="text-lg font-semibold">{t("Reset your password")}</h1>
            <p className="mt-1 text-xs text-neutral-400">
              {t("Enter your account email and we'll send a reset link.")}
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="forgot-email" className="block text-xs text-neutral-400">
              {t("Email")}
            </label>
            <Input
              id="forgot-email"
              type="email"
              value={email}
              autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? t("Sending…") : t("Send reset link")}
          </Button>
          <p className="text-center text-xs text-neutral-500">
            <Link href="/login" className="text-neutral-200 hover:underline">
              {t("Back to sign in")}
            </Link>
          </p>
        </form>
      )}
    </main>
  );
}
