"use client";

import Link from "next/link";
import { use } from "react";
import useSWR from "swr";
import { AuditLogView } from "@/components/AuditLogView";
import { api, type Team } from "@/lib/api";

type Params = { team: string };

export default function AuditLogPage({ params }: { params: Promise<Params> }) {
  const { team: teamRef } = use(params);
  const { data: team } = useSWR<Team>(["/team", teamRef], () =>
    api.teams.get(teamRef),
  );

  return (
    <div className="space-y-6">
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
            {team?.name ?? teamRef}
          </Link>{" "}
          / <span className="text-neutral-300">Audit log</span>
        </nav>
        <div className="mt-3">
          <h1 className="text-xl font-semibold">Audit log</h1>
          <p className="text-xs text-neutral-400">
            Every mutation across this team. Filter by actor, action, target,
            time range, or free-text search. Admin-only.
          </p>
        </div>
      </div>

      <AuditLogView source={{ kind: "team", teamRef }} />
    </div>
  );
}
