"use client";

import Link from "next/link";
import { use } from "react";
import useSWR from "swr";
import { AuditLogView } from "@/components/AuditLogView";
import { api, type Team } from "@/lib/api";
import { useT } from "@/lib/i18n";

type Params = { team: string };

export default function AuditLogPage({ params }: { params: Promise<Params> }) {
  const { t } = useT();
  const { team: teamRef } = use(params);
  const { data: team } = useSWR<Team>(["/team", teamRef], () =>
    api.teams.get(teamRef),
  );

  return (
    <div className="space-y-6">
      <div>
        <nav className="text-xs text-neutral-500">
          <Link href="/teams" className="hover:text-neutral-300">
            {t("Teams")}
          </Link>{" "}
          /{" "}
          <Link
            href={`/teams/${encodeURIComponent(teamRef)}`}
            className="hover:text-neutral-300"
          >
            {team?.name ?? teamRef}
          </Link>{" "}
          / <span className="text-neutral-300">{t("Audit log")}</span>
        </nav>
        <div className="mt-3">
          <h1 className="text-xl font-semibold">{t("Audit log")}</h1>
          <p className="text-xs text-neutral-400">
            {t(
              "Every mutation across this team. Filter by actor, action, target, time range, or free-text search. Admin-only.",
            )}
          </p>
        </div>
      </div>

      <AuditLogView source={{ kind: "team", teamRef }} />
    </div>
  );
}
