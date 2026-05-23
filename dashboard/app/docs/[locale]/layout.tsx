import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { TopBar } from "@/components/TopBar";
import {
  isLocale,
  LOCALE_LABEL,
  LOCALES,
  pageHref,
  SECTIONS,
  type Locale,
} from "../lib/nav";
import { ActiveLink } from "./_active-link";

export default async function DocsLocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <TopBar />
      <div className="mx-auto flex max-w-7xl gap-8 px-4 py-8 sm:px-6">
        <Sidebar locale={locale} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function Sidebar({ locale }: { locale: Locale }) {
  return (
    <aside className="sticky top-20 hidden h-[calc(100vh-6rem)] w-64 shrink-0 overflow-y-auto pr-4 lg:block">
      <LocaleSwitcher current={locale} />
      <nav aria-label="Docs">
        {SECTIONS.map((section) => (
          <div key={section.title.en} className="mt-6 first:mt-0">
            <h2 className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              {section.title[locale]}
            </h2>
            <ul className="space-y-0.5">
              {section.pages.map((page) => (
                <li key={page.slug || "_overview"}>
                  <ActiveLink
                    href={pageHref(locale, page.slug)}
                    className="block rounded-md px-2 py-1.5 text-[13px] text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-neutral-200"
                    activeClassName="bg-violet-500/10 text-violet-200 hover:bg-violet-500/10 hover:text-violet-200"
                  >
                    {page.title[locale]}
                  </ActiveLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

function LocaleSwitcher({ current }: { current: Locale }) {
  return (
    <div
      role="group"
      aria-label="Language"
      className="mb-6 flex rounded-md border border-neutral-800 p-0.5"
    >
      {LOCALES.map((loc) => (
        <Link
          key={loc}
          href={pageHref(loc, "")}
          className={
            loc === current
              ? "flex-1 rounded px-2 py-1 text-center text-xs font-medium bg-violet-500/15 text-violet-200"
              : "flex-1 rounded px-2 py-1 text-center text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
          }
        >
          {LOCALE_LABEL[loc]}
        </Link>
      ))}
    </div>
  );
}
