"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Reset-password (v1.25+) — the page the emailed link lands on. Reads
// ?token=, asks for the new password twice, and on success points back at
// /login (the reset also invalidated refresh tokens from before the
// change, so any old session has to sign in again anyway).
//
// useSearchParams() requires a Suspense boundary for the static prerender
// — same pattern as /login.
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const { t } = useT();
  const search = useSearchParams();
  const token = search.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError(t("Passwords don't match"));
      return;
    }
    setPending(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Could not reset password"));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <LocaleSwitcher variant="pill" className="fixed right-4 top-4 z-50" />
      {done ? (
        <div
          className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-6"
          data-testid="reset-password-done"
        >
          <h1 className="text-lg font-semibold">{t("Password updated")}</h1>
          <p className="text-xs leading-relaxed text-neutral-400">
            {t("Your password was changed. Sign in with the new one — older sessions were signed out.")}
          </p>
          <Link
            href="/login"
            data-testid="reset-password-signin"
            className="inline-flex h-9 w-full items-center justify-center rounded-md bg-violet-500 px-3.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-violet-400"
          >
            {t("Sign in")}
          </Link>
        </div>
      ) : !token ? (
        <div
          className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-6"
          data-testid="reset-password-missing-token"
        >
          <h1 className="text-lg font-semibold">{t("Missing reset token")}</h1>
          <p className="text-xs leading-relaxed text-neutral-400">
            {t("This page only works from the link in a reset email. Request a new one below.")}
          </p>
          <p className="text-center text-xs text-neutral-500">
            <Link href="/forgot-password" className="text-neutral-200 hover:underline">
              {t("Request a reset link")}
            </Link>
          </p>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-6"
          data-testid="reset-password-form"
        >
          <div>
            <h1 className="text-lg font-semibold">{t("Choose a new password")}</h1>
            <p className="mt-1 text-xs text-neutral-400">
              {t("The reset link works once and expires in 1 hour.")}
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="reset-password" className="block text-xs text-neutral-400">
              {t("New password")}
            </label>
            <Input
              id="reset-password"
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="reset-password-confirm" className="block text-xs text-neutral-400">
              {t("Confirm new password")}
            </label>
            <Input
              id="reset-password-confirm"
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
            />
          </div>
          {error && (
            <p className="text-xs text-red-400" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? t("Saving…") : t("Set new password")}
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
