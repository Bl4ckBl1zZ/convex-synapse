"use client";

import { use } from "react";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TokensPanel } from "@/components/TokensPanel";
import { useT } from "@/lib/i18n";

type Params = { team: string; project: string };

// Two distinct sections side-by-side because they're separate concepts
// even though scope=project and scope=app overlap at the table level:
//   - Project tokens are operator-side long-lived service keys
//     (CI scripts, infra automation, the agency's own tooling)
//   - App tokens are short-lived preview-deploy keys consumed by CI/CD
//     systems (GitHub Actions, Vercel preview branches)
// Same access surface in the backend — different intended lifecycles
// and different rotation cadence in practice. Splitting them visually
// makes operators less likely to revoke the wrong one.
export default function ProjectAccessTokensPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { project: projectId } = use(params);
  const { t } = useT();
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Project access tokens")}</CardTitle>
          <CardDescription>
            {t(
              "Long-lived service tokens scoped to this project. Use for CI scripts and infra automation that acts on the project as a whole.",
            )}
          </CardDescription>
        </CardHeader>
        <CardBody>
          <TokensPanel scope="project" target={projectId} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("App tokens (preview deploy keys)")}</CardTitle>
          <CardDescription>
            {t(
              "Short-lived tokens for CI/CD preview deploys. Same access surface as project tokens; categorised separately so you can rotate them on a different cadence without losing track of which is which.",
            )}
          </CardDescription>
        </CardHeader>
        <CardBody>
          <TokensPanel scope="app" target={projectId} />
        </CardBody>
      </Card>
    </div>
  );
}
