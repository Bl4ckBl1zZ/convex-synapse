import { test, expect, type Page } from "@playwright/test";
import { truncateAll } from "./helpers/db";

// Bloco 9c — StateDriftPanel + OperationRunsPanel. Validates the React side
// (stubbed drift / desired / operation_runs payloads → DOM), like
// cell_topology_panel.spec.ts. The control plane is dry-run only: these tests
// assert there is NO Apply button and that the plan says applyAllowed=false.

async function registerViaUI(page: Page) {
  await page.goto("/register");
  await page.locator("#register-email").fill("op@example.com");
  await page.locator("#register-password").fill("strongpass123");
  await page.locator("#register-name").fill("Op");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/teams\b/);
}

async function createTeamAndProject(page: Page): Promise<{ projectId: string }> {
  await page.getByRole("button", { name: "Create team" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.locator("#team-name").fill("Drift Co");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /drift co/i }).click();
  await page.getByRole("button", { name: "Create project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.locator("#project-name").fill("DriftProj");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: /driftproj/i }).click();
  await expect(page).toHaveURL(/\/teams\/drift-co\/[0-9a-f-]{36}\b/);
  const m = page.url().match(/\/teams\/[^/]+\/([0-9a-f-]{36})/);
  return { projectId: m![1] };
}

function reportWithItems(projectId: string) {
  return {
    report: {
      id: "report-1",
      projectId,
      operationRunId: "run-drift-1",
      status: "drifted",
      summary: {
        total: 4,
        inSync: 1,
        missing: 1,
        drifted: 1,
        unmanaged: 0,
        orphaned: 0,
        hostUnreachable: 1,
        ignored: 0,
        critical: 2,
        warning: 1,
        info: 1,
      },
      createdAt: "2026-05-25T00:00:00Z",
    },
    items: [
      {
        id: "item-missing",
        resourceType: "convex_deployment",
        resourceKey: "convex_deployment:dep-a",
        driftStatus: "missing",
        severity: "critical",
        recommendedAction: "create",
        diff: { reason: "desired running but no matching container observed", deploymentId: "dep-a" },
        createdAt: "2026-05-25T00:00:00Z",
      },
      {
        id: "item-restart",
        resourceType: "convex_deployment",
        resourceKey: "convex_deployment:dep-b",
        driftStatus: "drifted",
        severity: "critical",
        recommendedAction: "restart",
        diff: { reason: "observed container is not running", observedState: "exited" },
        createdAt: "2026-05-25T00:00:00Z",
      },
      {
        id: "item-unreachable",
        resourceType: "convex_deployment",
        resourceKey: "convex_deployment:dep-c",
        driftStatus: "host_unreachable",
        severity: "warning",
        recommendedAction: "investigate",
        diff: { reason: "container scan failed or was incomplete", hostStatus: "online" },
        createdAt: "2026-05-25T00:00:00Z",
      },
      {
        id: "item-remove",
        resourceType: "convex_deployment",
        resourceKey: "convex_deployment:dep-d",
        driftStatus: "drifted",
        severity: "warning",
        recommendedAction: "remove",
        diff: { reason: "desired absent but a matching container still exists" },
        createdAt: "2026-05-25T00:00:00Z",
      },
    ],
  };
}

function dryRunPlan() {
  return {
    operationRun: {
      id: "run-dry-1",
      type: "reconcile_dry_run",
      status: "succeeded",
      plan: {
        mode: "dry-run",
        applyAllowed: false,
        summary: { planned: 2, noOp: 1, skipped: 0, investigate: 0, dangerous: 1 },
      },
      createdAt: "2026-05-25T00:00:00Z",
      updatedAt: "2026-05-25T00:00:00Z",
    },
    steps: [
      {
        action: "restart",
        resourceType: "convex_deployment",
        resourceKey: "convex_deployment:dep-b",
        status: "planned",
        reason: "observed container not running; would restart",
        willApply: false,
      },
      {
        action: "remove",
        resourceType: "convex_deployment",
        resourceKey: "convex_deployment:dep-d",
        status: "planned",
        reason: "dry-run only — removal not implemented",
        willApply: false,
      },
    ],
  };
}

// Stub only the 9c endpoints; the rest of the project page hits the real
// backend (empty for a fresh project). `overrides` lets a test swap a payload.
async function stubDrift(
  page: Page,
  projectId: string,
  opts: {
    desired?: unknown;
    latest?: unknown;
    runs?: unknown;
    onSync?: () => void;
    onRecompute?: () => void;
  } = {},
) {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route(`**/v1/projects/${projectId}/desired_state`, (route) =>
    route.fulfill(json(opts.desired ?? { items: [] })),
  );
  await page.route(`**/v1/projects/${projectId}/desired_state/sync_from_placements`, (route) => {
    opts.onSync?.();
    return route.fulfill(json({ created: 1, updated: 0, unchanged: 0, superseded: 0, total: 1, operationRunId: "run-sync-1" }));
  });
  await page.route(`**/v1/projects/${projectId}/drift/latest`, (route) =>
    route.fulfill(json(opts.latest ?? { report: null, items: [] })),
  );
  await page.route(`**/v1/projects/${projectId}/drift/recompute`, (route) => {
    opts.onRecompute?.();
    return route.fulfill(json(opts.latest ?? reportWithItems(projectId)));
  });
  await page.route(`**/v1/projects/${projectId}/reconcile/dry_run`, (route) =>
    route.fulfill(json(dryRunPlan())),
  );
  await page.route(`**/v1/projects/${projectId}/operation_runs`, (route) =>
    route.fulfill(json(opts.runs ?? { items: [] })),
  );
}

test.beforeEach(async () => {
  await truncateAll();
});

test("empty state: no desired, no report", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  await stubDrift(page, projectId);
  await page.reload();

  const panel = page.getByTestId("state-drift-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("drift-status")).toContainText("no report");
  await expect(page.getByTestId("drift-empty-desired")).toBeVisible();
  await expect(page.getByTestId("drift-empty-report")).toBeVisible();
  // Dry-run-only labelling is always present.
  await expect(panel).toContainText("observe-only");
  // No Apply control anywhere.
  await expect(page.getByRole("button", { name: /^apply$/i })).toHaveCount(0);
});

test("drift summary + items render with badges and safe notes", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  await stubDrift(page, projectId, {
    desired: { items: [{ id: "d1" }, { id: "d2" }] },
    latest: reportWithItems(projectId),
  });
  await page.reload();

  await expect(page.getByTestId("drift-status")).toContainText("drifted");
  const summary = page.getByTestId("drift-summary");
  await expect(summary).toContainText("Missing");
  await expect(summary).toContainText("Host unreachable");
  await expect(summary).toContainText("critical 2");

  const items = page.getByTestId("drift-items");
  await expect(items.locator('[data-drift-status="missing"]')).toContainText("create");
  await expect(items.locator('[data-drift-status="drifted"][data-recommended-action="restart"]')).toContainText("restart");

  // host_unreachable carries the trust warning.
  const unreachable = items.locator('[data-drift-status="host_unreachable"]');
  await expect(unreachable).toContainText("Observation cannot be trusted");

  // remove is flagged dangerous + dry-run-only.
  const remove = items.locator('[data-recommended-action="remove"]');
  await expect(remove).toContainText("dangerous");
  await expect(remove).toContainText("Removal is not implemented");
});

test("dry-run renders a plan, applyAllowed=false, no Apply button", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  await stubDrift(page, projectId, { latest: reportWithItems(projectId) });
  await page.reload();

  await page.getByRole("button", { name: "Dry-run reconcile" }).click();

  const plan = page.getByTestId("dry-run-plan");
  await expect(plan).toBeVisible();
  await expect(plan.getByTestId("dry-run-apply-allowed")).toContainText("applyAllowed: false");
  // Apply is OFF by default (no applyEnabled in the stubbed response).
  await expect(plan).toContainText("Apply is not enabled on this instance");

  const steps = plan.getByTestId("dry-run-step");
  await expect(steps).toHaveCount(2);
  await expect(plan.locator('[data-action="restart"]')).toContainText("willApply: false");
  await expect(plan.locator('[data-action="remove"]')).toContainText("dangerous");

  // The whole page must never expose an Apply control when apply is disabled.
  await expect(page.getByTestId("reconcile-apply")).toHaveCount(0);
});

test("apply gated ON: Apply button appears, enqueues, and reports success", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  await stubDrift(page, projectId, { latest: reportWithItems(projectId) });

  // Dry-run reports applyEnabled=true + a planned create step.
  await page.route(`**/v1/projects/${projectId}/reconcile/dry_run`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        applyEnabled: true,
        operationRun: {
          id: "run-dry-2",
          type: "reconcile_dry_run",
          status: "succeeded",
          plan: { mode: "dry-run", applyAllowed: false, summary: { planned: 1 } },
          createdAt: "2026-05-25T00:00:00Z",
          updatedAt: "2026-05-25T00:00:00Z",
        },
        steps: [
          {
            action: "create",
            resourceType: "convex_deployment",
            resourceKey: "convex_deployment:dep-a",
            status: "planned",
            reason: "desired running but no container",
            willApply: false,
          },
        ],
      }),
    }),
  );
  let applyCalled = false;
  await page.route(`**/v1/projects/${projectId}/reconcile/apply`, (route) => {
    applyCalled = true;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ operationRunId: "run-apply-1", status: "running", summary: { queued: 1, skipped: 0, noOp: 0, dangerousSkipped: 0 } }),
    });
  });
  await page.route(`**/v1/operation_runs/run-apply-1`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        operationRun: { id: "run-apply-1", type: "reconcile_apply", status: "succeeded", projectId, createdAt: "2026-05-25T00:00:00Z", updatedAt: "2026-05-25T00:00:00Z" },
        steps: [{ id: "s0", stepIndex: 0, action: "create", resourceType: "convex_deployment", resourceKey: "convex_deployment:dep-a", status: "succeeded" }],
      }),
    }),
  );
  await page.reload();

  await page.getByRole("button", { name: "Dry-run reconcile" }).click();
  const applyBtn = page.getByTestId("reconcile-apply");
  await expect(applyBtn).toBeVisible();

  // The Apply confirm() must be accepted to proceed.
  page.on("dialog", (d) => d.accept());
  await applyBtn.click();

  await expect(page.getByTestId("drift-notice")).toContainText("Apply succeeded");
  expect(applyCalled).toBe(true);
});

test("sync + recompute call their endpoints and show a notice", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  let synced = false;
  let recomputed = false;
  await stubDrift(page, projectId, {
    onSync: () => (synced = true),
    onRecompute: () => (recomputed = true),
  });
  await page.reload();

  await page.getByRole("button", { name: "Sync desired from placements" }).click();
  await expect(page.getByTestId("drift-notice")).toContainText("Nothing was applied to hosts");
  expect(synced).toBe(true);

  await page.getByRole("button", { name: "Recompute drift" }).click();
  await expect(page.getByTestId("drift-notice")).toContainText("no host was changed");
  expect(recomputed).toBe(true);
  // The recompute payload (reportWithItems) now renders.
  await expect(page.getByTestId("drift-status")).toContainText("drifted");
});

test("operation runs list + detail modal with steps", async ({ page }) => {
  await registerViaUI(page);
  const { projectId } = await createTeamAndProject(page);
  await stubDrift(page, projectId, {
    runs: {
      items: [
        { id: "run-drift-1", type: "compute_drift", status: "succeeded", projectId, createdAt: "2026-05-25T00:00:00Z", updatedAt: "2026-05-25T00:00:00Z" },
        { id: "run-dry-1", type: "reconcile_dry_run", status: "succeeded", projectId, createdAt: "2026-05-25T00:00:00Z", updatedAt: "2026-05-25T00:00:00Z" },
      ],
    },
  });
  await page.route(`**/v1/operation_runs/run-dry-1`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        operationRun: { id: "run-dry-1", type: "reconcile_dry_run", status: "succeeded", projectId, plan: { mode: "dry-run", applyAllowed: false }, createdAt: "2026-05-25T00:00:00Z", updatedAt: "2026-05-25T00:00:00Z" },
        steps: [
          { id: "s0", stepIndex: 0, action: "restart", resourceType: "convex_deployment", resourceKey: "convex_deployment:dep-b", status: "planned", reason: "would restart" },
        ],
      }),
    }),
  );
  await page.reload();

  const panel = page.getByTestId("operation-runs-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-op-type="compute_drift"]')).toBeVisible();
  await expect(panel.locator('[data-op-type="reconcile_dry_run"]')).toBeVisible();

  await panel.locator('[data-op-type="reconcile_dry_run"]').getByRole("button", { name: "View details" }).click();
  const detail = page.getByTestId("operation-run-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("operation-run-steps")).toContainText("restart");
});
