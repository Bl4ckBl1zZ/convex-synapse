// v1.7.1+: when the deployment's URL falls back to the
// "<host>:<dynamic-port>" form (no custom domain + no
// SYNAPSE_BASE_DOMAIN), the embed page can't load the Convex Dashboard
// iframe because Caddy isn't TLS-fronting those dynamic ports. We
// render an explicit banner instead of an iframe that fails silently
// with the misleading "deployment URL or admin key is invalid" error.
//
// This spec stubs /v1/deployments/<name>/auth to return such a URL
// and verifies the banner shows, the iframe is gone, and the
// "Refresh credentials" button (which wouldn't help) is hidden.

import { test, expect, type Page, type Route } from "@playwright/test";
import { Client } from "pg";
import { truncateAll } from "./helpers/db";

const DB_URL =
  process.env.SYNAPSE_DB_URL ||
  "postgres://synapse:synapse@localhost:5432/synapse";

async function registerViaUI(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("ian@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Ian");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

// Bypass the UI flow for team+project creation — we're testing the
// embed page's URL-reachability logic, not the create-team / create-
// project funnel (which has its own specs). Seeding directly via SQL
// is cheaper and immune to dialog-locator changes.
async function seedTeamAndProject(): Promise<{ teamId: string; projectId: string }> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    const userRow = await c.query<{ id: string }>(
      `SELECT id FROM users ORDER BY created_at DESC LIMIT 1`,
    );
    if (!userRow.rows[0]) throw new Error("expected a registered user");
    const userId = userRow.rows[0].id;
    const teamRow = await c.query<{ id: string }>(
      `INSERT INTO teams (name, slug, creator_user_id, default_region)
       VALUES ($1, $2, $3, 'self-hosted')
       RETURNING id`,
      ["Embed Test Co", "embed-test-co", userId],
    );
    const teamId = teamRow.rows[0].id;
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [teamId, userId],
    );
    const projRow = await c.query<{ id: string }>(
      `INSERT INTO projects (team_id, name, slug)
       VALUES ($1, 'embed-test-proj', 'embed-test-proj')
       RETURNING id`,
      [teamId],
    );
    return { teamId, projectId: projRow.rows[0].id };
  } finally {
    await c.end();
  }
}

async function seedDeployment(
  projectId: string,
  name: string,
  hostPort: number,
): Promise<void> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    await c.query(
      `INSERT INTO deployments (project_id, name, deployment_type, status,
                                 admin_key, instance_secret, host_port,
                                 is_default, deployment_url, container_id)
       VALUES ($1, $2, 'dev', 'running', $3, 'fake-secret', $4, true, $5, $6)`,
      [
        projectId,
        name,
        `fake-admin-${name}`,
        hostPort,
        `http://127.0.0.1:${hostPort}`,
        `fake-container-${name}`,
      ],
    );
    await c.query(
      `INSERT INTO deployment_replicas (deployment_id, replica_index, container_id, host_port, status)
         SELECT id, 0, $2, $3, 'running' FROM deployments WHERE name = $1`,
      [name, `fake-container-${name}`, hostPort],
    );
  } finally {
    await c.end();
  }
}

test.beforeEach(async () => {
  await truncateAll();
});

test("embed: shows unreachable-URL banner when /auth returns a host:port URL", async ({
  page,
}) => {
  await registerViaUI(page);
  const { projectId } = await seedTeamAndProject();
  await seedDeployment(projectId, "broken-otter-9999", 3299);

  // Stub /auth to return the diagnostic-shaped URL the real backend
  // emits for deployments WITHOUT a custom domain or BASE_DOMAIN.
  await page.route(
    /\/v1\/deployments\/broken-otter-9999\/auth\b/,
    async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          deploymentName: "broken-otter-9999",
          deploymentType: "dev",
          // The exact shape `cliDeploymentURL` produces in this case.
          deploymentUrl: "https://synapsepanel.test:3299",
          adminKey: "broken-otter-9999|fake-key-for-test",
        }),
      });
    },
  );

  await page.goto("/embed/broken-otter-9999", { waitUntil: "load" });

  // Scope to the testid so other toasts / aria-live regions can't
  // strict-mode-collide with the banner lookup.
  const banner = page.getByTestId("unreachable-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/isn'?t browser-reachable/i);
  await expect(banner).toContainText("https://synapsepanel.test:3299");
  await expect(banner).toContainText("SYNAPSE_BASE_DOMAIN");
  await expect(banner).toContainText("broken-otter-9999");

  // The Convex Dashboard iframe must NOT be rendered (no escape hatch
  // for credentials makes sense — the URL itself is the problem).
  await expect(page.locator("iframe")).toHaveCount(0);

  // "Refresh credentials" button is hidden — reissuing the admin key
  // wouldn't fix the URL.
  await expect(
    page.getByRole("button", { name: /refresh credentials/i }),
  ).toHaveCount(0);
});

test("embed: localhost host:port URL is treated as reachable (local dev path)", async ({
  page,
}) => {
  await registerViaUI(page);
  const { projectId } = await seedTeamAndProject();
  await seedDeployment(projectId, "local-otter-9998", 3298);

  // In local dev, `cliDeploymentURL` emits http://localhost:3210 forms
  // — the operator's browser CAN reach localhost regardless of port,
  // so we treat it as reachable (the iframe gets rendered).
  await page.route(
    /\/v1\/deployments\/local-otter-9998\/auth\b/,
    async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          deploymentName: "local-otter-9998",
          deploymentType: "dev",
          deploymentUrl: "http://localhost:3298",
          adminKey: "local-otter-9998|fake-key-for-test",
        }),
      });
    },
  );

  await page.goto("/embed/local-otter-9998", { waitUntil: "load" });

  // No banner — iframe should render (even though we can't fully test
  // that the inner Convex Dashboard works, we assert the parent shell
  // didn't bail out).
  await expect(page.getByTestId("unreachable-banner")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(1);
});
