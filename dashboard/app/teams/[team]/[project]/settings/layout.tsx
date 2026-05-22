"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { use } from "react";
import clsx from "clsx";
import useSWR from "swr";
import { ApiError, api, type Project } from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

type Params = { team: string; project: string };

// Project Settings shell. Mirrors the team-settings layout (two-column,
// sticky sidebar) so the IA stays consistent across both surfaces.
//
// Why a shell + sub-routes instead of one tall scroll on the project
// home: the project page accumulated env vars, DNS creds, members,
// access tokens, app tokens at the bottom and got unreadable. Cloud
// solves this with sub-tabs; we mirror the pattern.
//
// The 404/403 gate is the same render-time gate the project home uses
// (see /teams/[team]/[project]/page.tsx). It ensures operators who
// land on a settings URL for a dead project get the EmptyState — not
// cascading "Failed to load X" banners from every sub-page.
export default function ProjectSettingsLayout({
  params,
  children,
}: {
  params: Promise<Params>;
  children: React.ReactNode;
}) {
  const { team: teamRef, project: projectId } = use(params);
  const pathname = usePathname() ?? "";
  const base = `/teams/${encodeURIComponent(teamRef)}/${encodeURIComponent(projectId)}/settings`;

  const {
    data: project,
    error: projectError,
    isLoading: projectLoading,
  } = useSWR<Project>(
    ["/project", projectId],
    () => api.projects.get(projectId),
  );

  if (projectLoading && !project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-6 w-80" />
      </div>
    );
  }
  if (
    projectError instanceof ApiError &&
    (projectError.status === 404 || projectError.status === 403)
  ) {
    return (
      <EmptyState
        title="Project unavailable"
        description="This project doesn't exist or you don't have access."
        testId="project-unavailable"
        action={
          <Link
            href={`/teams/${encodeURIComponent(teamRef)}`}
            className="text-sm text-cyan-400 hover:text-cyan-300"
          >
            ← Back to projects
          </Link>
        }
      />
    );
  }

  const items: { href: string; label: string; testid: string }[] = [
    { href: `${base}/environment-variables`, label: "Environment Variables", testid: "project-settings-nav-env-vars" },
    { href: `${base}/dns-credentials`, label: "DNS Credentials", testid: "project-settings-nav-dns" },
    { href: `${base}/members`, label: "Members", testid: "project-settings-nav-members" },
    { href: `${base}/access-tokens`, label: "Access Tokens", testid: "project-settings-nav-tokens" },
  ];

  return (
    <div className="space-y-6" data-testid="project-settings-shell">
      <div>
        <nav className="text-xs text-neutral-500">
          <Link href="/teams" className="hover:text-neutral-300">
            Teams
          </Link>{" "}
          /{" "}
          <Link
            href={`/teams/${encodeURIComponent(teamRef)}`}
            className="hover:text-neutral-300"
          >
            {teamRef}
          </Link>{" "}
          /{" "}
          <Link
            href={`/teams/${encodeURIComponent(teamRef)}/${encodeURIComponent(projectId)}`}
            className="hover:text-neutral-300"
          >
            {project?.name ?? projectId}
          </Link>{" "}
          / <span className="text-neutral-300">Settings</span>
        </nav>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-neutral-100">
          {project?.name ?? "Project"} settings
        </h1>
        <p className="mt-1 text-xs text-neutral-400">
          Project-wide configuration. Deployments themselves are managed
          from the{" "}
          <Link
            href={`/teams/${encodeURIComponent(teamRef)}/${encodeURIComponent(projectId)}`}
            className="text-neutral-300 hover:text-neutral-100"
          >
            project home
          </Link>
          .
        </p>
      </div>

      <div className="grid gap-8 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="md:sticky md:top-20 md:self-start">
          <nav className="space-y-0.5" aria-label="Project settings sections">
            {items.map((it) => (
              <Link
                key={it.label}
                href={it.href}
                data-testid={it.testid}
                className={clsx(
                  "flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors",
                  pathname.startsWith(it.href)
                    ? "bg-violet-500/10 text-violet-200"
                    : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100",
                )}
              >
                {it.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </div>
  );
}
