"use client";

// Client-side i18n provider + hooks. Mounted once in the root layout with
// the locale resolved server-side (cookie → Accept-Language → default), so
// the very first paint already shows the right language with no flash.
//
// Usage in any "use client" component:
//
//   import { useT } from "@/lib/i18n";
//   const { t } = useT();
//   <button>{t("Save changes")}</button>
//   <p>{t("{count} deployments", { count })}</p>
//
// `t(en, params?)` looks the English source up in the active dictionary and
// falls back to the English source itself when no translation exists.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ptBR } from "./dictionary.pt-BR";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  htmlLang,
  type Locale,
} from "./locale";

export type { Locale } from "./locale";
export {
  LOCALES,
  LOCALE_LABEL,
  LOCALE_SHORT,
  DEFAULT_LOCALE,
} from "./locale";

// Interpolation params tolerate optional values — many call sites pass a
// field that may be undefined (e.g. a version not yet fetched). Nullish
// values render as an empty string rather than the literal "undefined".
type TParams = Record<string, string | number | undefined | null>;
export type TFunction = (en: string, params?: TParams) => string;

// English needs no dictionary — the key IS the value, so we return it
// verbatim. pt-BR maps through the generated dictionary.
const DICTIONARIES: Record<Locale, Record<string, string>> = {
  en: {},
  "pt-BR": ptBR,
};

// Fill `{token}` placeholders from params. Unknown tokens are left intact
// (so a copy bug is visible rather than silently dropped).
function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return whole;
    const value = params[key];
    return value == null ? "" : String(value);
  });
}

function translate(locale: Locale, en: string, params?: TParams): string {
  const dict = DICTIONARIES[locale];
  const resolved = (dict && dict[en]) || en;
  return interpolate(resolved, params);
}

type I18nContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: TFunction;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    // Persist the explicit choice for SSR (cookie, read by the root layout)
    // and for resilience (localStorage). max-age ≈ 1 year.
    try {
      document.cookie = `${LOCALE_COOKIE}=${next};path=/;max-age=31536000;samesite=lax`;
    } catch {
      /* document unavailable — ignore */
    }
    try {
      window.localStorage.setItem(LOCALE_COOKIE, next);
    } catch {
      /* storage blocked — ignore */
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = htmlLang(next);
    }
  }, []);

  const t = useCallback<TFunction>(
    (en, params) => translate(locale, en, params),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// Primary hook: returns { locale, setLocale, t }. Safe to call outside a
// provider — falls back to an identity translator (renders English) so a
// stray render never crashes.
export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  return {
    locale: DEFAULT_LOCALE,
    setLocale: () => {},
    t: (en, params) => interpolate(en, params),
  };
}

// Convenience for components that only need the locale (e.g. date/number
// formatting) without the translator.
export function useLocale(): Locale {
  return useT().locale;
}
