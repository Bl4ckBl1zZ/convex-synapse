import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// Regression spec for v1.8.1 Bug 2: a project URL pointing at a deleted
// or never-existed UUID used to render the full project chrome and
// cascade 5+ "Failed to load X: Project not found" red banners. The
// gate in app/teams/[team]/[project]/page.tsx replaces that with a
// single EmptyState. The team-page gate (same pattern) is covered too.

async function registerViaUI(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("ian@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Ian");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

async function createTeamViaUI(page: Page, name: string, slug: string) {
  await page.getByRole("button", { name: "Create team" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("link", { name: new RegExp(name, "i") })).toBeVisible();
  return slug;
}

test.beforeEach(async () => {
  await truncateAll();
});

test("project page: visiting a nonexistent project UUID shows EmptyState, not cascading errors", async ({ page }) => {
  await registerViaUI(page);
  await createTeamViaUI(page, "Amage", "amage");

  // Visit a project URL with a syntactically-valid but nonexistent UUID
  // under a team we DO own → backend returns 404 from GET
  // /v1/projects/{id}.
  await page.goto("/teams/amage/00000000-0000-0000-0000-000000000000");

  // The empty state should appear with the canonical copy.
  await expect(page.getByTestId("project-unavailable")).toBeVisible();
  await expect(page.getByText("Project unavailable")).toBeVisible();
  await expect(
    page.getByText("This project doesn't exist or you don't have access."),
  ).toBeVisible();

  // The "Back to projects" link goes back to the team home.
  const back = page.getByRole("link", { name: /back to projects/i });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute("href", "/teams/amage");

  // CRITICAL regression assertion: zero "Failed to load X" banners.
  // The whole point of the gate is to keep child panels from mounting.
  await expect(page.getByText(/Failed to load/i)).toHaveCount(0);
});

test("team page: visiting a nonexistent team slug shows EmptyState, not cascading panel errors", async ({ page }) => {
  await registerViaUI(page);

  await page.goto("/teams/this-team-does-not-exist");

  await expect(page.getByTestId("team-unavailable")).toBeVisible();
  await expect(page.getByText("Team unavailable")).toBeVisible();
  await expect(page.getByText(/doesn't exist or you don't have access/i)).toBeVisible();

  const back = page.getByRole("link", { name: /back to teams/i });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute("href", "/teams");

  await expect(page.getByText(/Failed to load/i)).toHaveCount(0);
});
