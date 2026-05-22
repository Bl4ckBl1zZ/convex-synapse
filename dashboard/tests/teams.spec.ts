import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

async function registerViaUI(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("ian@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Ian");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

async function createTeamViaAPI(
  request: APIRequestContext,
  page: Page,
  name: string,
) {
  const auth = await page.evaluate(() => {
    const raw = window.localStorage.getItem("synapse.auth");
    if (!raw) throw new Error("missing auth bundle");
    return JSON.parse(raw) as { accessToken: string };
  });
  const apiBase =
    process.env.NEXT_PUBLIC_SYNAPSE_URL?.replace(/\/$/, "") ||
    "http://localhost:8080";
  const resp = await request.post(`${apiBase}/v1/teams/create_team`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    data: { name },
  });
  expect(resp.ok()).toBeTruthy();
}

test.beforeEach(async () => {
  await truncateAll();
});

test("create a team from the empty state", async ({ page }) => {
  await registerViaUI(page);

  await page.getByRole("button", { name: "Create team" }).click();
  // Submit lives inside the dialog — scope the click so it doesn't match the
  // empty-state "Create team" button still rendered behind the modal.
  const dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Amage Web");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page.getByRole("link", { name: /amage web/i })).toBeVisible();
});

test("create team then create project", async ({ page }) => {
  await registerViaUI(page);

  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Amage");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await page.getByRole("link", { name: /amage/i }).click();
  await expect(page).toHaveURL(/\/teams\/amage\b/);

  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("My Store");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page.getByRole("link", { name: /my store/i })).toBeVisible();
});

test("teams page follows backend pagination", async ({ page, request }) => {
  await registerViaUI(page);

  for (let i = 0; i < 105; i++) {
    await createTeamViaAPI(request, page, `Paged Team ${String(i).padStart(3, "0")}`);
  }

  // Registration already landed on /teams with an empty SWR cache. Reload
  // after seeding via API so the page fetches from the backend again.
  await page.reload();
  await expect(
    page.getByRole("link", { name: /paged team 104/i }),
  ).toBeVisible();
});

test("rename project from its detail page", async ({ page }) => {
  await registerViaUI(page);

  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Amage");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /amage/i }).click();

  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("Old Name");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /old name/i }).click();

  // Header has the old name.
  await expect(page.getByRole("heading", { name: "Old Name" })).toBeVisible();

  // v1.9.4: rename moved off the project home into /settings/general
  // as an inline form (not a modal dialog).
  await page.getByTestId("project-settings-link").click();
  await page.getByTestId("project-settings-nav-general").click();
  const nameInput = page.getByTestId("project-name-input");
  await nameInput.fill("New Name");
  await page.getByTestId("project-general-save").click();
  await expect(page.getByTestId("project-general-name-slug-success")).toBeVisible();

  // Back to the project home — header reflects the new name.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "New Name" })).toBeVisible();
});

test("delete project from its detail page", async ({ page }) => {
  await registerViaUI(page);

  // Create team + project.
  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Amage");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /amage/i }).click();

  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("Trash Me");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  // v1.9.4: delete moved off the project home into
  // /settings/general → "Danger zone" with a typed-name confirmation
  // (no more native confirm() dialog).
  await page.getByRole("link", { name: /trash me/i }).click();
  await expect(page).toHaveURL(/\/teams\/amage\/[0-9a-f-]{36}\b/);
  await page.getByTestId("project-settings-link").click();
  await page.getByTestId("project-settings-nav-general").click();
  await page.getByTestId("project-delete-open").click();
  await page.getByTestId("project-delete-confirm-input").fill("Trash Me");
  await page.getByTestId("project-delete-confirm").click();

  // Bounced back to the team page; the project no longer appears.
  await expect(page).toHaveURL(/\/teams\/amage\b/);
  await expect(page.getByRole("link", { name: /trash me/i })).toBeHidden();
});
