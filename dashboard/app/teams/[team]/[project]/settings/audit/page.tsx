"use client";

import { use } from "react";
import { AuditLogView } from "@/components/AuditLogView";

type Params = { team: string; project: string };

// v1.10.0 Wave C — per-project audit sub-tab. Reuses the AuditLogView
// component with the project source kind. Differences from the
// team-wide log at /teams/<ref>/audit:
//   - Member-visible (not admin-only). Backend endpoint
//     /v1/projects/<id>/activity gates on project membership.
//   - Scope automatically restricted to events touching this project
//     (project actions + deployment actions + domain actions for
//     this project's deployments).
//   - Same filter chips + export.
export default function ProjectAuditPage({ params }: { params: Promise<Params> }) {
  const { project: projectId } = use(params);
  return <AuditLogView source={{ kind: "project", projectId }} embedded />;
}
