import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type Route,
} from "@playwright/test";
import { truncateAll } from "./helpers/db";

const API_BASE = process.env.SYNAPSE_API_URL || "http://localhost:8080";

// Admin → Remote Hosts panel (v1.19+). Exercises the new
// components/RemoteHostsAdminPanel.tsx mounted at /admin/remote-hosts.
//
// The full apply path shells the synapse-updater daemon, which we can't
// invoke from a Playwright run. We mock /v1/admin/headscale at the
// page-route level so this spec covers the UI wiring; the underlying
// Go integration tests cover the backend half.

async function registerAdmin(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("admin@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Instance Admin");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

async function seedSecondUser(
  request: APIRequestContext,
  email: string,
  name: string,
): Promise<void> {
  const adminLogin = await request.post(`${API_BASE}/v1/auth/login`, {
    data: { email: "admin@example.com", password: "strongpass123" },
  });
  if (!adminLogin.ok()) {
    throw new Error(`admin login failed: ${adminLogin.status()}`);
  }
  const reg = await request.post(`${API_BASE}/v1/auth/register`, {
    data: { email, password: "strongpass123", name },
  });
  if (!reg.ok()) {
    throw new Error(`register ${email} failed: ${reg.status()}`);
  }
}

async function mockHeadscaleGet(
  page: Page,
  body: Record<string, unknown>,
): Promise<void> {
  await page.route("**/v1/admin/headscale", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
    await route.continue();
  });
}


async function mockHeadscaleStatus(
  page: Page,
  jobId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await page.route(
    `**/v1/admin/headscale/status/${jobId}`,
    async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    },
  );
}

test.beforeEach(async () => {
  await truncateAll();
});

test("non-admin is redirected away from /admin/remote-hosts", async ({
  page,
  request,
}) => {
  await page.goto("/register");
  await page.locator("#register-email").fill("admin@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Admin");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);

  await page.evaluate(() => window.localStorage.clear());
  await seedSecondUser(request, "member@example.com", "Member");
  await page.goto("/login");
  await page.locator("#login-email").fill("member@example.com");
  await page.locator("#login-password").fill("strongpass123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/teams\b/);

  await page.goto("/admin/remote-hosts");
  await expect(page).toHaveURL(/\/teams\b/);
  await expect(page.getByTestId("remote-hosts-admin-panel")).toHaveCount(0);
});

test("admin sees the Remote Hosts nav item and renders disabled state", async ({
  page,
}) => {
  await registerAdmin(page);

  await mockHeadscaleGet(page, {
    enabled: false,
    configured: false,
    remoteProvisioningReady: false,
    needsApiRestart: false,
    updaterAvailable: true,
    hostDomain: "synapsepanel.com",
    baseDomain: "app.synapsepanel.com",
    publicIp: "1.2.3.4",
    defaultDomain: "headscale.synapsepanel.com",
    dnsCredentialAvailable: false,
  });

  await page.goto("/admin/remote-hosts");
  await expect(page.getByTestId("admin-nav-remote-hosts")).toBeVisible();
  await expect(page.getByTestId("remote-hosts-admin-panel")).toBeVisible();
  await expect(page.getByTestId("remote-hosts-status-badge")).toContainText(
    /not configured/i,
  );
  await expect(page.getByTestId("remote-hosts-configure-open")).toBeVisible();
});

test("missing host domain surfaces a link to Admin → Host domain", async ({
  page,
}) => {
  await registerAdmin(page);

  // No hostDomain, no baseDomain — the panel should refuse to show
  // the configure button and route the operator at /admin/host-domain.
  await mockHeadscaleGet(page, {
    enabled: false,
    configured: false,
    remoteProvisioningReady: false,
    needsApiRestart: false,
    updaterAvailable: true,
    dnsCredentialAvailable: false,
  });

  await page.goto("/admin/remote-hosts");
  await expect(page.getByTestId("remote-hosts-needs-host-domain")).toBeVisible();
  const link = page.getByTestId("remote-hosts-host-domain-link");
  await expect(link).toHaveAttribute("href", "/admin/host-domain");
  await expect(page.getByTestId("remote-hosts-configure-open")).toHaveCount(0);
});

test("default subdomain prefers SYNAPSE_DOMAIN over the deployments wildcard", async ({
  page,
}) => {
  await registerAdmin(page);

  // The v1.19 correctness fix: with hostDomain=synapsepanel.com AND
  // baseDomain=app.synapsepanel.com, the backend returns
  // defaultDomain=headscale.synapsepanel.com (NOT
  // headscale.app.synapsepanel.com). The panel pre-fills the form
  // with this value.
  await mockHeadscaleGet(page, {
    enabled: false,
    configured: false,
    remoteProvisioningReady: false,
    needsApiRestart: false,
    updaterAvailable: true,
    hostDomain: "synapsepanel.com",
    baseDomain: "app.synapsepanel.com",
    publicIp: "1.2.3.4",
    defaultDomain: "headscale.synapsepanel.com",
    dnsCredentialAvailable: false,
  });

  await page.goto("/admin/remote-hosts");
  await page.getByTestId("remote-hosts-configure-open").click();
  await expect(page.getByTestId("remote-hosts-domain-input")).toHaveValue(
    "headscale.synapsepanel.com",
  );
});

test("manual DNS step renders when no Cloudflare credential is available", async ({
  page,
}) => {
  await registerAdmin(page);

  await mockHeadscaleGet(page, {
    enabled: false,
    configured: false,
    remoteProvisioningReady: false,
    needsApiRestart: false,
    updaterAvailable: true,
    hostDomain: "synapsepanel.com",
    publicIp: "1.2.3.4",
    defaultDomain: "headscale.synapsepanel.com",
    dnsCredentialAvailable: false,
  });

  await page.goto("/admin/remote-hosts");
  await page.getByTestId("remote-hosts-configure-open").click();
  await expect(page.getByTestId("remote-hosts-manual-dns")).toContainText(
    "headscale.synapsepanel.com",
  );
  await expect(page.getByTestId("remote-hosts-manual-dns")).toContainText(
    "1.2.3.4",
  );
  // The auto-DNS checkbox is HIDDEN when no credential covers the host.
  await expect(page.getByTestId("remote-hosts-auto-dns")).toHaveCount(0);
});

test("auto-DNS checkbox renders when a Cloudflare credential is available", async ({
  page,
}) => {
  await registerAdmin(page);

  await mockHeadscaleGet(page, {
    enabled: false,
    configured: false,
    remoteProvisioningReady: false,
    needsApiRestart: false,
    updaterAvailable: true,
    hostDomain: "synapsepanel.com",
    publicIp: "1.2.3.4",
    defaultDomain: "headscale.synapsepanel.com",
    dnsCredentialAvailable: true,
  });

  await page.goto("/admin/remote-hosts");
  await page.getByTestId("remote-hosts-configure-open").click();
  await expect(page.getByTestId("remote-hosts-auto-dns")).toBeVisible();
  await expect(page.getByTestId("remote-hosts-manual-dns")).toHaveCount(0);
});

test("apply flow posts the configured body and opens the polling dialog", async ({
  page,
}) => {
  await registerAdmin(page);

  await mockHeadscaleGet(page, {
    enabled: false,
    configured: false,
    remoteProvisioningReady: false,
    needsApiRestart: false,
    updaterAvailable: true,
    hostDomain: "synapsepanel.com",
    publicIp: "1.2.3.4",
    defaultDomain: "headscale.synapsepanel.com",
    dnsCredentialAvailable: false,
  });

  let configureBody: unknown = null;
  await page.route(
    "**/v1/admin/headscale/configure",
    async (route: Route) => {
      if (route.request().method() === "POST") {
        configureBody = route.request().postDataJSON();
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            jobId: "job-1",
            statusUrl: "/v1/admin/headscale/status/job-1",
            state: "queued",
            domain: "headscale.synapsepanel.com",
            serverUrl: "https://headscale.synapsepanel.com",
          }),
        });
        return;
      }
      await route.continue();
    },
  );
  await mockHeadscaleStatus(page, "job-1", {
    id: "job-1",
    state: "running",
    log: "starting setup.sh\nrendering headscale config\n",
    createdAt: new Date().toISOString(),
  });

  await page.goto("/admin/remote-hosts");
  await page.getByTestId("remote-hosts-configure-open").click();
  await page.getByTestId("remote-hosts-apply").click();
  // Confirm dialog appears first.
  await expect(page.getByTestId("remote-hosts-confirm-dialog")).toBeVisible();
  await page.getByTestId("remote-hosts-confirm-apply").click();

  // Apply dialog opens and renders the polled state.
  await expect(page.getByTestId("remote-hosts-apply-dialog")).toBeVisible();
  await expect(page.getByTestId("remote-hosts-job-state")).toContainText(
    /running/i,
  );

  // The body the panel posted carries the form's domain (no auto-DNS
  // because the credential check was false).
  expect(configureBody).toEqual({
    headscaleDomain: "headscale.synapsepanel.com",
  });
});

test("explicit subdomain override travels through to the configure body", async ({
  page,
}) => {
  await registerAdmin(page);

  await mockHeadscaleGet(page, {
    enabled: false,
    configured: false,
    remoteProvisioningReady: false,
    needsApiRestart: false,
    updaterAvailable: true,
    hostDomain: "synapsepanel.com",
    publicIp: "1.2.3.4",
    defaultDomain: "headscale.synapsepanel.com",
    dnsCredentialAvailable: false,
  });

  let configureBody: unknown = null;
  await page.route(
    "**/v1/admin/headscale/configure",
    async (route: Route) => {
      if (route.request().method() === "POST") {
        configureBody = route.request().postDataJSON();
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            jobId: "job-2",
            statusUrl: "/v1/admin/headscale/status/job-2",
            state: "queued",
          }),
        });
        return;
      }
      await route.continue();
    },
  );
  await mockHeadscaleStatus(page, "job-2", {
    id: "job-2",
    state: "running",
    log: "",
  });

  await page.goto("/admin/remote-hosts");
  await page.getByTestId("remote-hosts-configure-open").click();
  await page
    .getByTestId("remote-hosts-domain-input")
    .fill("tailscale-control.example.org");
  await page.getByTestId("remote-hosts-apply").click();
  await page.getByTestId("remote-hosts-confirm-apply").click();

  await expect(page.getByTestId("remote-hosts-apply-dialog")).toBeVisible();
  expect(configureBody).toEqual({
    headscaleDomain: "tailscale-control.example.org",
  });
});

test("succeeded job surfaces the next-step link to Hosts", async ({
  page,
}) => {
  await registerAdmin(page);

  // First load: live + ready state so the next-step card renders
  // without re-applying.
  await mockHeadscaleGet(page, {
    enabled: true,
    configured: true,
    remoteProvisioningReady: true,
    needsApiRestart: false,
    updaterAvailable: true,
    hostDomain: "synapsepanel.com",
    domain: "headscale.synapsepanel.com",
    serverUrl: "https://headscale.synapsepanel.com",
    internalUrl: "http://synapse-headscale:8080",
    publicIp: "1.2.3.4",
    defaultDomain: "headscale.synapsepanel.com",
    dnsCredentialAvailable: false,
  });

  await page.goto("/admin/remote-hosts");
  await expect(page.getByTestId("remote-hosts-status-badge")).toContainText(
    /live/i,
  );
  await expect(page.getByTestId("remote-hosts-next-step")).toBeVisible();
  await expect(page.getByTestId("remote-hosts-open-hosts")).toHaveAttribute(
    "href",
    "/teams",
  );
});
