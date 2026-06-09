import { test, expect, type Page, type Route } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// Admin → Apply (v1.23+). Exercises components/ApplySettingsPanel.tsx at
// /admin/apply — the dashboard toggle for Cell Control Plane reconcile apply.
// The apply_settings endpoint is mocked at the page-route level; the backend
// half (DB persist + the resolveApplySettings DB>env gate) is covered by the
// Go tests in internal/test/apply_settings_test.go. This spec covers the UI
// wiring: render → toggle → status, and the instance-admin gate via layout.

async function registerAdmin(page: Page): Promise<void> {
  await page.goto("/register");
  await page.locator("#register-email").fill("admin@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Instance Admin");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

// Stateful mock: GET echoes the current state; POST flips enabled and marks
// the source "db" (mirrors the real handler's DB-wins transition).
async function mockApplySettings(page: Page): Promise<void> {
  let state: Record<string, unknown> = {
    enabled: false,
    dangerous: false,
    source: "env",
    updatedAt: null,
  };
  await page.route("**/v1/admin/apply_settings", async (route: Route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { enabled: boolean };
      state = {
        enabled: !!body.enabled,
        dangerous: false,
        source: "db",
        updatedAt: new Date().toISOString(),
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state),
    });
  });
}

test.beforeEach(async () => {
  await truncateAll();
});

test("apply panel: renders disabled/env and toggles on via the dashboard", async ({ page }) => {
  await registerAdmin(page);
  await mockApplySettings(page);
  await page.goto("/admin/apply");

  const panel = page.getByTestId("apply-settings-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("apply-status")).toContainText("disabled");
  await expect(panel.getByTestId("apply-source")).toContainText(".env default");

  // Enabling pops a confirm() — accept it.
  page.on("dialog", (d) => d.accept());
  await panel.getByTestId("apply-toggle").click();

  await expect(panel.getByTestId("apply-status")).toContainText("enabled");
  await expect(panel.getByTestId("apply-source")).toContainText("dashboard");
  await expect(panel.getByTestId("apply-toggle")).toContainText("Disable apply");
});

test("apply panel: reachable via the admin nav", async ({ page }) => {
  await registerAdmin(page);
  await mockApplySettings(page);
  await page.goto("/admin/host-domain");
  await page.getByTestId("admin-nav-apply").click();
  await expect(page).toHaveURL(/\/admin\/apply\b/);
  await expect(page.getByTestId("apply-settings-panel")).toBeVisible();
});
