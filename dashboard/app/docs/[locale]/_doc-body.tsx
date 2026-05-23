import Link from "next/link";
import { extractHeadings } from "../lib/content";
import { neighbours, pageHref, type Locale } from "../lib/nav";

const STRINGS = {
  en: {
    missing: "This page hasn't been translated yet.",
    missingBody:
      "We're still writing this page in English. In the meantime, switch to Portuguese (BR) from the sidebar — it may already cover what you need.",
    onThisPage: "On this page",
    prev: "Previous",
    next: "Next",
    editOnGitHub: "Edit on GitHub",
  },
  "pt-BR": {
    missing: "Esta página ainda não foi traduzida.",
    missingBody:
      "Ainda estamos escrevendo essa página em português. Por enquanto, troque pra English na barra lateral — pode ser que cubra o que você precisa.",
    onThisPage: "Nesta página",
    prev: "Anterior",
    next: "Próximo",
    editOnGitHub: "Editar no GitHub",
  },
} satisfies Record<Locale, Record<string, string>>;

export function DocBody({
  locale,
  slug,
  doc,
  title,
}: {
  locale: Locale;
  slug: string;
  doc: { html: string; raw: string } | null;
  title: string;
}) {
  const t = STRINGS[locale];
  const { prev, next } = neighbours(slug);
  const headings = doc ? extractHeadings(doc.raw) : [];
  const fileName = slug
    ? `${slug}.${locale}.md`
    : `index.${locale}.md`;
  const editUrl = `https://github.com/Iann29/convex-synapse/edit/main/dashboard/app/docs/content/${locale}/${slug || "index"}.md`;

  if (!doc) {
    return (
      <article className="max-w-3xl">
        <h1 className="mb-6 text-[32px] font-semibold tracking-tight text-neutral-100">
          {title}
        </h1>
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-5">
          <p className="text-[15px] font-medium text-yellow-200">{t.missing}</p>
          <p className="mt-2 text-[14px] leading-6 text-yellow-100/80">
            {t.missingBody}
          </p>
          <p className="mt-3 text-[13px] text-neutral-400">
            <a
              href={editUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-300 hover:text-violet-200"
            >
              {t.editOnGitHub} · {fileName}
            </a>
          </p>
        </div>
        <PrevNext locale={locale} prev={prev} next={next} labels={t} />
      </article>
    );
  }

  return (
    <div className="flex gap-10">
      <article className="min-w-0 max-w-3xl flex-1">
        <div
          className="docs-body"
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />
        <div className="mt-10 flex items-center justify-between border-t border-neutral-900 pt-4 text-[13px]">
          <a
            href={editUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-500 hover:text-neutral-300"
          >
            {t.editOnGitHub}
          </a>
        </div>
        <PrevNext locale={locale} prev={prev} next={next} labels={t} />
      </article>
      {headings.length > 1 && (
        <aside className="sticky top-20 hidden h-fit w-56 shrink-0 xl:block">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            {t.onThisPage}
          </h3>
          <ul className="space-y-1 border-l border-neutral-800">
            {headings.map((h) => (
              <li key={h.id}>
                <a
                  href={`#${h.id}`}
                  className={
                    "block border-l border-transparent pl-3 text-[13px] text-neutral-400 hover:border-violet-400 hover:text-violet-200 -ml-px" +
                    (h.level === 3 ? " pl-6 text-neutral-500" : "")
                  }
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}

function PrevNext({
  locale,
  prev,
  next,
  labels,
}: {
  locale: Locale;
  prev: { slug: string; title: Record<Locale, string> } | null;
  next: { slug: string; title: Record<Locale, string> } | null;
  labels: (typeof STRINGS)[Locale];
}) {
  if (!prev && !next) return null;
  return (
    <nav
      aria-label="Page navigation"
      className="mt-8 grid grid-cols-2 gap-4"
    >
      {prev ? (
        <Link
          href={pageHref(locale, prev.slug)}
          className="rounded-lg border border-neutral-800 p-4 transition-colors hover:border-violet-500/50 hover:bg-neutral-900"
        >
          <p className="text-[11px] uppercase tracking-wide text-neutral-500">
            ← {labels.prev}
          </p>
          <p className="mt-1 text-[14px] font-medium text-neutral-200">
            {prev.title[locale]}
          </p>
        </Link>
      ) : (
        <div />
      )}
      {next ? (
        <Link
          href={pageHref(locale, next.slug)}
          className="rounded-lg border border-neutral-800 p-4 text-right transition-colors hover:border-violet-500/50 hover:bg-neutral-900"
        >
          <p className="text-[11px] uppercase tracking-wide text-neutral-500">
            {labels.next} →
          </p>
          <p className="mt-1 text-[14px] font-medium text-neutral-200">
            {next.title[locale]}
          </p>
        </Link>
      ) : (
        <div />
      )}
    </nav>
  );
}
