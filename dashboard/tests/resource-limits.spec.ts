import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { truncateAll } from "./helpers/db";
import { pruneSynapseContainers } from "./helpers/docker";
import { expandDeployment } from "./helpers/expand";

// Per-deployment CPU/RAM limits (v1.25+). Drives the REAL stack end-to-end:
// create with limits → row badge → docker actually enforces them (inspect
// HostConfig) → resize through the dialog (container recreate) → clear back
// to unlimited. Validation bounds + the 409 gates (adopted/HA/remote) are
// covered by the Go integration tests in deployment_resources_test.go.

async function setupProject(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("limits@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Limits");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);

  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Capacity");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /capacity/i }).click();

  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("Caps");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /caps/i }).click();
  await expect(page).toHaveURL(/\/teams\/capacity\/[0-9a-f-]{36}\b/);
}

// Reads the limits Docker is actually enforcing on the live container.
function inspectLimits(name: string): { nanoCpus: number; memory: number } {
  const out = execSync(
    `docker inspect -f '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' convex-${name}`,
    { encoding: "utf8" },
  ).trim();
  const [nanoCpus, memory] = out.split(/\s+/).map(Number);
  return { nanoCpus, memory };
}

test.beforeEach(async () => {
  await truncateAll();
  pruneSynapseContainers();
});

test.afterEach(async () => {
  pruneSynapseContainers();
});

test("limits: create → docker enforces → resize → clear to unlimited", async ({ page }) => {
  // Real provisioning (twice: create + resize recreate) — generous budget
  // for full-suite runs that queue behind earlier provisioner jobs.
  test.setTimeout(240_000);

  await setupProject(page);

  await page.getByRole("button", { name: /create deployment/i }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#create-cpus").fill("0.5");
  await dialog.locator("#create-memory-mb").fill("512");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  const nameLocator = page.getByText(/-[a-z]+-\d{4}/).first();
  await expect(nameLocator).toBeVisible({ timeout: 90_000 });
  const name = (await nameLocator.textContent())?.trim() ?? "";
  expect(name).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);

  const badge = page.getByTestId(`deployment-limits-${name}`);
  await expect(badge).toHaveText("0.5 CPU · 512 MB");

  // The action buttons live behind the card's expand chevron (v1.25).
  await expandDeployment(page, name);

  // Resize only renders once the row is running (the recreate path needs a
  // live container) — this doubles as the provisioning wait.
  const resizeBtn = page.getByRole("button", { name: `Resize deployment ${name}` });
  await expect(resizeBtn).toBeVisible({ timeout: 90_000 });

  // The REAL container carries the caps: 0.5 CPU = 5e8 NanoCpus, 512 MB.
  expect(inspectLimits(name)).toEqual({ nanoCpus: 5e8, memory: 512 * 1024 * 1024 });

  // Resize to 1 CPU / 1024 MB. The dialog prefills the current values.
  await resizeBtn.click();
  const form = page.getByTestId("resize-form");
  await expect(form).toBeVisible();
  await expect(page.locator("#resize-cpus")).toHaveValue("0.5");
  await expect(page.locator("#resize-memory-mb")).toHaveValue("512");
  await page.locator("#resize-cpus").fill("1");
  await page.locator("#resize-memory-mb").fill("1024");
  await page.getByTestId("resize-apply").click();
  await expect(form).toBeHidden({ timeout: 90_000 });
  await expect(badge).toHaveText("1 CPU · 1024 MB");
  expect(inspectLimits(name)).toEqual({ nanoCpus: 1e9, memory: 1024 * 1024 * 1024 });

  // Clear both fields → unlimited: badge disappears, docker uncaps.
  await page.getByRole("button", { name: `Resize deployment ${name}` }).click();
  await page.locator("#resize-cpus").fill("");
  await page.locator("#resize-memory-mb").fill("");
  await page.getByTestId("resize-apply").click();
  await expect(page.getByTestId("resize-form")).toBeHidden({ timeout: 90_000 });
  await expect(page.getByTestId(`deployment-limits-${name}`)).toHaveCount(0);
  expect(inspectLimits(name)).toEqual({ nanoCpus: 0, memory: 0 });
});
