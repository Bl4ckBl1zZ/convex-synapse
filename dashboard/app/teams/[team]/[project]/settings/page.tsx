"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

type Params = { team: string; project: string };

// Bare /settings entry — bounce to /general (v1.9.4+, matches the
// team-settings IA which also lands on /general by default).
export default function ProjectSettingsIndex({
  params,
}: {
  params: Promise<Params>;
}) {
  const { team: teamRef, project: projectId } = use(params);
  const router = useRouter();
  useEffect(() => {
    router.replace(
      `/teams/${encodeURIComponent(teamRef)}/${encodeURIComponent(projectId)}/settings/general`,
    );
  }, [router, teamRef, projectId]);
  return null;
}
