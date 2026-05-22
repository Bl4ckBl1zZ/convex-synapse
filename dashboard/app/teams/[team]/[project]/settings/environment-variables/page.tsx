"use client";

import { use } from "react";
import { Card, CardBody } from "@/components/ui/card";
import { EnvVarsPanel } from "@/components/EnvVarsPanel";

type Params = { team: string; project: string };

export default function ProjectEnvVarsPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { project: projectId } = use(params);
  return (
    <Card>
      <CardBody>
        <EnvVarsPanel projectId={projectId} />
      </CardBody>
    </Card>
  );
}
