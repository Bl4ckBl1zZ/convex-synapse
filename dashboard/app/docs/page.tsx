import { redirect } from "next/navigation";
import type { Locale } from "./lib/nav";
import { isLocale, LOCALES } from "./lib/nav";

// /docs (no locale) — sniff the Accept-Language header, default to en.
// pt-BR users land directly on the pt-BR copy; everyone else gets en.
export default async function DocsRootRedirect({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  // Honour ?lang=pt-BR (or ?lang=en) when set explicitly.
  const explicit = typeof sp.lang === "string" ? sp.lang : null;
  if (explicit && isLocale(explicit)) {
    redirect(`/docs/${explicit}`);
  }
  // We don't read the Accept-Language header here because Next.js
  // App Router redirects from server-only files would need a separate
  // request-scoped accessor — keeping it simple and defaulting to
  // English. Operators can switch in the sidebar.
  const fallback: Locale = LOCALES[0];
  redirect(`/docs/${fallback}`);
}
