import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";
import { expandDeployment } from "./helpers/expand";
import { pruneSynapseContainers } from "./helpers/docker";

// Site-origin (v1.12) surfaces in three places this spec exercises:
//   1. CustomDomainsPanel role dropdown — must expose 'site' alongside
//      'api' and 'dashboard' (the regression this branch fixes).
//   2. Adding a role='site' domain — round-trips through the backend
//      (migration 000022 widened the role CHECK) and renders in the
//      list with the 'site' label.
//   3. Deployment row — when SYNAPSE_BASE_DOMAIN is configured, the
//      backend returns a distinct siteUrl which surfaces as the
//      "HTTP Actions URL" line. Without a base domain we skip cleanly
//      — host-port compose stacks legitimately have no site origin.
//
// Mirrors the setup/provision pattern from custom-domains.spec.ts and
// deployments.spec.ts. SYNAPSE_PUBLIC_IP is unset in the default
// compose so newly-added domains land at status='pending'; we assert
// against that shape rather than spinning up DNS.

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
}

async function provisionDeployment(page: Page): Promise<string> {
  await page
    .getByRole("button", { name: /create deployment/i })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();

  const nameLocator = page.getByText(/-[a-z]+-\d{4}/).first();
  await expect(nameLocator).toBeVisible({ timeout: 90_000 });
  const deploymentName = (await nameLocator.textContent())?.trim() ?? "";
  expect(deploymentName).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
  return deploymentName;
}

async function openDomainsPanel(page: Page, deploymentName: string) {
  // The panel toggle lives behind the card's expand chevron (v1.26).
  await expandDeployment(page, deploymentName);
  await page
    .getByRole("button", {
      name: `Manage custom domains for ${deploymentName}`,
    })
    .click();
  await expect(
    page.getByTestId(`custom-domains-panel-${deploymentName}`),
  ).toBeVisible();
}

test.beforeEach(async () => {
  await truncateAll();
  pruneSynapseContainers();
});

test.afterEach(async () => {
  pruneSynapseContainers();
});

test("site-origin: role dropdown exposes site option", async ({ page }) => {
  // Provisioning is the long pole; budget like the sibling specs.
  test.setTimeout(150_000);

  await setupProject(page);
  const deploymentName = await provisionDeployment(page);
  await openDomainsPanel(page, deploymentName);

  // Regression guard for fix/site-role-dropdown: the <select> must
  // expose all three roles. Reading option values directly so the
  // assertion fails loudly if any are dropped or relabeled.
  const roleSelect = page.getByTestId("custom-domain-role");
  await expect(roleSelect).toBeVisible();
  const values = await roleSelect.locator("option").evaluateAll((opts) =>
    (opts as HTMLOptionElement[]).map((o) => o.value),
  );
  expect(values).toEqual(expect.arrayContaining(["api", "site", "dashboard"]));
});

test("site-origin: add custom domain with role=site renders in list", async ({
  page,
}) => {
  test.setTimeout(150_000);

  await setupProject(page);
  const deploymentName = await provisionDeployment(page);
  await openDomainsPanel(page, deploymentName);

  // Synthetic hostname — randomised so a flaky cleanup leaves no
  // collision behind. Backend accepts any well-formed FQDN; without
  // SYNAPSE_PUBLIC_IP the row lands at status='pending', which is
  // the assertion target.
  const suffix = Math.random().toString(36).slice(2, 8);
  const domain = `site.example-${suffix}.test`;

  await page.getByTestId("custom-domain-input").fill(domain);
  await page.getByTestId("custom-domain-role").selectOption("site");
  await page.getByTestId("custom-domain-add").click();

  const row = page.getByTestId(`custom-domain-row-${domain}`);
  await expect(row).toBeVisible();
  // Role badge text is the raw role string (see CustomDomainsPanel
  // row rendering); 'site' must appear inside the row.
  await expect(row).toContainText(/\bsite\b/);
  await expect(
    page.getByTestId(`custom-domain-status-${domain}`),
  ).toHaveText(/pending|active/);
});

test("site-origin: deployment row shows HTTP Actions URL when base domain configured", async ({
  page,
}) => {
  // The siteUrl field on the deployment response is only populated when
  // the backend has SYNAPSE_BASE_DOMAIN set (or when a role='site'
  // custom domain is verified). The default compose stack doesn't set
  // a base domain, so skip cleanly rather than fail.
  const baseDomain = process.env.SYNAPSE_BASE_DOMAIN?.trim();
  test.skip(
    !baseDomain,
    "SYNAPSE_BASE_DOMAIN not configured — site origin uses host-port fallback",
  );

  test.setTimeout(180_000);

  await setupProject(page);
  const deploymentName = await provisionDeployment(page);

  // Project page already renders deployment rows once the row is
  // visible. The "HTTP Actions URL" label appears next to the cloud
  // URL when siteUrl is non-empty. Poll because siteUrl is only
  // returned once the provisioner has stamped the deployment.
  const row = page
    .getByText(deploymentName, { exact: false })
    .first()
    .locator("xpath=ancestor::*[self::li or self::div][1]");
  await expect(row).toBeVisible({ timeout: 120_000 });

  const siteLine = page.getByText(/HTTP Actions URL:/i).first();
  await expect(siteLine).toBeVisible({ timeout: 120_000 });
  // Self-hosted base domains follow the `<deployment>.<base>` pattern;
  // the convention puts site traffic under `.site.` per CONVEX_SITE_ORIGIN.md.
  await expect(siteLine).toContainText(/\.site\./);
});
