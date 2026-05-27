import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

async function setupProject(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("ian@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Ian");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);

  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Amage");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /amage/i }).click();

  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("Store");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /store/i }).click();

  await expect(page).toHaveURL(/\/teams\/amage\/[0-9a-f-]{36}\b/);

  // v1.9.3: env vars panel was moved off the project home into its own
  // settings sub-page. Drive through the Settings button so the spec
  // exercises the actual operator flow + the new layout.
  // v1.9.4 update: `project-settings-link` now points at /settings/general
  // (was /settings). We need a second click on the env-vars sidebar nav.
  await page.getByTestId("project-settings-link").click();
  await page.getByTestId("project-settings-nav-env-vars").click();
  await expect(page).toHaveURL(
    /\/teams\/amage\/[0-9a-f-]{36}\/settings\/environment-variables\b/,
  );
}

test.beforeEach(async () => {
  await truncateAll();
});

test("project env vars: add, list, delete", async ({ page }) => {
  await setupProject(page);

  // Initially empty.
  await expect(page.getByText("No env vars yet.")).toBeVisible();

  // Add one.
  await page.locator("#envvar-name").fill("API_KEY");
  await page.locator("#envvar-value").fill("supersecret");
  await page.getByRole("button", { name: "Add" }).click();

  await expect(page.getByText("API_KEY")).toBeVisible();
  // v1.9.2: values mask by default — assert visible after toggling
  // Reveal rather than expecting plaintext in the DOM.
  await expect(page.getByText("supersecret")).toBeHidden();
  // v1.17.1+: same NAME now renders one row per deployment_type, so
  // env-var-toggle-API_KEY matches 3 elements (dev, prod, preview).
  // Click the specific dev row via its aria-label.
  await page.getByRole("button", { name: "Reveal value for API_KEY on dev" }).click();
  await expect(page.getByText("supersecret")).toBeVisible();

  // Add a second one to confirm the list grows.
  await page.locator("#envvar-name").fill("DATABASE_URL");
  await page.locator("#envvar-value").fill("postgres://db");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("DATABASE_URL")).toBeVisible();

  // Delete API_KEY (all types). v1.17.1+: same NAME stores one row per
  // deployment_type, so the bulk-delete button removes every type at once.
  await page.getByRole("button", { name: "Delete all values for API_KEY" }).click();
  // The grouped "Delete all values" button is unique per name; once
  // API_KEY is gone, the button must disappear. (v1.10.0+: ActivityFeed
  // shows the `updateProjectEnvVars` audit event which mentions the
  // name, so a page-wide text match never hides.)
  await expect(
    page.getByRole("button", { name: "Delete all values for API_KEY" }),
  ).toBeHidden();
  // The other one survives.
  await expect(
    page.getByRole("button", { name: "Delete all values for DATABASE_URL" }),
  ).toBeVisible();
});
