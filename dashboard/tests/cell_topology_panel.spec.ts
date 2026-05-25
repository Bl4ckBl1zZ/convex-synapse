import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// feat/cell-control-plane (Bloco 8) — CellTopologyPanel.
// Validates the React side (response → DOM) with a stubbed cell_topology
// payload, like topology_panel.spec.ts.

const HOST_ID = "11111111-0000-0000-0000-0000000000h1";
const CORE_ID = "22222222-0000-0000-0000-0000000000c1";
const RUNTIME_ID = "33333333-0000-0000-0000-0000000000r1";

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
  await dialog.locator("#team-name").fill("Topo Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /topo co/i }).click();
  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("TopoProj");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /topoproj/i }).click();
  await expect(page).toHaveURL(/\/teams\/topo-co\/[0-9a-f-]{36}\b/);
  const m = page.url().match(/\/teams\/[^/]+\/([0-9a-f-]{36})/);
  return { projectId: m![1] };
}

function realTopology(projectId: string) {
  return {
    mode: "cell_control_plane",
    project: { id: projectId, name: "TopoProj", slug: "topoproj" },
    hosts: [
      {
        id: HOST_ID,
        name: "vps-br-1",
        provider: "hostinger",
        region: "br",
        status: "online",
        effectiveStatus: "online",
        isSynapseHost: false,
        agentCount: 1,
        agentsSummary: { online: 1, offline: 0, revoked: 0 },
      },
    ],
    cells: [
      {
        id: CORE_ID,
        name: "core-prod-br-1",
        slug: "core-prod-br-1",
        kind: "core",
        environment: "prod",
        region: "br",
        isolationTier: "shared",
        status: "active",
        primaryHostId: HOST_ID,
        deployments: [
          {
            id: "d1",
            name: "lush-heron-4656",
            type: "prod",
            status: "running",
            url: "https://lush-heron-4656.example.com",
            adopted: false,
            placement: { hostId: HOST_ID, cellId: CORE_ID, desiredStatus: "running", observedStatus: "running" },
            routes: [],
          },
        ],
        routes: [],
        outgoingLinks: [{ id: "l1", sourceCellId: CORE_ID, targetCellId: RUNTIME_ID, protocol: "outbox", status: "active" }],
        incomingLinks: [],
        warnings: [],
      },
      {
        id: RUNTIME_ID,
        name: "runtime-prod-br-1",
        slug: "runtime-prod-br-1",
        kind: "runtime",
        environment: "prod",
        region: "br",
        isolationTier: "shared",
        status: "active",
        deployments: [],
        routes: [],
        outgoingLinks: [],
        incomingLinks: [{ id: "l1", sourceCellId: CORE_ID, targetCellId: RUNTIME_ID, protocol: "outbox", status: "active" }],
        warnings: ["no primary deployment", "not placed on a host"],
      },
    ],
    unassignedDeployments: [],
    links: [
      {
        id: "l1",
        sourceCellId: CORE_ID,
        targetCellId: RUNTIME_ID,
        protocol: "outbox",
        authMode: "service_token",
        status: "active",
        allowedCommandsCount: 2,
        allowedEventsCount: 1,
        activeTokenCount: 0,
        hasEndpoint: false,
      },
    ],
    warnings: [
      "Cell runtime-prod-br-1 has no primary deployment",
      "Cell runtime-prod-br-1 is not placed on a host",
      "Cell link " + CORE_ID.slice(0, 8) + " → " + RUNTIME_ID.slice(0, 8) + " has no resolved endpoint",
    ],
  };
}

test.beforeEach(async () => {
  await truncateAll();
});

test("cell topology renders host → cell → deployment, links, warnings, unplaced", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  await page.route(`**/v1/projects/${projectId}/cell_topology`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(realTopology(projectId)) }),
  );
  await page.reload();

  const panel = page.getByTestId("cell-topology-panel");
  await expect(panel).toBeVisible();

  // Host → cell → deployment.
  const host = page.locator('[data-testid="topology-host"][data-host-name="vps-br-1"]');
  await expect(host).toBeVisible();
  await expect(host).toContainText("online");
  await expect(host).toContainText("core-prod-br-1");
  await expect(host).toContainText("lush-heron-4656");

  // Unplaced runtime cell.
  const unplaced = page.getByTestId("topology-unplaced-cells");
  await expect(unplaced).toContainText("runtime-prod-br-1");

  // Link edge + "endpoint unresolved" badge.
  const links = page.getByTestId("topology-links");
  await expect(links).toContainText("core-prod-br-1 → runtime-prod-br-1");
  await expect(links).toContainText("endpoint unresolved");

  // Warnings section.
  const warnings = page.getByTestId("topology-warnings");
  await expect(warnings).toContainText("has no primary deployment");
});

test("cell topology hides itself in legacy mode (no cells)", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  await page.route(`**/v1/projects/${projectId}/cell_topology`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "legacy_synthetic",
        project: { id: projectId, name: "TopoProj", slug: "topoproj" },
        hosts: [],
        cells: [],
        unassignedDeployments: [],
        links: [],
        warnings: [],
      }),
    }),
  );
  await page.reload();
  await expect(page.getByTestId("cell-topology-panel")).toHaveCount(0);
});
