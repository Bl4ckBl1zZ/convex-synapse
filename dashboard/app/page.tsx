"use client";

// Tiny client-side gate. We can't use server cookies because auth lives
// in localStorage, so just bounce here once mounted.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getAccessToken } from "@/lib/auth";
import { useT } from "@/lib/i18n";

export default function RootPage() {
  const { t } = useT();
  const router = useRouter();
  useEffect(() => {
    router.replace(getAccessToken() ? "/teams" : "/login");
  }, [router]);
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-neutral-500">
      {t("Loading...")}
    </div>
  );
}
