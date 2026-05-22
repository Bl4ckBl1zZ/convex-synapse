"use client";

import { use } from "react";
import { Card, CardBody } from "@/components/ui/card";
import { ProjectMembersPanel } from "@/components/ProjectMembersPanel";

type Params = { team: string; project: string };

export default function ProjectMembersPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { project: projectId } = use(params);
  return (
    <Card>
      <CardBody>
        <ProjectMembersPanel projectId={projectId} />
      </CardBody>
    </Card>
  );
}
