import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";
import { pruneSynapseContainers } from "./helpers/docker";
import { expandDeployment } from "./helpers/expand";

// Per-deployment backups (v1.26+) — the REAL machinery end-to-end: a live
// Convex deployment, an actual `npx convex export` run in the transient
// node container (network + admin key + synapse-backups volume), the row
// flipping pending → complete with a real archive size, then a REAL
// `convex import --replace` restore stamping restoredAt. Slow by nature
// (npm fetch of the convex CLI inside the helper container) — this is the
// one spec that proves the feature against the real daemon, the same way
// resource-limits.spec.ts docker-inspects real caps.

async function setupProject(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("backups@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Backups");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);

  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Vault");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /vault/i }).click();

  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("Safe");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /safe/i }).click();
  await expect(page).toHaveURL(/\/teams\/vault\/[0-9a-f-]{36}\b/);
}

test.beforeEach(async () => {
  await truncateAll();
  pruneSynapseContainers();
});

test.afterEach(async () => {
  pruneSynapseContainers();
});

test("real backup → complete with size → real restore stamps restoredAt", async ({ page }) => {
  // Provision + real export + real import, each fetching the convex CLI
  // via npx inside a throwaway container. Generous budget.
  test.setTimeout(420_000);

  await setupProject(page);

  await page.getByRole("button", { name: /create deployment/i }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  const nameLocator = page.getByText(/-[a-z]+-\d{4}/).first();
  await expect(nameLocator).toBeVisible({ timeout: 90_000 });
  const name = (await nameLocator.textContent())?.trim() ?? "";

  // The action buttons + panels live behind the card's expand chevron
  // (v1.26); the Resize button (running-only) is the "running" signal
  // the backup gate needs.
  await expandDeployment(page, name);
  await expect(
    page.getByRole("button", { name: `Resize deployment ${name}` }),
  ).toBeVisible({ timeout: 90_000 });

  // Open the panel, set a daily schedule first (fast round-trip).
  await page.getByRole("button", { name: `Manage backups for ${name}` }).click();
  const panel = page.getByTestId(`backups-panel-${name}`);
  await expect(panel).toBeVisible();
  await expect(page.getByTestId(`backups-empty-${name}`)).toBeVisible();
  await page.locator(`#backup-schedule-${name}`).selectOption("daily");
  await page.locator(`#backup-retention-${name}`).fill("3");
  await page.getByTestId(`backup-settings-save-${name}`).click();
  await expect(page.getByTestId(`backups-daily-${name}`)).toBeVisible({ timeout: 15_000 });

  // Back up now → the row appears immediately (pending/running) and the
  // panel polls until the REAL export lands.
  await page.getByTestId(`backup-now-${name}`).click();
  const row = panel.locator("li").first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText("complete", { exact: true })).toBeVisible({ timeout: 240_000 });
  // A real archive size renders (a fresh deployment's snapshot is tiny —
  // a few hundred bytes — so B/KB/MB all count).
  await expect(row.getByText(/\d+(\.\d+)? (B|KB|MB)/)).toBeVisible();

  // Real restore: confirm() guards it; restoredAt lands when the import
  // container finishes.
  page.on("dialog", (d) => d.accept());
  await row.getByRole("button", { name: /^Restore backup from/ }).click();
  await expect(row.getByText(/^restored /)).toBeVisible({ timeout: 240_000 });
});
