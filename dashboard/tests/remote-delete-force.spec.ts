// Regression for the "delete modal hangs forever on a failed remote
// deployment" report. We can't make a real VPS unreachable in CI, so we
// mock the delete endpoint to return the bounded-failure the backend now
// emits (502 remote_teardown_failed) and assert the dashboard's reaction:
// a "Force delete" affordance that re-issues the request with ?force=true.
//
// list_deployments is mocked too (stateful) so the failed remote row
// renders and then disappears once the force delete lands — the real
// backend never had this deployment.

import { test, expect, type Page, type Route } from "@playwright/test";
import { truncateAll } from "./helpers/db";
import { expandDeployment } from "./helpers/expand";

const DEP_NAME = "bright-raccoon-5185";

async function setupProject(page: Page): Promise<string> {
  await page.goto("/register");
  await page.locator("#register-email").fill("force-delete@example.com");
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
  const m = page.url().match(/\/teams\/amage\/([0-9a-f-]{36})\b/);
  if (!m) throw new Error(`projectId not found in URL: ${page.url()}`);
  return m[1];
}

test.beforeEach(async () => {
  await truncateAll();
});

test("force-delete removes a deployment stranded on an unreachable remote host", async ({
  page,
}) => {
  const projectId = await setupProject(page);

  const remoteDep = {
    id: "11111111-1111-1111-1111-111111111111",
    name: DEP_NAME,
    projectId,
    deploymentType: "dev",
    status: "failed",
    deploymentUrl: `https://synapsepanel.com/d/${DEP_NAME}`,
    isDefault: true,
    hostId: "22222222-2222-2222-2222-222222222222",
    hostName: "JUMPY-WORKER-1",
    hostIsRemote: true,
  };

  let deleted = false;
  await page.route(
    `**/v1/projects/${projectId}/list_deployments**`,
    (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(deleted ? [] : [remoteDep]),
      }),
  );

  let plainCalled = false;
  let forceCalled = false;
  await page.route(`**/v1/deployments/${DEP_NAME}/delete**`, (route: Route) => {
    const forced = route.request().url().includes("force=true");
    if (forced) {
      forceCalled = true;
      deleted = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ name: DEP_NAME, status: "deleted" }),
      });
    }
    plainCalled = true;
    return route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        code: "remote_teardown_failed",
        message:
          'Couldn\'t reach host "JUMPY-WORKER-1" to tear down the container (context deadline exceeded). The host may be down. Retry once it\'s back, or force-delete to remove the record now.',
      }),
    });
  });

  // Re-render the project page so the mocked list_deployments takes effect.
  await page.reload();
  // The Delete button lives behind the card's expand chevron (v1.25).
  await expandDeployment(page, DEP_NAME);
  const deleteBtn = page.getByRole("button", {
    name: new RegExp(`delete deployment ${DEP_NAME}`, "i"),
  });
  await expect(deleteBtn).toBeVisible();

  // First attempt: plain delete → bounded 502, no hang, Force delete appears.
  await deleteBtn.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-delete-deployment").click();

  const forceBtn = dialog.getByTestId("force-delete-deployment");
  await expect(forceBtn).toBeVisible();
  await expect(dialog.getByText(/couldn't reach host/i)).toBeVisible();
  expect(plainCalled).toBe(true);
  expect(forceCalled).toBe(false);

  // Force delete → ?force=true → row dropped, dialog closes, card gone.
  await forceBtn.click();
  await expect(dialog).toBeHidden();
  await expect(deleteBtn).toHaveCount(0);
  expect(forceCalled).toBe(true);
});
