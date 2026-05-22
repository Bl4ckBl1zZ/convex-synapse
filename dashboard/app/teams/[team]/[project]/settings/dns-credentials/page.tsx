"use client";

import { use } from "react";
import { Card, CardBody } from "@/components/ui/card";
import { ProjectDnsCredentialsPanel } from "@/components/ProjectDnsCredentialsPanel";

type Params = { team: string; project: string };

export default function ProjectDnsCredentialsPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { project: projectId } = use(params);
  return (
    <Card>
      <CardBody>
        <ProjectDnsCredentialsPanel projectId={projectId} />
      </CardBody>
    </Card>
  );
}
