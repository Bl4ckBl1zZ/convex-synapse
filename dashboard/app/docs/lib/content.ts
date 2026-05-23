// Server-side markdown loader + renderer for the docs pages.
//
// Each documentation page is a plain markdown file at
// `app/docs/content/<locale>/<slug>.md` (with `<slug>` empty mapped
// to `index`). We read at request time and feed it through `marked`
// with a custom renderer that emits Tailwind-classed HTML — no MDX,
// no client-side parser, no `prose` typography dep.
//
// `marked` is configured for GitHub-flavoured markdown so tables,
// fenced code blocks, and task lists work out of the box.

import fs from "node:fs/promises";
import path from "node:path";
import { Marked } from "marked";
import type { Locale } from "./nav";

const CONTENT_DIR = path.join(process.cwd(), "app/docs/content");

// One Marked instance, configured once. Each render is a synchronous
// `parse(md)` call so we don't pay for setup per page.
const marked = new Marked({
  gfm: true,
  breaks: false,
  // Hook into the default renderer to add our Tailwind classes
  // without forking the whole pipeline.
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = slugify(stripTags(text));
      const cls = HEADING_CLASS[depth - 1] ?? HEADING_CLASS[5];
      const anchor = depth > 1
        ? `<a href="#${id}" class="anchor-link" aria-label="Link to section">#</a>`
        : "";
      return `<h${depth} id="${id}" class="${cls}">${text}${anchor}</h${depth}>\n`;
    },
    paragraph({ tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<p class="my-4 text-[15px] leading-7 text-neutral-300">${text}</p>\n`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const isExternal = /^https?:\/\//.test(href);
      const attrs = isExternal
        ? ` target="_blank" rel="noopener noreferrer"`
        : "";
      const t = title ? ` title="${escapeAttr(title)}"` : "";
      return `<a href="${escapeAttr(href)}"${t}${attrs} class="text-violet-300 underline decoration-violet-500/40 underline-offset-2 hover:text-violet-200 hover:decoration-violet-400">${text}</a>`;
    },
    code({ text, lang }) {
      // Fenced code block. We don't run a syntax highlighter to
      // keep the dep surface small — the dark theme + mono font
      // is enough signal for the reader.
      const language = lang ? ` data-lang="${escapeAttr(lang)}"` : "";
      return `<pre class="my-5 overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-[13px] leading-6"><code class="font-mono text-neutral-200"${language}>${escapeHtml(text)}</code></pre>\n`;
    },
    codespan({ text }) {
      return `<code class="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[0.92em] text-violet-200">${escapeHtml(text)}</code>`;
    },
    blockquote({ tokens }) {
      const body = this.parser.parse(tokens);
      return `<blockquote class="my-5 border-l-2 border-violet-500/60 bg-violet-500/5 px-4 py-2 text-[15px] text-neutral-300">${body}</blockquote>\n`;
    },
    list({ items, ordered, start }) {
      const tag = ordered ? "ol" : "ul";
      const cls = ordered
        ? "my-4 list-decimal pl-6 text-[15px] leading-7 text-neutral-300 marker:text-neutral-500"
        : "my-4 list-disc pl-6 text-[15px] leading-7 text-neutral-300 marker:text-neutral-500";
      const startAttr = ordered && start && start !== 1 ? ` start="${start}"` : "";
      const body = items.map((item) => this.listitem(item)).join("");
      return `<${tag} class="${cls}"${startAttr}>${body}</${tag}>\n`;
    },
    listitem({ tokens, task, checked }) {
      const body = this.parser.parse(tokens);
      if (task) {
        const box = checked
          ? `<input type="checkbox" checked disabled class="mr-1.5 align-middle accent-violet-500" />`
          : `<input type="checkbox" disabled class="mr-1.5 align-middle" />`;
        return `<li class="my-1 list-none -ml-6">${box}${body}</li>`;
      }
      return `<li class="my-1">${body}</li>`;
    },
    table({ header, rows }) {
      const head = header
        .map(
          (cell) =>
            `<th class="border-b border-neutral-800 px-3 py-2 text-left text-[13px] font-semibold uppercase tracking-wide text-neutral-400">${this.parser.parseInline(cell.tokens)}</th>`,
        )
        .join("");
      const body = rows
        .map(
          (row) =>
            `<tr class="border-b border-neutral-900 last:border-b-0">${row
              .map(
                (cell) =>
                  `<td class="px-3 py-2 align-top text-[14px] text-neutral-300">${this.parser.parseInline(cell.tokens)}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("");
      return `<div class="my-5 overflow-x-auto rounded-lg border border-neutral-800">
<table class="w-full border-collapse"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</div>\n`;
    },
    hr() {
      return `<hr class="my-8 border-neutral-800" />\n`;
    },
  },
});

const HEADING_CLASS = [
  "mb-6 mt-2 text-[32px] font-semibold tracking-tight text-neutral-100", // h1
  "mb-4 mt-10 scroll-mt-20 text-[24px] font-semibold tracking-tight text-neutral-100 group flex items-baseline gap-2", // h2
  "mb-3 mt-8 scroll-mt-20 text-[19px] font-semibold tracking-tight text-neutral-100 group flex items-baseline gap-2", // h3
  "mb-2 mt-6 scroll-mt-20 text-[16px] font-semibold tracking-tight text-neutral-200 group flex items-baseline gap-2", // h4
  "mb-2 mt-4 scroll-mt-20 text-[14px] font-semibold uppercase tracking-wide text-neutral-300", // h5
  "mb-1 mt-3 scroll-mt-20 text-[13px] font-semibold uppercase tracking-wide text-neutral-400", // h6
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// Load a markdown file by locale + slug. Returns `null` if the file
// doesn't exist — caller renders a "missing translation" notice
// instead of crashing.
export async function loadDoc(
  locale: Locale,
  slug: string,
): Promise<{ html: string; raw: string } | null> {
  const fileSlug = slug || "index";
  const file = path.join(CONTENT_DIR, locale, `${fileSlug}.md`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const html = await marked.parse(raw);
  return { html, raw };
}

// For the auto-generated table of contents on long pages: collect
// h2/h3 headings from the source markdown so we can render a sidebar
// outline. Cheap regex scan — markdown headings are simple enough.
export function extractHeadings(raw: string): {
  level: 2 | 3;
  text: string;
  id: string;
}[] {
  const out: { level: 2 | 3; text: string; id: string }[] = [];
  const lines = raw.split("\n");
  let inCodeFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (!m) continue;
    const level = m[1].length === 2 ? 2 : 3;
    const text = m[2].replace(/[`*_]/g, "");
    out.push({ level, text, id: slugify(text) });
  }
  return out;
}
