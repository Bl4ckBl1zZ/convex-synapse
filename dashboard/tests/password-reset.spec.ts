import { test, expect, type Page } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import { Client } from "pg";
import { truncateAll } from "./helpers/db";

const DB_URL =
  process.env.SYNAPSE_DB_URL ||
  "postgres://synapse:synapse@localhost:5432/synapse";

// Password reset (v1.25+). The Go integration tests cover the email leg
// (recordingSender reads the link); the live compose stack has no Resend,
// so this spec mints the reset token straight into postgres — exactly the
// row forgot_password would create — and drives the UI from the link
// onward: /reset-password → new password → sign in with it. Plus the
// /forgot-password page states and the login-page entry link.

async function seedResetToken(email: string): Promise<string> {
  const plain = "syn_reset_" + randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(plain).digest("hex");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const res = await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       SELECT id, $2, now() + interval '1 hour' FROM users WHERE email = $1
       RETURNING id`,
      [email, hash],
    );
    if (res.rowCount !== 1) throw new Error(`no user with email ${email}`);
  } finally {
    await client.end();
  }
  return plain;
}

async function registerUser(page: Page): Promise<void> {
  await page.goto("/register");
  await page.locator("#register-email").fill("resetme@example.com");
  await page.locator("#register-password").fill("oldpassword123");
  await page.locator("#register-name").fill("Reset Me");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

test.beforeEach(async () => {
  await truncateAll();
});

test("reset link → new password → sign in with it", async ({ page }) => {
  await registerUser(page);
  await page.evaluate(() => window.localStorage.clear());

  const token = await seedResetToken("resetme@example.com");
  await page.goto(`/reset-password?token=${encodeURIComponent(token)}`);
  await expect(page.getByTestId("reset-password-form")).toBeVisible();

  // Mismatched confirmation is caught client-side, token untouched.
  // (Scope alerts to the form — Next's route announcer is role=alert too.)
  const resetForm = page.getByTestId("reset-password-form");
  await page.locator("#reset-password").fill("newpassword456");
  await page.locator("#reset-password-confirm").fill("different789");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(resetForm.getByRole("alert")).toContainText("match");

  await page.locator("#reset-password-confirm").fill("newpassword456");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByTestId("reset-password-done")).toBeVisible();
  await page.getByTestId("reset-password-signin").click();
  await expect(page).toHaveURL(/\/login\b/);

  // Old password is dead…
  await page.locator("#login-email").fill("resetme@example.com");
  await page.locator("#login-password").fill("oldpassword123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form").getByRole("alert")).toBeVisible();

  // …the new one signs in.
  await page.locator("#login-password").fill("newpassword456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
});

test("forgot-password page reachable from login and always confirms", async ({ page }) => {
  await registerUser(page);
  await page.evaluate(() => window.localStorage.clear());

  await page.goto("/login");
  await page.getByTestId("login-forgot-password").click();
  await expect(page).toHaveURL(/\/forgot-password\b/);

  // Unknown email gets the exact same confirmation — no account oracle.
  await page.locator("#forgot-email").fill("who-is-this@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByTestId("forgot-password-sent")).toBeVisible();
});

test("invalid and missing tokens are handled", async ({ page }) => {
  await registerUser(page);
  await page.evaluate(() => window.localStorage.clear());

  // Bogus token: the API's invalid_token error surfaces in the form.
  await page.goto("/reset-password?token=syn_reset_bogus");
  await page.locator("#reset-password").fill("newpassword456");
  await page.locator("#reset-password-confirm").fill("newpassword456");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(
    page.getByTestId("reset-password-form").getByRole("alert"),
  ).toContainText("invalid or expired");

  // No token at all: the page explains instead of rendering a dead form.
  await page.goto("/reset-password");
  await expect(page.getByTestId("reset-password-missing-token")).toBeVisible();
});
