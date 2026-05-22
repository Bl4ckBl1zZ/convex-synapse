import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// v1.9.4 — CLI install/version chip in the TopBar.
//
// Driven by the public /v1/cli_latest_version endpoint. We mock the
// response at the page-route level so the spec is deterministic (and
// so CI doesn't depend on the live npm registry being reachable from
// the test runner network).

async function loginAnyone(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("op@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Op");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

test.beforeEach(async () => {
  await truncateAll();
});

test("chip renders the latest CLI version and the install command", async ({ page }) => {
  await page.route("**/v1/cli_latest_version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        packageName: "@iann29/synapse",
        latest: "1.8.6",
        installCommand: "npm install -g @iann29/synapse@1.8.6",
        fromCache: false,
      }),
    }),
  );

  await loginAnyone(page);

  const chip = page.getByTestId("cli-version-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("v1.8.6");

  // Popover opens on click.
  await chip.click();
  await expect(page.getByTestId("cli-version-popover")).toBeVisible();
  await expect(page.getByTestId("cli-install-command")).toHaveText(
    "npm install -g @iann29/synapse@1.8.6",
  );

  // Copy button toggles to "Copied!" on success. clipboard is mocked
  // by the browser context in our Playwright config.
  await page.getByTestId("cli-install-copy").click();
  await expect(page.getByTestId("cli-install-copy")).toHaveText("Copied!");
});

test("chip shows install fallback when npm returned an error", async ({ page }) => {
  await page.route("**/v1/cli_latest_version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        packageName: "@iann29/synapse",
        error: "npm fetch: connection refused",
      }),
    }),
  );

  await loginAnyone(page);

  const chip = page.getByTestId("cli-version-chip");
  await expect(chip).toBeVisible();
  // No version → label falls back to "install".
  await expect(chip).toContainText("install");

  await chip.click();
  // Install command still useful via `@latest` fallback.
  await expect(page.getByTestId("cli-install-command")).toContainText(
    "npm install -g @iann29/synapse@latest",
  );
  // Error annotated to the operator.
  await expect(page.getByText(/npm registry note/i)).toBeVisible();
});

test("chip is not visible to logged-out users", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByTestId("cli-version-chip")).toHaveCount(0);
});
