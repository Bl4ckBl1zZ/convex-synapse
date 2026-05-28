import { test, expect, type Page, type Route } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// Phase 5 (Remote Hosts v1.18+) — exercises the dashboard wiring for
// `POST /v1/hosts/{id}/remote_setup`:
//   * the per-row "Setup remote install" button only shows for
//     non-synapse hosts,
//   * clicking it opens the modal, renders the one-liner, and exposes
//     the copy button + dialog hooks.
//
// The backend half (Headscale integration + audit) has its own Go
// integration coverage under synapse/internal/test/remote_setup_test.go;
// this spec covers ONLY the UI wiring by stubbing the API surface at
// the page-route level — no real Headscale or backend behaviour is
// required.

test.beforeEach(async () => {
  await truncateAll();
});

// The HostsPanel renders on /teams/<team>/<project>; we register an
// admin (first user, auto-promoted by /v1/auth/register), then drive
// them to a real project page. Mocking /v1/hosts at the route level
// lets us inject a synthetic "vps-eu-1" row without spinning up a
// Headscale instance.
async function registerAdmin(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("admin@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Instance Admin");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

// Stubs GET /v1/hosts with two rows — the synapse self-host and one
// remote (non-self) host. POST /v1/hosts/{id}/remote_setup is stubbed
// separately by each test that exercises the bundle response.
async function mockHostsList(page: Page) {
  await page.route(/\/v1\/hosts(\?.*)?$/, async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: "11111111-1111-1111-1111-111111111111",
              name: "synapsepanel",
              provider: "self-hosted",
              region: "",
              labels: {},
              status: "online",
              effectiveStatus: "online",
              isSynapseHost: true,
              isRemote: false,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
            {
              id: "22222222-2222-2222-2222-222222222222",
              name: "vps-eu-1",
              provider: "remote",
              region: "",
              labels: {},
              status: "unknown",
              effectiveStatus: "unknown",
              isSynapseHost: false,
              isRemote: true,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
        }),
      });
      return;
    }
    await route.continue();
  });
}

// Drives the admin from /teams through team-create + project-create
// flows so HostsPanel renders. Returns once the panel is visible —
// every test that follows builds on this navigation.
async function openProjectPage(page: Page) {
  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Acme");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /acme/i }).click();

  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("Remote");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /remote/i }).click();

  await expect(page).toHaveURL(/\/teams\/acme\/[0-9a-f-]{36}\b/);
  // HostsPanel renders below the deployments list.
  await expect(page.getByTestId("hosts-panel")).toBeVisible();
}

test("hosts panel shows 'Setup remote install' button only for non-self hosts", async ({
  page,
}) => {
  await registerAdmin(page);
  await mockHostsList(page);
  await openProjectPage(page);

  // The remote host row exposes the button…
  await expect(page.getByTestId("setup-remote-vps-eu-1")).toBeVisible();
  // …while the self-host row does not (gated on !host.isSynapseHost).
  await expect(page.getByTestId("setup-remote-synapsepanel")).toHaveCount(0);
});

test("clicking 'Setup remote install' renders the one-liner with copy button", async ({
  page,
}) => {
  await registerAdmin(page);
  await mockHostsList(page);

  await page.route(
    "**/v1/hosts/22222222-2222-2222-2222-222222222222/remote_setup",
    async (route: Route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            adoptionToken: "syn_adopt_testtoken",
            headscaleAuthKey: "hs-key-xyz",
            controlUrl: "https://synapsepanel.example.com",
            headscaleServerUrl: "https://headscale.example.com",
            oneLiner:
              "curl -fsSL https://synapsepanel.example.com/install-agent.sh | sudo bash -s -- --control-url=https://synapsepanel.example.com --headscale-auth=hs-key-xyz --adoption-token=syn_adopt_testtoken",
            expiresAt: "2099-01-01T00:00:00Z",
          }),
        });
        return;
      }
      await route.continue();
    },
  );

  await openProjectPage(page);

  await page.getByTestId("setup-remote-vps-eu-1").click();
  await expect(page.getByTestId("remote-setup-dialog")).toBeVisible();

  // The dialog starts in the "Generate" state — click through to mint
  // the bundle (the page-route stub answers the POST immediately).
  await page.getByRole("button", { name: /Generate one-liner/i }).click();

  await expect(page.getByTestId("remote-setup-result")).toBeVisible();
  const oneliner = page.getByTestId("remote-setup-oneliner");
  await expect(oneliner).toBeVisible();
  await expect(oneliner).toContainText("install-agent.sh");
  await expect(oneliner).toContainText("--adoption-token=");
  await expect(oneliner).toContainText("--headscale-auth=hs-key-xyz");

  // Copy button is rendered.
  await expect(page.getByTestId("remote-setup-copy")).toBeVisible();
});

test("remote_hosts_disabled response surfaces the setup.sh hint", async ({
  page,
}) => {
  await registerAdmin(page);
  await mockHostsList(page);

  await page.route(
    "**/v1/hosts/22222222-2222-2222-2222-222222222222/remote_setup",
    async (route: Route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "remote_hosts_disabled",
            message:
              "Remote Hosts not enabled — run setup.sh --enable-headscale on the control plane host",
          }),
        });
        return;
      }
      await route.continue();
    },
  );

  await openProjectPage(page);
  await page.getByTestId("setup-remote-vps-eu-1").click();
  await page.getByRole("button", { name: /Generate one-liner/i }).click();

  // Error surface points the operator at the setup.sh fix.
  await expect(page.getByTestId("remote-setup-error")).toBeVisible();
  await expect(page.getByTestId("remote-setup-dialog")).toContainText(
    "setup.sh --enable-headscale",
  );
});
