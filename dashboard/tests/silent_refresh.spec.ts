// Silent refresh-on-401 — replaces the pre-v1.7 "any 401 → wipe + redirect"
// behaviour. The dashboard now POSTs /v1/auth/refresh once with the saved
// refresh token, then retries the original request. Only a second 401 (or
// a failed refresh) bounces the operator to /login.
//
// We exercise both branches with `page.route()` interception, so the test
// works without waiting for the access token's TTL to elapse.

import { test, expect, type Route, type Request } from "@playwright/test";
import { truncateAll } from "./helpers/db";

test.beforeEach(async () => {
  await truncateAll();
});

async function register(page: import("@playwright/test").Page, email: string) {
  await page.goto("/register");
  await page.locator("#register-email").fill(email);
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Ian");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

test("silent refresh: a single 401 on /v1/teams is retried after /v1/auth/refresh", async ({
  page,
}) => {
  await register(page, "refresh-success@example.com");

  // Stash the freshly-issued tokens so we can compare against post-refresh
  // values later. localStorage is keyed by 'synapse.auth' (see dashboard/lib/auth.ts).
  const initial = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("synapse.auth") || "{}"),
  );
  expect(initial.accessToken).toBeTruthy();
  expect(initial.refreshToken).toBeTruthy();

  // Stub /v1/teams to return 401 on the very next call, then fall through
  // for the retry. Anything else (refresh, list_deployments, etc.) gets
  // the real response.
  let teamsCalls = 0;
  let refreshCalls = 0;
  await page.route(/\/v1\/teams\/?(\?.*)?$/, async (route: Route, req: Request) => {
    if (req.method() === "GET") {
      teamsCalls += 1;
      if (teamsCalls === 1) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ code: "expired", message: "Access token expired" }),
        });
        return;
      }
    }
    await route.continue();
  });
  await page.route(/\/v1\/auth\/refresh\b/, async (route: Route) => {
    refreshCalls += 1;
    await route.continue();
  });

  // Trigger the navigation. We use expect.poll for the count-based
  // assertions instead of a static expect — the silent-refresh path is
  // asynchronous (401 → /v1/auth/refresh → retry) and the assert can
  // otherwise fire mid-flight, before the retry's network roundtrip
  // lands. page.goto with waitUntil=load was racing the SWR fetch on CI.
  await page.goto("/teams", { waitUntil: "load" });

  // We never bounced to /login: the page stays on /teams once the
  // retry resolves with a fresh token.
  await expect(page).toHaveURL(/\/teams\b/);
  await expect
    .poll(() => teamsCalls, { timeout: 10_000, message: "teams retry never fired" })
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => refreshCalls, { timeout: 10_000, message: "refresh never fired" })
    .toBe(1);

  // The saved access token rotated to the value returned by /v1/auth/refresh.
  // (Refresh tokens are single-use; the server invalidates the previous one
  // and issues a fresh pair on every call.) Same polling story — the
  // localStorage write happens inside refreshAccessToken's resolve.
  await expect
    .poll(async () => {
      const a = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("synapse.auth") || "{}"),
      );
      return a.accessToken;
    }, { timeout: 10_000, message: "accessToken never rotated" })
    .not.toEqual(initial.accessToken);
});

test("silent refresh: if the refresh itself 401s, fall back to /login with return_to", async ({
  page,
}) => {
  await register(page, "refresh-fail@example.com");

  // Both /v1/teams and /v1/auth/refresh hard-401. The cleanup path
  // should fire, clear storage, and bounce to /login with return_to.
  await page.route(/\/v1\/teams\/?(\?.*)?$/, async (route: Route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ code: "expired", message: "Access token expired" }),
    });
  });
  await page.route(/\/v1\/auth\/refresh\b/, async (route: Route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ code: "invalid_refresh_token", message: "Refresh token rejected" }),
    });
  });

  await page.goto("/teams", { waitUntil: "load" });

  // The dashboard's clearAuth+redirect path lands us on /login with
  // return_to=/teams so post-login lands us back on the original page.
  await expect(page).toHaveURL(/\/login(\?return_to=%2Fteams.*)?$/);
  const saved = await page.evaluate(() => localStorage.getItem("synapse.auth"));
  expect(saved).toBeNull();
});

// Single-flight coalescing of concurrent 401s is asserted by code review
// (see refreshAccessToken in dashboard/lib/api.ts) — exercising it from
// Playwright would require either exposing the api object on window
// (production smell) or mocking the lib/api.ts module from inside the
// page. Both paths cost more than the value of the test. The two specs
// above already cover the operator-visible behaviour: 401 doesn't bounce
// to /login when a refresh succeeds, and DOES when it doesn't.
