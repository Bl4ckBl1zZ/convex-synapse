// Server-side locale resolution for the root layout. Reads the explicit
// cookie choice first, then sniffs Accept-Language, then falls back to the
// default. Returning the locale at render time (not on the client after
// mount) means the first paint already shows the right language — no flash
// of English before switching to Portuguese.
//
// Server-only: imports next/headers. Never import this from a client
// component.

import { cookies, headers } from "next/headers";
import { type Locale, LOCALE_COOKIE, normalizeLocale } from "./locale";

export async function resolveServerLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (fromCookie) return normalizeLocale(fromCookie);

  // No explicit choice yet — honour the browser's preference. The first
  // Accept-Language token wins (e.g. "pt-BR,pt;q=0.9,en;q=0.8" → pt-BR).
  const headerStore = await headers();
  const acceptLanguage = headerStore.get("accept-language") ?? "";
  const first = acceptLanguage.split(",")[0]?.trim() ?? "";
  return normalizeLocale(first);
}
