import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// v1.10.0 — Audit Log v2 + Activity Feed + per-project audit + Export.
//
// These specs mock the audit endpoints at the page-route level so they
// stay deterministic and offline. The Go integration tests
// (activity_test.go + the audit_log existing coverage) exercise the
// real backend; this spec validates the React surface.

async function registerViaUI(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("op@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Op");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

async function setupProject(page: Page): Promise<{ teamSlug: string; projectId: string }> {
  await registerViaUI(page);
  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Audit Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /audit co/i }).click();
  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("AuditProj");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /auditproj/i }).click();
  // SPA navigation via next/link — `await click()` does not wait for
  // history.pushState to settle, so reading page.url() immediately can
  // return the team page URL. Wait until the URL actually matches the
  // project pattern before parsing.
  await page.waitForURL(/\/teams\/[^/]+\/[0-9a-f-]{36}(?:\b|\/|$)/, {
    timeout: 10_000,
  });
  const m = page.url().match(/\/teams\/[^/]+\/([0-9a-f-]{36})/);
  if (!m) throw new Error(`unexpected project URL: ${page.url()}`);
  return { teamSlug: "audit-co", projectId: m[1] };
}

function buildActivityEvent(overrides: Record<string, unknown>) {
  return {
    id: "evt-1",
    createTime: new Date().toISOString(),
    action: "createDeployment",
    actorId: "user-1",
    actorEmail: "op@example.com",
    actorName: "Op",
    targetType: "deployment",
    targetId: "dep-1",
    targetName: "brave-dolphin-1060",
    metadata: { type: "dev" },
    ...overrides,
  };
}

test.beforeEach(async () => {
  await truncateAll();
});

/* ============================================================
   Wave A — ActivityFeed on the project home
   ============================================================ */

test("Wave A: ActivityFeed renders a single event with action verb + target", async ({ page }) => {
  const setup = await setupProject(page);
  await page.route(`**/v1/projects/${setup.projectId}/activity*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        events: [
          buildActivityEvent({
            action: "createDeployment",
            targetName: "brave-dolphin-1060",
          }),
        ],
      }),
    }),
  );
  await page.reload();
  const feed = page.getByTestId("activity-feed");
  await expect(feed).toBeVisible();
  await expect(feed).toContainText("Op");
  await expect(feed).toContainText("created");
  await expect(feed).toContainText("brave-dolphin-1060");
});

test("Wave A: ActivityFeed hides on empty events list", async ({ page }) => {
  const setup = await setupProject(page);
  await page.route(`**/v1/projects/${setup.projectId}/activity*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: [] }),
    }),
  );
  await page.reload();
  await expect(page.getByTestId("activity-feed")).toHaveCount(0);
});

test("Wave A: ActivityFeed collapses bursts into a single grouped row", async ({ page }) => {
  const setup = await setupProject(page);
  const t0 = Date.now();
  await page.route(`**/v1/projects/${setup.projectId}/activity*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        events: [
          buildActivityEvent({
            id: "evt-a",
            action: "createDeployment",
            targetName: "brave-dolphin-1060",
            createTime: new Date(t0).toISOString(),
          }),
          buildActivityEvent({
            id: "evt-b",
            action: "createDeployment",
            targetName: "wise-otter-2201",
            createTime: new Date(t0 - 60_000).toISOString(),
          }),
          buildActivityEvent({
            id: "evt-c",
            action: "createDeployment",
            targetName: "calm-fox-3300",
            createTime: new Date(t0 - 120_000).toISOString(),
          }),
        ],
      }),
    }),
  );
  await page.reload();
  // 3 identical-action events from same actor within 5min → 1 grouped row.
  const grouped = page.getByTestId(/activity-group-/);
  await expect(grouped).toHaveCount(1);
  await expect(grouped.first()).toContainText("3 deployment");
  await expect(grouped.first()).toContainText("brave-dolphin-1060");
  // Expanding shows all three target names.
  await grouped.first().getByRole("button").click();
  await expect(grouped.first()).toContainText("wise-otter-2201");
  await expect(grouped.first()).toContainText("calm-fox-3300");
});

/* ============================================================
   Wave B — Audit Log v2 (team) with filters + grouping + colors
   ============================================================ */

test("Wave B: team audit log shows filters + grouped-by-day rows", async ({ page }) => {
  await registerViaUI(page);
  // Build 3 events across 2 days (today + yesterday).
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  await page.route("**/v1/teams/audit-co/audit_log*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "e1",
            createTime: today.toISOString(),
            action: "createDeployment",
            actorEmail: "op@example.com",
            targetType: "deployment",
            targetId: "dep-1",
            metadata: { type: "dev" },
          },
          {
            id: "e2",
            createTime: today.toISOString(),
            action: "deleteDeployment",
            actorEmail: "op@example.com",
            targetType: "deployment",
            targetId: "dep-2",
          },
          {
            id: "e3",
            createTime: yesterday.toISOString(),
            action: "renameProject",
            actorEmail: "op@example.com",
            targetType: "project",
            targetId: "proj-1",
            metadata: { from: "Old", to: "New" },
          },
        ],
      }),
    }),
  );
  // Need a team to view the audit page. Create one with the matching slug.
  await page.getByRole("button", { name: "Create team" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Audit Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.goto("/teams/audit-co/audit");

  // Filters visible.
  await expect(page.getByTestId("audit-filters")).toBeVisible();
  await expect(page.getByTestId("audit-filter-search")).toBeVisible();

  // Grouped-by-day sections present (Today + Yesterday headers).
  const grouped = page.getByTestId("audit-log-grouped");
  await expect(grouped).toBeVisible();
  await expect(page.getByText("Today")).toBeVisible();
  await expect(page.getByText("Yesterday")).toBeVisible();

  // Rows for each event present.
  await expect(page.getByTestId("audit-row-e1")).toBeVisible();
  await expect(page.getByTestId("audit-row-e2")).toBeVisible();
  await expect(page.getByTestId("audit-row-e3")).toBeVisible();
});

test("Wave B: free-text search filters down rows", async ({ page }) => {
  await registerViaUI(page);
  await page.route("**/v1/teams/audit-co/audit_log*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "e1",
            createTime: new Date().toISOString(),
            action: "createDeployment",
            actorEmail: "op@example.com",
            targetType: "deployment",
            targetId: "dep-1",
            metadata: { name: "brave-dolphin-1060" },
          },
          {
            id: "e2",
            createTime: new Date().toISOString(),
            action: "renameProject",
            actorEmail: "op@example.com",
            targetType: "project",
            targetId: "proj-1",
            metadata: { from: "Old", to: "New" },
          },
        ],
      }),
    }),
  );
  await page.getByRole("button", { name: "Create team" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Audit Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.goto("/teams/audit-co/audit");

  await page.getByTestId("audit-filter-search").fill("dolphin");
  // Only e1 (metadata.name=brave-dolphin-1060) matches.
  await expect(page.getByTestId("audit-row-e1")).toBeVisible();
  await expect(page.getByTestId("audit-row-e2")).toHaveCount(0);
});

test("Wave B: clicking row expands metadata JSON", async ({ page }) => {
  await registerViaUI(page);
  await page.route("**/v1/teams/audit-co/audit_log*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "e1",
            createTime: new Date().toISOString(),
            action: "renameProject",
            actorEmail: "op@example.com",
            targetType: "project",
            targetId: "proj-1",
            metadata: { from: "Old", to: "New" },
          },
        ],
      }),
    }),
  );
  await page.getByRole("button", { name: "Create team" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Audit Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.goto("/teams/audit-co/audit");

  const row = page.getByTestId("audit-row-e1");
  await expect(row).toBeVisible();
  await row.getByRole("button").click();
  await expect(row).toContainText(/"from": "Old"/);
  await expect(row).toContainText(/"to": "New"/);
});

/* ============================================================
   Wave C — Per-project audit sub-tab
   ============================================================ */

test("Wave C: settings sidebar exposes Audit + page renders activity rows", async ({ page }) => {
  const setup = await setupProject(page);
  await page.route(`**/v1/projects/${setup.projectId}/activity*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        events: [
          {
            id: "p1",
            createTime: new Date().toISOString(),
            action: "createDeployment",
            actorEmail: "op@example.com",
            actorName: "Op",
            targetType: "deployment",
            targetId: "dep-1",
            targetName: "brave-dolphin-1060",
          },
        ],
      }),
    }),
  );

  await page.getByTestId("project-settings-link").click();
  await expect(page.getByTestId("project-settings-nav-audit")).toBeVisible();
  await page.getByTestId("project-settings-nav-audit").click();
  await expect(page).toHaveURL(
    new RegExp(`/teams/${setup.teamSlug}/${setup.projectId}/settings/audit\\b`),
  );
  await expect(page.getByTestId("audit-row-p1")).toBeVisible();
  await expect(page.getByText("brave-dolphin-1060").first()).toBeVisible();
});

/* ============================================================
   Wave D — Export button visible
   ============================================================ */

test("Wave D: export menu surfaces CSV + JSON when events exist", async ({ page }) => {
  await registerViaUI(page);
  await page.route("**/v1/teams/audit-co/audit_log*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "e1",
            createTime: new Date().toISOString(),
            action: "createDeployment",
            actorEmail: "op@example.com",
            targetType: "deployment",
            targetId: "dep-1",
          },
        ],
      }),
    }),
  );
  await page.getByRole("button", { name: "Create team" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Audit Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.goto("/teams/audit-co/audit");

  await page.getByTestId("audit-export-open").click();
  await expect(page.getByTestId("audit-export-csv")).toBeVisible();
  await expect(page.getByTestId("audit-export-json")).toBeVisible();
});
