import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

const API_BASE = process.env.SYNAPSE_API_URL || "http://localhost:8080";

// Admin → Alerts (v1.26+). Exercises components/AlertSettingsPanel.tsx at
// /admin/alerts against the REAL backend (unlike admin-email, alert
// settings need no SYNAPSE_STORAGE_KEY, so the live handler works in the
// compose stack). The notification side (health worker → webhook/email) is
// covered by the Go integration tests in internal/test/health_alert_test.go;
// this spec covers the UI wiring: render → save → masked hint →
// keep-on-blank semantics → remove webhook → reset, plus the admin gate.

async function registerAdmin(page: Page): Promise<void> {
  await page.goto("/register");
  await page.locator("#register-email").fill("admin@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Instance Admin");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

test.beforeEach(async () => {
  await truncateAll();
});

test("admin configures deployment alerts end-to-end", async ({ page }) => {
  await registerAdmin(page);
  // Remove-webhook and reset both pop a confirm() — accept every dialog.
  page.on("dialog", (d) => d.accept());

  // Reachable from the admin nav, not just by URL.
  await page.goto("/admin/host-domain");
  await page.getByTestId("admin-nav-alerts").click();
  await expect(page).toHaveURL(/\/admin\/alerts\b/);

  // Fresh install defaults: email on, no webhook, nothing to reset.
  const status = page.getByTestId("alert-settings-status");
  await expect(page.getByTestId("alert-settings-panel")).toBeVisible();
  await expect(status).toContainText("Email alerts on");
  await expect(status).toContainText("No webhook");
  await expect(page.getByTestId("alert-settings-clear")).toHaveCount(0);

  // Save a Slack-shaped webhook and turn email off. The hint must keep
  // the host (recognizable) but never echo the secret path.
  await page.locator("#alert-webhook-url").fill("https://hooks.slack.com/services/T1/B1/secret123");
  await page.locator("#alert-email-enabled").uncheck();
  await page.getByTestId("alert-settings-save").click();
  await expect(status).toContainText("Email alerts off");
  await expect(status).toContainText("Webhook configured");
  await expect(page.getByTestId("alert-settings-webhook-hint")).toContainText("hooks.slack.com");
  await expect(page.getByTestId("alert-settings-webhook-hint")).not.toContainText("secret123");

  // Toggle email back on with the webhook input BLANK — the saved webhook
  // must survive (blank = keep; the server never returns the URL to resend).
  await page.locator("#alert-email-enabled").check();
  await page.getByTestId("alert-settings-save").click();
  await expect(status).toContainText("Email alerts on");
  await expect(status).toContainText("Webhook configured");

  // Remove webhook → email-only alerting.
  await page.getByTestId("alert-settings-remove-webhook").click();
  await expect(status).toContainText("No webhook");

  // Reset to defaults → row deleted, back to the fresh-install state.
  await page.getByTestId("alert-settings-clear").click();
  await expect(status).toContainText("Email alerts on");
  await expect(status).toContainText("No webhook");
  await expect(page.getByTestId("alert-settings-clear")).toHaveCount(0);
});

test("invalid webhook URL surfaces the API error", async ({ page }) => {
  await registerAdmin(page);
  await page.goto("/admin/alerts");
  await expect(page.getByTestId("alert-settings-panel")).toBeVisible();

  await page.locator("#alert-webhook-url").fill("not-a-url");
  await page.getByTestId("alert-settings-save").click();
  await expect(page.getByTestId("alert-settings-form")).toContainText("http(s)");
  // Still unconfigured.
  await expect(page.getByTestId("alert-settings-status")).toContainText("No webhook");
});

test("non-admin cannot reach /admin/alerts", async ({ page, request }) => {
  await registerAdmin(page);
  await page.evaluate(() => window.localStorage.clear());

  // Second user = NOT instance admin (only the first registrant is).
  await request.post(`${API_BASE}/v1/auth/register`, {
    data: { email: "member@example.com", password: "strongpass123", name: "Member" },
  });

  await page.goto("/login");
  await page.locator("#login-email").fill("member@example.com");
  await page.locator("#login-password").fill("strongpass123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/teams\b/);

  await page.goto("/admin/alerts");
  await expect(page).toHaveURL(/\/teams\b/);
  await expect(page.getByTestId("alert-settings-panel")).toHaveCount(0);
});
