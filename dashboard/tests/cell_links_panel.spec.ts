import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// feat/cell-control-plane (Bloco 7) — CellLinksPanel.
// Backend coverage is in Go integration tests; this validates the React side
// (response shape → DOM) with stubbed routes, like cells_panel.spec.ts.

const CORE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const RUNTIME_ID = "bbbbbbbb-0000-0000-0000-000000000002";

function cellsPayload() {
  const base = {
    teamId: "t",
    projectId: "p",
    region: "br",
    isolationTier: "shared",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    items: [
      { ...base, id: CORE_ID, name: "core-prod-br-1", slug: "core-prod-br-1", kind: "core", environment: "prod" },
      { ...base, id: RUNTIME_ID, name: "runtime-prod-br-1", slug: "runtime-prod-br-1", kind: "runtime", environment: "prod" },
    ],
  };
}

function linkRow(over: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    teamId: "t",
    projectId: "p",
    sourceCellId: CORE_ID,
    targetCellId: RUNTIME_ID,
    protocol: "outbox",
    authMode: "service_token",
    allowedCommands: ["runtime.runAutomation", "runtime.cancelRun"],
    allowedEvents: ["runtime.runStarted"],
    status: "active",
    serviceTokenCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

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
  await dialog.locator("#team-name").fill("Link Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /link co/i }).click();
  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("LinkProj");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /linkproj/i }).click();
  await expect(page).toHaveURL(/\/teams\/link-co\/[0-9a-f-]{36}\b/);
  const m = page.url().match(/\/teams\/[^/]+\/([0-9a-f-]{36})/);
  return { projectId: m![1] };
}

// Stubs the endpoints the project page fetches besides cell_links.
async function stubCommon(page: Page, projectId: string) {
  await page.route(`**/v1/projects/${projectId}/cells`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cellsPayload()) }),
  );
  await page.route(`**/v1/projects/${projectId}/list_deployments**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/v1/hosts", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
}

test.beforeEach(async () => {
  await truncateAll();
});

test("cell links panel renders a link row with source → target + counts", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  await stubCommon(page, projectId);
  await page.route(`**/v1/projects/${projectId}/cell_links`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [linkRow({ serviceTokenCount: 1 })] }),
    }),
  );
  await page.reload();

  await expect(page.getByTestId("cell-links-panel")).toBeVisible();
  const row = page.getByTestId("cell-link-row");
  await expect(row).toContainText("core-prod-br-1");
  await expect(row).toContainText("runtime-prod-br-1");
  await expect(row).toContainText("outbox");
  await expect(row).toContainText("active");
});

test("create link flow adds a row", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  await stubCommon(page, projectId);

  const linksState: Record<string, unknown>[] = [];
  await page.route(`**/v1/projects/${projectId}/cell_links`, async (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      linksState.push(linkRow({ id: "link-new", ...body }));
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(linksState[linksState.length - 1]) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: linksState }) });
    }
  });
  await page.reload();

  await expect(page.getByTestId("cell-links-empty")).toBeVisible();
  await page.getByTestId("create-cell-link-button").click();
  const dialog = page.getByRole("dialog");
  // Source/target default to the two stubbed cells (core, runtime).
  await dialog.locator("#link-commands").fill("runtime.runAutomation\nruntime.cancelRun");
  await dialog.getByRole("button", { name: "Create link" }).click();

  await expect(page.getByTestId("cell-link-row")).toContainText("core-prod-br-1");
});

test("generate service token shows the token once", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  await stubCommon(page, projectId);
  await page.route(`**/v1/projects/${projectId}/cell_links`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [linkRow()] }) }),
  );
  const tokenState: Record<string, unknown>[] = [];
  await page.route("**/v1/cell_links/link-1/service_tokens", async (route) => {
    if (route.request().method() === "POST") {
      const tok = {
        id: "svc-1",
        cellLinkId: "link-1",
        sourceCellId: CORE_ID,
        targetCellId: RUNTIME_ID,
        name: "t",
        token: "syn_svc_PLAINTEXTONCE",
        scopes: [],
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tokenState.push({ ...tok, token: undefined });
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(tok) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: tokenState }) });
    }
  });
  await page.reload();

  await page.getByTestId("cell-link-row").getByRole("button", { name: "Tokens" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("generate-service-token").click();
  // The plaintext token is shown once in the dialog.
  await expect(page.getByText("syn_svc_PLAINTEXTONCE")).toBeVisible();
});
