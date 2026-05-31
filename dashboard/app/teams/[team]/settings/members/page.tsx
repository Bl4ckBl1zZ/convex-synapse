"use client";

import { use, useState } from "react";
import useSWR from "swr";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { InvitesPanel } from "@/components/InvitesPanel";
import { ApiError, api, type Team, type TeamMember } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { useT } from "@/lib/i18n";

type Params = { team: string };

// Members pane. Live roster from /list_members + role toggle + remove
// + the existing InvitesPanel.
//
// We resolve the caller's role inside the team via the visible roster
// (their row carries `role`). That avoids a second round-trip to /me +
// per-team membership lookup; the source of truth is what the server
// actually returned.
export default function TeamMembersPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { t } = useT();
  const { team: teamRef } = use(params);
  const { data: team } = useSWR<Team>(["/team", teamRef], () =>
    api.teams.get(teamRef),
  );
  const { data, error, isLoading, mutate } = useSWR<TeamMember[]>(
    ["/members", teamRef],
    () => api.teams.listMembers(teamRef),
  );
  const me = getCurrentUser();
  const myRole = data?.find((m) => m.id === me?.id)?.role;
  const isAdmin = myRole === "admin";
  const adminCount = data?.filter((m) => m.role === "admin").length ?? 0;

  const [actionErr, setActionErr] = useState<string | null>(null);

  const toggleRole = async (m: TeamMember) => {
    setActionErr(null);
    const next = m.role === "admin" ? "member" : "admin";
    try {
      await api.teams.updateMemberRole(teamRef, m.id, next);
      await mutate();
    } catch (e) {
      if (e instanceof ApiError && e.code === "last_admin") {
        setActionErr(
          t("Cannot demote the last admin — promote another member first."),
        );
      } else {
        setActionErr(e instanceof Error ? e.message : t("Could not update role"));
      }
    }
  };

  const remove = async (m: TeamMember) => {
    const self = me?.id === m.id;
    const verb = self ? "leave" : "remove";
    if (
      !confirm(
        self
          ? t(
              `Leave team "{team}"? You'll lose access to all of its projects.`,
              { team: team?.name ?? teamRef },
            )
          : t(`Remove {member} from "{team}"?`, {
              member: m.name || m.email,
              team: team?.name ?? teamRef,
            }),
      )
    ) {
      return;
    }
    setActionErr(null);
    try {
      await api.teams.removeMember(teamRef, m.id);
      if (self) {
        // Self-removal — bounce back to the teams list since we no longer
        // have access to this team's pages.
        window.location.href = "/teams";
        return;
      }
      await mutate();
    } catch (e) {
      if (e instanceof ApiError && e.code === "last_admin") {
        setActionErr(
          t(
            "Cannot {verb} — would leave the team without an admin. Promote another admin first.",
            { verb: t(verb) },
          ),
        );
      } else {
        setActionErr(
          e instanceof Error ? e.message : t("Could not {verb}", { verb: t(verb) }),
        );
      }
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Members")}</CardTitle>
          <CardDescription>
            {t(
              "Everyone with access to this team's projects and deployments.",
            )}
            {isAdmin
              ? t(" Click a member's role to toggle admin/member.")
              : t(" Only admins can change roles or remove other members.")}
          </CardDescription>
        </CardHeader>
        <CardBody className="p-0">
          {isLoading && (
            <ul className="divide-y divide-neutral-800">
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-3 px-5 py-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1">
                    <Skeleton className="h-3.5 w-1/4" />
                    <Skeleton className="mt-2 h-3 w-1/3" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {error && !(error instanceof ApiError && error.status === 403) && (
            <p className="px-5 py-4 text-xs text-red-400">
              {t("Failed to load members:")} {(error as Error).message}
            </p>
          )}

          {actionErr && (
            <p className="border-b border-red-500/30 bg-red-500/10 px-5 py-3 text-xs text-red-300">
              {actionErr}
            </p>
          )}

          {data && data.length > 0 && (
            <ul className="divide-y divide-neutral-800">
              {data.map((m) => {
                const self = me?.id === m.id;
                // Last-admin guard mirrors the server: don't even let the
                // user click "demote" if they're the only admin left.
                const isOnlyAdmin = m.role === "admin" && adminCount <= 1;
                return (
                  <li
                    key={m.id}
                    className="flex items-center gap-3 px-5 py-3"
                    data-testid={`member-row-${m.email}`}
                  >
                    <Avatar seed={m.email} label={m.name || m.email} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-neutral-100">
                        {m.name || m.email.split("@")[0]}
                        {self && (
                          <span className="ml-2 text-xs text-neutral-500">
                            {t("(you)")}
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-neutral-500">
                        {m.email}
                      </p>
                    </div>
                    {isAdmin ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleRole(m)}
                        disabled={isOnlyAdmin}
                        title={
                          isOnlyAdmin
                            ? t("Last admin — promote another member first")
                            : t("Switch to {role}", {
                                role: m.role === "admin" ? "member" : "admin",
                              })
                        }
                        data-testid={`member-role-toggle-${m.email}`}
                      >
                        <Badge tone="neutral">{m.role}</Badge>
                      </Button>
                    ) : (
                      <Badge tone="neutral">{m.role}</Badge>
                    )}
                    {(isAdmin || self) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(m)}
                        disabled={m.role === "admin" && isOnlyAdmin}
                        aria-label={
                          self
                            ? t("Leave team")
                            : t("Remove {email}", { email: m.email })
                        }
                        data-testid={`member-remove-${m.email}`}
                      >
                        {self ? t("Leave") : t("Remove")}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {data && data.length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-neutral-500">
              {t("No members visible.")}
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Invite a teammate")}</CardTitle>
          <CardDescription>
            {t("Send an invite link to add someone to this team.")}
          </CardDescription>
        </CardHeader>
        <CardBody>
          <InvitesPanel teamRef={teamRef} />
        </CardBody>
      </Card>
    </div>
  );
}
