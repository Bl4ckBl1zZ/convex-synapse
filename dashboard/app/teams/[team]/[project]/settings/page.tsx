"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

type Params = { team: string; project: string };

// Bare /settings entry — bounce to the first sub-page so the operator
// never sees an empty shell. Environment Variables is the most-used
// project surface, hence chosen as the landing target. Mirrors how
// /teams/<ref>/settings bounces to /general.
export default function ProjectSettingsIndex({
  params,
}: {
  params: Promise<Params>;
}) {
  const { team: teamRef, project: projectId } = use(params);
  const router = useRouter();
  useEffect(() => {
    router.replace(
      `/teams/${encodeURIComponent(teamRef)}/${encodeURIComponent(projectId)}/settings/environment-variables`,
    );
  }, [router, teamRef, projectId]);
  return null;
}
