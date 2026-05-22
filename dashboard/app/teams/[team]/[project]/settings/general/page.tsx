"use client";

import { use } from "react";
import { ProjectGeneralPanel } from "@/components/ProjectGeneralPanel";

type Params = { team: string; project: string };

export default function ProjectGeneralPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { team: teamRef, project: projectId } = use(params);
  return <ProjectGeneralPanel projectId={projectId} teamRef={teamRef} />;
}
