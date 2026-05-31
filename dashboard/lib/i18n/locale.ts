// i18n core types + constants. Importable from both server and client
// (no React, no "use client") so the root layout can resolve a locale
// server-side and the client provider can share the same definitions.
//
// We deliberately avoid a heavy i18n dependency (next-intl / react-i18next).
// The dashboard uses the "English-as-key" model: the literal English UI
// string is the lookup key AND the fallback. A PT-BR dictionary maps those
// English strings to Portuguese; anything missing renders the English
// source, so the UI is never blank. Mirrors the lightweight approach the
// docs (`app/docs/lib/nav.ts`) already use.

export type Locale = "en" | "pt-BR";

export const LOCALES: Locale[] = ["en", "pt-BR"];

export const DEFAULT_LOCALE: Locale = "en";

// Display labels for the language switcher.
export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  "pt-BR": "Português",
};

// Short labels for compact toggles.
export const LOCALE_SHORT: Record<Locale, string> = {
  en: "EN",
  "pt-BR": "PT",
};

// Cookie + localStorage key holding the operator's explicit choice. Read
// server-side (root layout) to render the right copy on the first paint
// without a flash, and client-side to persist across sessions.
export const LOCALE_COOKIE = "synapse_locale";

// Maps a Locale to a valid BCP-47 value for the <html lang> attribute.
export function htmlLang(locale: Locale): string {
  return locale === "pt-BR" ? "pt-BR" : "en";
}

// Coerce any raw string (cookie value, Accept-Language token, query param)
// into a supported Locale. Portuguese in any region maps to pt-BR; every
// other input falls back to English. Empty/undefined → DEFAULT_LOCALE.
export function normalizeLocale(raw: string | undefined | null): Locale {
  if (!raw) return DEFAULT_LOCALE;
  const v = raw.trim().toLowerCase();
  if (v === "pt-br" || v === "pt" || v.startsWith("pt-") || v.startsWith("pt_")) {
    return "pt-BR";
  }
  return "en";
}
