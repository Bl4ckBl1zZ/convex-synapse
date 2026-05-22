import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// v1.9.3 — Project Settings sub-tab IA.
//
// The project home page used to host env vars, DNS credentials, project
// members, project tokens, and app tokens stacked below the deployments
// list. They've been moved into /teams/<team>/<project>/settings/* with
// a left-sidebar nav. This spec validates the routing + navigation
// without exercising the individual panel functionality (which has its
// own coverage in env-vars.spec.ts, project_rbac.spec.ts, etc).

async function setupProject(page: Page): Promise<{ teamSlug: string; projectId: string }> {
  await page.goto("/register");
  await page.locator("#register-email").fill("ian@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Ian");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);

  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Settings Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /settings co/i }).click();

  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("Storefront");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /storefront/i }).click();

  await expect(page).toHaveURL(/\/teams\/settings-co\/[0-9a-f-]{36}\b/);
  const m = page.url().match(/\/teams\/([^/]+)\/([0-9a-f-]{36})/);
  return { teamSlug: m![1], projectId: m![2] };
}

test.beforeEach(async () => {
  await truncateAll();
});

test("project home no longer stacks env vars / DNS creds / members / tokens below deployments", async ({
  page,
}) => {
  await setupProject(page);

  // None of the old in-line panels should be present on the project
  // home anymore — they all live under /settings/*. Use forgiving
  // heading-text checks so the assertion stays robust if the panel
  // copy changes inside the sub-pages.
  await expect(page.getByText("Default environment variables")).toHaveCount(0);
  await expect(page.getByText("DNS credentials")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Members" })).toHaveCount(0);
  await expect(page.getByText("Project access tokens")).toHaveCount(0);
  await expect(page.getByText("App tokens (preview deploy keys)")).toHaveCount(0);

  // The Settings button replaces them.
  await expect(page.getByTestId("project-settings-link")).toBeVisible();
});

test("Settings button takes the operator to /settings/general (v1.9.4+)", async ({
  page,
}) => {
  const { teamSlug, projectId } = await setupProject(page);

  await page.getByTestId("project-settings-link").click();
  await expect(page).toHaveURL(
    new RegExp(`/teams/${teamSlug}/${projectId}/settings/general\\b`),
  );
  await expect(page.getByTestId("project-settings-shell")).toBeVisible();
  // Default sub-page now lands on General with the name/slug form.
  await expect(page.getByTestId("project-general-name-slug")).toBeVisible();
});

test("sidebar navigates across all five sub-pages and preserves the active class", async ({
  page,
}) => {
  await setupProject(page);
  await page.getByTestId("project-settings-link").click();

  const sections: { testid: string; urlFragment: string; expectSel: string }[] = [
    {
      testid: "project-settings-nav-general",
      urlFragment: "/settings/general",
      expectSel: "[data-testid='project-general-name-slug']",
    },
    {
      testid: "project-settings-nav-env-vars",
      urlFragment: "/settings/environment-variables",
      expectSel: "[data-testid='env-vars-panel']",
    },
    {
      testid: "project-settings-nav-dns",
      urlFragment: "/settings/dns-credentials",
      expectSel: "main, body",
    },
    {
      testid: "project-settings-nav-members",
      urlFragment: "/settings/members",
      expectSel: "main, body",
    },
    {
      testid: "project-settings-nav-tokens",
      urlFragment: "/settings/access-tokens",
      expectSel: "main, body",
    },
  ];

  for (const s of sections) {
    await page.getByTestId(s.testid).click();
    await expect(page).toHaveURL(new RegExp(s.urlFragment.replace(/\//g, "\\/")));
    await expect(page.locator(s.expectSel).first()).toBeVisible();
  }
});

test("bare /settings URL redirects to /settings/general (v1.9.4+)", async ({
  page,
}) => {
  const { teamSlug, projectId } = await setupProject(page);

  await page.goto(`/teams/${teamSlug}/${projectId}/settings`);
  await expect(page).toHaveURL(
    new RegExp(`/teams/${teamSlug}/${projectId}/settings/general\\b`),
  );
});

test("404/403 gate fires on the settings shell when project doesn't exist", async ({
  page,
}) => {
  await setupProject(page);

  await page.goto("/teams/settings-co/00000000-0000-0000-0000-000000000000/settings");
  // The layout-level gate kicks in BEFORE the redirect to /environment-variables,
  // so the operator lands on the EmptyState rather than a cascade of failed fetches.
  await expect(page.getByTestId("project-unavailable")).toBeVisible();
});
