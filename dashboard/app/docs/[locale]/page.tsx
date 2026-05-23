import { notFound } from "next/navigation";
import { loadDoc } from "../lib/content";
import { isLocale } from "../lib/nav";
import { DocBody } from "./_doc-body";

// /docs/<locale> — the overview page. Renders content/<locale>/index.md.
export default async function DocsLocaleIndex({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const doc = await loadDoc(locale, "");
  return (
    <DocBody locale={locale} slug="" doc={doc} title="Overview" />
  );
}

export async function generateStaticParams() {
  return [{ locale: "en" }, { locale: "pt-BR" }];
}
