// Single source of truth for the docs sidebar + page metadata.
//
// `slug` is the URL segment and the markdown filename stem
// (`getting-started.en.md` lives at `/docs/en/getting-started`).
// `title` and `description` are duplicated per locale so we can
// avoid pulling a heavier i18n lib for what is, at most, ~16
// strings per language.

export type Locale = "en" | "pt-BR";

export const LOCALES: Locale[] = ["en", "pt-BR"];

export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  "pt-BR": "Português (BR)",
};

export type DocPage = {
  slug: string;
  title: Record<Locale, string>;
  description?: Record<Locale, string>;
};

export type DocSection = {
  title: Record<Locale, string>;
  pages: DocPage[];
};

// The TOC. Order here is the order shown in the sidebar.
export const SECTIONS: DocSection[] = [
  {
    title: { en: "Introduction", "pt-BR": "Introdução" },
    pages: [
      {
        slug: "",
        title: { en: "Overview", "pt-BR": "Visão geral" },
      },
      {
        slug: "getting-started",
        title: { en: "Getting started", "pt-BR": "Primeiros passos" },
      },
      {
        slug: "architecture",
        title: { en: "Architecture", "pt-BR": "Arquitetura" },
      },
      {
        slug: "self-hosted-vs-cloud",
        title: { en: "Self-hosted vs Cloud", "pt-BR": "Self-hosted vs Cloud" },
      },
    ],
  },
  {
    title: { en: "Identity", "pt-BR": "Identidade" },
    pages: [
      {
        slug: "auth-and-access",
        title: { en: "Auth & access", "pt-BR": "Auth & acesso" },
      },
      {
        slug: "teams-and-projects",
        title: { en: "Teams & projects", "pt-BR": "Times & projetos" },
      },
    ],
  },
  {
    title: { en: "Resources", "pt-BR": "Recursos" },
    pages: [
      {
        slug: "deployments",
        title: { en: "Deployments", "pt-BR": "Deployments" },
      },
      {
        slug: "env-vars",
        title: { en: "Environment variables", "pt-BR": "Variáveis de ambiente" },
      },
      {
        slug: "custom-domains",
        title: { en: "Custom domains", "pt-BR": "Domínios customizados" },
      },
      {
        slug: "deploy-keys",
        title: { en: "Deploy keys", "pt-BR": "Deploy keys" },
      },
      {
        slug: "deployment-backups",
        title: { en: "Backups", "pt-BR": "Backups" },
      },
      {
        slug: "resource-limits",
        title: {
          en: "CPU/RAM limits",
          "pt-BR": "Limites de CPU/RAM",
        },
      },
      {
        slug: "convex-dashboard-integration",
        title: {
          en: "Convex Dashboard integration",
          "pt-BR": "Integração com o Convex Dashboard",
        },
      },
    ],
  },
  {
    title: { en: "Cell Control Plane", "pt-BR": "Cell Control Plane" },
    pages: [
      {
        slug: "cell-control-plane",
        title: { en: "Overview", "pt-BR": "Visão geral" },
      },
      {
        slug: "hosts-and-agents",
        title: { en: "Hosts & agents", "pt-BR": "Hosts & agents" },
      },
      {
        slug: "cells-links-topology",
        title: {
          en: "Cells, links & topology",
          "pt-BR": "Cells, links & topologia",
        },
      },
      {
        slug: "state-and-drift",
        title: { en: "State & drift", "pt-BR": "State & drift" },
      },
    ],
  },
  {
    title: { en: "Operations", "pt-BR": "Operações" },
    pages: [
      {
        slug: "operator-playbook",
        title: { en: "Operator playbook", "pt-BR": "Guia do operador" },
      },
      {
        slug: "auto-update",
        title: { en: "Auto-update", "pt-BR": "Auto-update" },
      },
      {
        slug: "deployment-alerts",
        title: {
          en: "Deployment-down alerts",
          "pt-BR": "Alertas de deployment caído",
        },
      },
      {
        slug: "audit-log",
        title: { en: "Audit log", "pt-BR": "Audit log" },
      },
      {
        slug: "troubleshooting",
        title: { en: "Troubleshooting", "pt-BR": "Solução de problemas" },
      },
    ],
  },
  {
    title: { en: "Reference", "pt-BR": "Referência" },
    pages: [
      {
        slug: "cli",
        title: { en: "CLI reference", "pt-BR": "Referência da CLI" },
      },
      {
        slug: "api",
        title: { en: "API reference", "pt-BR": "Referência da API" },
      },
      {
        slug: "ai-agent-skills",
        title: { en: "AI agent skills", "pt-BR": "Skills para agentes de IA" },
      },
    ],
  },
];

export function isLocale(value: string): value is Locale {
  return (LOCALES as string[]).includes(value);
}

// Flat list of every page in TOC order — used for prev/next links.
export function allPages(): DocPage[] {
  return SECTIONS.flatMap((s) => s.pages);
}

// Look up a page by slug. Returns null for unknown slugs so callers
// can render the 404.
export function findPage(slug: string): {
  section: DocSection;
  page: DocPage;
} | null {
  for (const section of SECTIONS) {
    for (const page of section.pages) {
      if (page.slug === slug) return { section, page };
    }
  }
  return null;
}

// Page-to-page navigation (prev / next links at the bottom).
export function neighbours(slug: string): {
  prev: DocPage | null;
  next: DocPage | null;
} {
  const flat = allPages();
  const idx = flat.findIndex((p) => p.slug === slug);
  if (idx === -1) return { prev: null, next: null };
  return {
    prev: idx > 0 ? flat[idx - 1] : null,
    next: idx < flat.length - 1 ? flat[idx + 1] : null,
  };
}

export function pageHref(locale: Locale, slug: string): string {
  return slug ? `/docs/${locale}/${slug}` : `/docs/${locale}`;
}
