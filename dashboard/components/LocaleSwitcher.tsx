"use client";

// Language switcher — a compact EN | PT segmented control. Reads/writes the
// active locale through the i18n provider, which persists the choice to a
// cookie (so SSR picks it up next load) and localStorage.
//
// Placed in the TopBar (authenticated pages) and as a floating pill on the
// auth/setup pages, which render outside the TopBar.

import clsx from "clsx";
import { LOCALES, LOCALE_SHORT, LOCALE_LABEL, useT } from "@/lib/i18n";

export function LocaleSwitcher({
  className,
  variant = "inline",
}: {
  className?: string;
  variant?: "inline" | "pill";
}) {
  const { locale, setLocale, t } = useT();

  return (
    <div
      role="group"
      aria-label={t("Language")}
      data-testid="locale-switcher"
      className={clsx(
        "inline-flex items-center rounded-md border border-neutral-800 p-0.5 text-xs",
        variant === "pill" && "bg-neutral-900/70 backdrop-blur",
        className,
      )}
    >
      {LOCALES.map((loc) => {
        const active = loc === locale;
        return (
          <button
            key={loc}
            type="button"
            onClick={() => setLocale(loc)}
            aria-pressed={active}
            title={LOCALE_LABEL[loc]}
            data-testid={`locale-option-${loc}`}
            className={clsx(
              "rounded px-2 py-0.5 font-medium transition-colors",
              active
                ? "bg-violet-500/15 text-violet-200"
                : "text-neutral-400 hover:text-neutral-200",
            )}
          >
            {LOCALE_SHORT[loc]}
          </button>
        );
      })}
    </div>
  );
}
