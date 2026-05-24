import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// feat/cell-control-plane (Bloco 4) — CellsPanel + HostsPanel.
//
// Backend coverage lives in Go integration tests (synapsetest). This spec
// validates the React side: API response shape → rendered DOM. We stub the
// cells / list_deployments / hosts endpoints at the page-route level so the
// test is offline-deterministic (mirrors topology_panel.spec.ts).

const DEV_ID = "11111111-1111-1111-1111-111111111111";
const PROD_ID = "22222222-2222-2222-2222-222222222222";

async function registerViaUI(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("op@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Op");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

async function createTeamAndProject(page: Page): Promise<{ projectId: string }> {
  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Cell Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /cell co/i }).click();

  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("CellProj");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /cellproj/i }).click();

  await expect(page).toHaveURL(/\/teams\/cell-co\/[0-9a-f-]{36}\b/);
  const m = page.url().match(/\/teams\/[^/]+\/([0-9a-f-]{36})/);
  return { projectId: m![1] };
}

function stubDeployments(page: Page, projectId: string) {
  return page.route(`**/v1/projects/${projectId}/list_deployments**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: DEV_ID,
          name: "brave-dolphin-1060",
          projectId,
          deploymentType: "dev",
          status: "running",
        },
        {
          id: PROD_ID,
          name: "lush-heron-4656",
          projectId,
          deploymentType: "prod",
          status: "running",
          isDefault: true,
        },
      ]),
    }),
  );
}

const SYNAPSE_HOST = {
  id: "99999999-9999-9999-9999-999999999999",
  name: "current-host",
  provider: "self-hosted",
  region: "br",
  labels: {},
  status: "online",
  isSynapseHost: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test.beforeEach(async () => {
  await truncateAll();
});

test("cells panel renders core cells wired to their deployments, hosts panel lists the host", async ({
  page,
}) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);

  await stubDeployments(page, projectId);
  await page.route(`**/v1/projects/${projectId}/cells`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "cell-dev",
            teamId: "t",
            projectId,
            name: "core-dev-br-1",
            slug: "core-dev-br-1",
            kind: "core",
            environment: "dev",
            region: "br",
            isolationTier: "shared",
            status: "active",
            primaryDeploymentId: DEV_ID,
            primaryHostId: SYNAPSE_HOST.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: "cell-prod",
            teamId: "t",
            projectId,
            name: "core-prod-br-1",
            slug: "core-prod-br-1",
            kind: "core",
            environment: "prod",
            region: "br",
            isolationTier: "shared",
            status: "active",
            primaryDeploymentId: PROD_ID,
            primaryHostId: SYNAPSE_HOST.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    }),
  );
  await page.route("**/v1/hosts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [SYNAPSE_HOST] }),
    }),
  );

  await page.reload();

  // Cells section + the two backfilled core cells, each showing the
  // deployment NAME (resolved from the UUID via the deployments list).
  await expect(page.getByTestId("cells-panel")).toBeVisible();
  const devCell = page.locator('[data-testid="cell-card"][data-cell-name="core-dev-br-1"]');
  await expect(devCell).toBeVisible();
  await expect(devCell).toContainText("brave-dolphin-1060");
  await expect(devCell).toContainText("core");
  const prodCell = page.locator('[data-testid="cell-card"][data-cell-name="core-prod-br-1"]');
  await expect(prodCell).toBeVisible();
  await expect(prodCell).toContainText("lush-heron-4656");

  // Reverse view: the deployment card carries a "Cell: …" badge.
  await expect(page.getByText("Cell: core-prod-br-1")).toBeVisible();

  // Hosts section lists the synapse self-host.
  await expect(page.getByTestId("hosts-panel")).toBeVisible();
  const hostCard = page.locator('[data-testid="host-card"][data-host-name="current-host"]');
  await expect(hostCard).toBeVisible();
  await expect(hostCard).toContainText("this host");
});

test("create cell flow adds the cell to the list", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);

  await stubDeployments(page, projectId);
  await page.route("**/v1/hosts", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );

  // Dynamic cells route: POST appends to an in-memory list; GET returns it.
  // So the panel's post-create mutate() reflects the new cell immediately.
  const cellsState: Record<string, unknown>[] = [];
  await page.route(`**/v1/projects/${projectId}/cells`, async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      const cell = {
        id: "cell-new",
        teamId: "t",
        projectId,
        name: body.name,
        slug: body.name,
        kind: body.kind ?? "core",
        environment: body.environment ?? "dev",
        region: body.region ?? "",
        isolationTier: body.isolationTier ?? "shared",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      cellsState.push(cell);
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(cell) });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: cellsState }),
      });
    }
  });

  await page.reload();

  // Empty state first.
  await expect(page.getByTestId("cells-empty")).toBeVisible();

  await page.getByTestId("create-cell-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#cell-name").fill("runtime-prod-br-1");
  await dialog.locator("#cell-kind").selectOption("runtime");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  // The new cell shows up (panel refetched the dynamic GET).
  const newCell = page.locator('[data-testid="cell-card"][data-cell-name="runtime-prod-br-1"]');
  await expect(newCell).toBeVisible();
  await expect(newCell).toContainText("runtime");
});

test("hosts panel hides itself for non-instance-admins (403)", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);

  await stubDeployments(page, projectId);
  await page.route(`**/v1/projects/${projectId}/cells`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.route("**/v1/hosts", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ code: "forbidden", message: "Host endpoints require instance-admin role" }),
    }),
  );

  await page.reload();

  // Cells panel still renders; hosts panel is hidden entirely (no red error).
  await expect(page.getByTestId("cells-panel")).toBeVisible();
  await expect(page.getByTestId("hosts-panel")).toHaveCount(0);
});
