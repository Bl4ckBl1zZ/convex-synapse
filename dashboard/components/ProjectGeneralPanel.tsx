"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR, { mutate as globalMutate } from "swr";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, type Project, type Team } from "@/lib/api";
import { useT } from "@/lib/i18n";

type Props = {
  projectId: string;
  teamRef: string;
};

// ProjectGeneralPanel — name + slug + transfer + delete.
//
// v1.9.4: extracted from /teams/<team>/<project>/page.tsx (project home).
// On the home page these lived as header buttons + modal dialogs, which
// pushed destructive actions to the high-traffic primary view. Moving
// them off the home AND switching from modals to inline forms keeps
// destructive operations on a "you came here on purpose" page and
// matches the GitHub / Vercel "Settings → General" pattern.
//
// Why a separate component (not inline in the page): each form is
// self-contained state-wise and the delete flow uses a typed-confirm
// modal — bundling them in one component reuses the project SWR and
// keeps the page file thin.
export function ProjectGeneralPanel({ projectId, teamRef }: Props) {
  const router = useRouter();

  const {
    data: project,
    isLoading,
    mutate: mutateProject,
  } = useSWR<Project>(["/project", projectId], () => api.projects.get(projectId));

  if (isLoading || !project) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <NameSlugCard project={project} onSaved={mutateProject} />
      <TransferCard
        project={project}
        teamRef={teamRef}
        onTransferred={(newSlug) =>
          router.push(`/teams/${encodeURIComponent(newSlug)}/${encodeURIComponent(projectId)}`)
        }
      />
      <DangerZoneCard
        project={project}
        onDeleted={() => {
          // Invalidate the team-page project-list cache BEFORE navigating,
          // so the destination page doesn't render the deleted project
          // from stale SWR data (visible as a one-second flicker for
          // human operators and as a reliable test failure for Playwright).
          // SWR key matches the team-page useSWR below.
          void globalMutate(["/projects", teamRef]);
          router.push(`/teams/${encodeURIComponent(teamRef)}`);
        }}
      />
    </div>
  );
}

/* ---------------- Name + Slug ---------------- */

function NameSlugCard({
  project,
  onSaved,
}: {
  project: Project;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useT();
  const [name, setName] = useState(project.name);
  const [slug, setSlug] = useState(project.slug);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const dirty =
    name.trim() !== project.name || slug.trim() !== project.slug;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const patch: { name?: string; slug?: string } = {};
    if (name.trim() && name.trim() !== project.name) patch.name = name.trim();
    if (slug.trim() && slug.trim() !== project.slug) patch.slug = slug.trim();
    if (Object.keys(patch).length === 0) return;

    setPending(true);
    try {
      await api.projects.update(project.id, patch);
      await onSaved();
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
    } catch (err) {
      if (err instanceof ApiError && err.code === "slug_taken") {
        setError(t("Slug already in use by another project in this team."));
      } else if (err instanceof ApiError && err.code === "invalid_slug") {
        setError(t("Slug must be lowercase letters, digits, and dashes only."));
      } else {
        setError(err instanceof ApiError ? err.message : t("Could not save"));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Card data-testid="project-general-name-slug">
      <CardHeader>
        <CardTitle>{t("Project name and slug")}</CardTitle>
        <CardDescription>
          {t("The name appears in the dashboard; the slug appears in URLs and must be unique within this team.")}
        </CardDescription>
      </CardHeader>
      <CardBody>
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="project-name-input" className="block text-xs text-neutral-400">
                {t("Name")}
              </label>
              <Input
                id="project-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="project-name-input"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="project-slug-input" className="block text-xs text-neutral-400">
                {t("Slug")}
              </label>
              <Input
                id="project-slug-input"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                pattern="[a-z0-9-]+"
                title={t("Lowercase letters, digits, and dashes only")}
                data-testid="project-slug-input"
              />
              <p className="text-[11px] text-neutral-500">
                {t("Lowercase letters, digits, dashes.")}
              </p>
            </div>
          </div>
          {error && (
            <p
              className="text-xs text-red-400"
              data-testid="project-general-name-slug-error"
            >
              {error}
            </p>
          )}
          {success && (
            <p className="text-xs text-green-400" data-testid="project-general-name-slug-success">
              {t("Saved.")}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={!dirty || pending}
              data-testid="project-general-save"
            >
              {pending ? t("Saving…") : t("Save")}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/* ---------------- Transfer ---------------- */

function TransferCard({
  project,
  teamRef,
  onTransferred,
}: {
  project: Project;
  teamRef: string;
  onTransferred: (newTeamSlug: string) => void;
}) {
  const { t } = useT();
  const [dest, setDest] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy load: only fetch teams when the operator engages with the
  // dropdown. Same pattern the dialog version used so we don't burn
  // a /v1/teams request on every settings/general view.
  const [touched, setTouched] = useState(false);
  const { data: myTeams } = useSWR<Team[] | null>(
    touched ? "/teams" : null,
    () => api.teams.list(),
  );
  const { data: currentTeam } = useSWR<Team>(
    ["/team", teamRef],
    () => api.teams.get(teamRef),
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!dest) {
      setError(t("Pick a destination team"));
      return;
    }
    setPending(true);
    try {
      await api.projects.transfer(project.id, dest);
      const newTeam = (myTeams ?? []).find((t) => t.id === dest);
      onTransferred(newTeam?.slug ?? dest);
    } catch (err) {
      if (err instanceof ApiError && err.code === "slug_taken") {
        setError(t("A project with this slug already exists in the destination team."));
      } else if (err instanceof ApiError && err.code === "forbidden") {
        setError(t("You must be admin of both teams to transfer a project."));
      } else {
        setError(err instanceof ApiError ? err.message : t("Could not transfer"));
      }
      setPending(false);
    }
  };

  return (
    <Card data-testid="project-general-transfer">
      <CardHeader>
        <CardTitle>{t("Transfer project")}</CardTitle>
        <CardDescription>
          {t("Move this project and all its deployments to another team you admin. Fails if a project with the same slug already lives there.")}
        </CardDescription>
      </CardHeader>
      <CardBody>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="transfer-dest" className="block text-xs text-neutral-400">
              {t("Destination team")}
            </label>
            <select
              id="transfer-dest"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              onFocus={() => setTouched(true)}
              onMouseDown={() => setTouched(true)}
              className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
              data-testid="project-transfer-dest"
            >
              <option value="">{t("Pick a team…")}</option>
              {(myTeams ?? [])
                .filter((t) => t.id !== currentTeam?.id)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.slug})
                  </option>
                ))}
            </select>
          </div>
          {error && (
            <p className="text-xs text-red-400" data-testid="project-transfer-error">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={pending || !dest}
              data-testid="project-transfer-submit"
            >
              {pending ? t("Transferring…") : t("Transfer")}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/* ---------------- Danger Zone ---------------- */

function DangerZoneCard({
  project,
  onDeleted,
}: {
  project: Project;
  onDeleted: () => void;
}) {
  const { t } = useT();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = typed.trim() === project.name;

  const submit = async () => {
    if (!matches) return;
    setError(null);
    setPending(true);
    try {
      await api.projects.delete(project.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Could not delete"));
      setPending(false);
    }
  };

  return (
    <>
      <Card
        className="border-red-500/30 bg-red-500/5"
        data-testid="project-general-danger-zone"
      >
        <CardHeader>
          <CardTitle className="text-red-200">{t("Danger zone")}</CardTitle>
          <CardDescription>
            {t("Deleting the project removes every deployment, every env var, every saved DNS credential, every member assignment. Cannot be undone.")}
          </CardDescription>
        </CardHeader>
        <CardBody>
          <div className="flex justify-end">
            <Button
              variant="danger"
              onClick={() => {
                setTyped("");
                setError(null);
                setConfirmOpen(true);
              }}
              data-testid="project-delete-open"
            >
              {t("Delete project")}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Dialog
        open={confirmOpen}
        onClose={() => !pending && setConfirmOpen(false)}
        title={t("Delete project")}
      >
        <div className="space-y-3">
          <p className="text-sm text-neutral-300">
            {t("This will delete")} <span className="font-mono text-red-300">{project.name}</span>{" "}
            {t("and all its data permanently. Type the project name to confirm.")}
          </p>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={project.name}
            data-testid="project-delete-confirm-input"
            autoFocus
          />
          {error && (
            <p className="text-xs text-red-400" data-testid="project-delete-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={pending}
            >
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={submit}
              disabled={!matches || pending}
              data-testid="project-delete-confirm"
            >
              {pending ? t("Deleting…") : t("Delete project")}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
