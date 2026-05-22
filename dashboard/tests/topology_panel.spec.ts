import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// v1.9.6 — TopologyPanel.
//
// Backend coverage lives in Go integration tests (synapsetest). This
// spec validates the React side: response shape → rendered DOM. We
// stub /v1/projects/:id/topology at the page-route level so the test
// is offline-deterministic and doesn't depend on ipinfo or a seeded
// project state.

async function registerViaUI(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("op@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Op");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

async function createTeamAndProject(page: Page): Promise<{ teamSlug: string; projectId: string }> {
  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Topo Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /topo co/i }).click();

  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("ToProj");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /toproj/i }).click();

  await expect(page).toHaveURL(/\/teams\/topo-co\/[0-9a-f-]{36}\b/);
  const m = page.url().match(/\/teams\/[^/]+\/([0-9a-f-]{36})/);
  return { teamSlug: "topo-co", projectId: m![1] };
}

test.beforeEach(async () => {
  await truncateAll();
});

test("topology panel renders the host card + deployment tile from a stubbed topology payload", async ({
  page,
}) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);

  // Stub the topology endpoint AFTER the project exists so the URL
  // matches. The dashboard polls this endpoint via SWR; the panel
  // mounts as soon as the response lands.
  await page.route(`**/v1/projects/${projectId}/topology`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hosts: [
          {
            id: "primary",
            name: "synapsepanel.com",
            ip: "72.60.3.159",
            country: "DE",
            countryFlag: "🇩🇪",
            city: "Nuremberg",
            region: "Bavaria",
            provider: "Hetzner",
            synapseVersion: "1.9.6",
            isPrimary: true,
            runningCount: 1,
            provisioningCount: 0,
            failedCount: 0,
            deployments: [
              {
                name: "brave-dolphin-1060",
                type: "dev",
                status: "running",
                url: "https://brave-dolphin-1060.app.synapsepanel.com",
                urlForm: "wildcard",
                storage: "sqlite",
                haEnabled: false,
                replicaCount: 1,
                healthyCount: 1,
                version: "1.39.1",
                adopted: false,
                isDefault: true,
                runningSinceMs: Date.now() - 60_000,
                port: 3214,
              },
            ],
          },
        ],
      }),
    }),
  );

  await page.reload();
  const panel = page.getByTestId("topology-panel");
  await expect(panel).toBeVisible();

  const host = page.getByTestId("topology-host-primary");
  await expect(host).toBeVisible();
  await expect(host).toContainText("synapsepanel.com");
  await expect(host).toContainText("Hetzner");
  await expect(host).toContainText("🇩🇪");

  const dep = page.getByTestId("topology-deployment-brave-dolphin-1060");
  await expect(dep).toBeVisible();
  await expect(dep).toContainText("brave-dolphin-1060");
  await expect(dep).toContainText("sqlite");
  await expect(dep).toContainText("v1.39.1");
});

test("topology hides itself when the project has no deployments yet", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);

  await page.route(`**/v1/projects/${projectId}/topology`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hosts: [
          {
            id: "primary",
            name: "synapsepanel.com",
            isPrimary: true,
            runningCount: 0,
            provisioningCount: 0,
            failedCount: 0,
            deployments: [],
          },
        ],
      }),
    }),
  );
  await page.reload();
  // Panel shouldn't mount: the empty-state belongs to the deployments
  // card above, not the topology view.
  await expect(page.getByTestId("topology-panel")).toHaveCount(0);
});

test("topology renders multi-deployment / mixed-status hosts", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);

  await page.route(`**/v1/projects/${projectId}/topology`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hosts: [
          {
            id: "primary",
            name: "synapsepanel.com",
            countryFlag: "🇩🇪",
            isPrimary: true,
            runningCount: 1,
            provisioningCount: 1,
            failedCount: 1,
            deployments: [
              {
                name: "run-1",
                type: "dev",
                status: "running",
                urlForm: "wildcard",
                storage: "sqlite",
                haEnabled: false,
                replicaCount: 1,
                healthyCount: 1,
                adopted: false,
                isDefault: true,
                runningSinceMs: Date.now() - 120_000,
              },
              {
                name: "prov-1",
                type: "preview",
                status: "provisioning",
                urlForm: "unknown",
                storage: "sqlite",
                haEnabled: false,
                replicaCount: 1,
                healthyCount: 0,
                adopted: false,
                isDefault: false,
              },
              {
                name: "fail-1",
                type: "prod",
                status: "failed",
                urlForm: "wildcard",
                storage: "postgres + s3",
                haEnabled: true,
                replicaCount: 2,
                healthyCount: 0,
                adopted: false,
                isDefault: false,
              },
            ],
          },
        ],
      }),
    }),
  );
  await page.reload();

  await expect(page.getByTestId("topology-deployment-run-1")).toBeVisible();
  // Provisioning tile has a "prov" badge.
  await expect(page.getByTestId("topology-deployment-prov-1")).toContainText("prov");
  // Failed tile carries the badge AND the rose-tinted replica count.
  const failedTile = page.getByTestId("topology-deployment-fail-1");
  await expect(failedTile).toContainText("failed");
  await expect(failedTile).toContainText("0 / 2 healthy");
});
