import { test, expect, type Page, type Route } from "@playwright/test";
import { truncateAll } from "./helpers/db";

const API_BASE = process.env.SYNAPSE_API_URL || "http://localhost:8080";

// Admin → Email (v1.22+). Exercises components/EmailSettingsPanel.tsx at
// /admin/email. The email_settings endpoint is mocked at the page-route
// level — the backend half (encrypt + persist + the resolveEmailSender
// fallback) is covered by the Go integration tests in
// internal/test/email_settings_test.go. This spec covers the UI wiring:
// render → save → status → clear, and the instance-admin gate.

async function registerAdmin(page: Page): Promise<void> {
  await page.goto("/register");
  await page.locator("#register-email").fill("admin@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Instance Admin");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

// Stateful mock mirroring the real handler's transitions: POST → configured
// (db), DELETE → none, GET echoes the current state.
async function mockEmailSettings(page: Page): Promise<void> {
  let state: Record<string, unknown> = {
    configured: false,
    source: "none",
    provider: "resend",
    fromAddress: "",
    updatedAt: null,
  };
  await page.route("**/v1/admin/email_settings", async (route: Route) => {
    const method = route.request().method();
    if (method === "POST") {
      state = {
        configured: true,
        source: "db",
        provider: "resend",
        fromAddress: "Synapse <no-reply@x.com>",
        updatedAt: new Date().toISOString(),
      };
    } else if (method === "DELETE") {
      state = {
        configured: false,
        source: "none",
        provider: "resend",
        fromAddress: "",
        updatedAt: null,
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

test("admin configures and clears Resend email settings", async ({ page }) => {
  await registerAdmin(page);
  await mockEmailSettings(page);

  await page.goto("/admin/email");
  await expect(page.getByTestId("email-settings-panel")).toBeVisible();
  await expect(page.getByTestId("email-settings-status")).toContainText("Not configured");

  await page.locator("#resend-api-key").fill("re_test_key_123");
  await page.locator("#email-from").fill("Synapse <no-reply@x.com>");
  await page.getByTestId("email-settings-save").click();

  const status = page.getByTestId("email-settings-status");
  await expect(status).toContainText("Configured");
  await expect(status).toContainText("no-reply@x.com");

  // Clear reverts to the unconfigured state.
  await page.getByTestId("email-settings-clear").click();
  await expect(page.getByTestId("email-settings-status")).toContainText("Not configured");
});

test("non-admin cannot reach /admin/email", async ({ page, request }) => {
  await registerAdmin(page);
  await page.evaluate(() => window.localStorage.clear());

  // Second user = NOT instance admin (only the first registrant is).
  const adminLogin = await request.post(`${API_BASE}/v1/auth/login`, {
    data: { email: "admin@example.com", password: "strongpass123" },
  });
  expect(adminLogin.ok()).toBeTruthy();
  await request.post(`${API_BASE}/v1/auth/register`, {
    data: { email: "member@example.com", password: "strongpass123", name: "Member" },
  });

  await page.goto("/login");
  await page.locator("#login-email").fill("member@example.com");
  await page.locator("#login-password").fill("strongpass123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/teams\b/);

  await page.goto("/admin/email");
  await expect(page).toHaveURL(/\/teams\b/);
  await expect(page.getByTestId("email-settings-panel")).toHaveCount(0);
});
