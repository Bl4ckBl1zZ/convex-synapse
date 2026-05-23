import { notFound } from "next/navigation";
import { loadDoc } from "../../lib/content";
import { findPage, isLocale, SECTIONS } from "../../lib/nav";
import { DocBody } from "../_doc-body";

export default async function DocsContentPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string[] }>;
}) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();

  // The route is /docs/<locale>/<single-slug> — we don't support
  // nested slugs yet (every page is at the top of its locale tree).
  if (slug.length !== 1) notFound();
  const pageSlug = slug[0];
  const entry = findPage(pageSlug);
  if (!entry) notFound();

  const doc = await loadDoc(locale, pageSlug);
  return (
    <DocBody
      locale={locale}
      slug={pageSlug}
      doc={doc}
      title={entry.page.title[locale]}
    />
  );
}

export async function generateStaticParams() {
  const params: { locale: string; slug: string[] }[] = [];
  for (const locale of ["en", "pt-BR"] as const) {
    for (const section of SECTIONS) {
      for (const page of section.pages) {
        if (!page.slug) continue;
        params.push({ locale, slug: [page.slug] });
      }
    }
  }
  return params;
}
