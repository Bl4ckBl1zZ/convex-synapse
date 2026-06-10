// v1.7.2+: the project page replaced the browser-native `confirm()`
// with <ConfirmDeleteDeploymentDialog>. DEV / PREVIEW / CUSTOM rows
// open a one-click styled modal; PROD rows open a GitHub-style typed-
// name confirmation. This helper drives both branches from a single
// callsite so specs that just want "click delete and wait for the row
// to vanish" don't have to know about the branching.

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { Client } from "pg";
import { expandDeployment } from "./expand";

const DB_URL =
  process.env.SYNAPSE_DB_URL ||
  "postgres://synapse:synapse@localhost:5432/synapse";

type DeploymentKind = "dev" | "prod" | "preview" | "custom";

async function lookupType(name: string): Promise<DeploymentKind> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    const r = await c.query<{ deployment_type: string }>(
      `SELECT deployment_type FROM deployments WHERE name = $1 ORDER BY created_at DESC LIMIT 1`,
      [name],
    );
    const v = r.rows[0]?.deployment_type;
    if (v === "prod" || v === "preview" || v === "custom") return v;
    return "dev"; // safe default — single-click confirmation, no typed input
  } finally {
    await c.end();
  }
}

/**
 * Click the per-row "Delete deployment <name>" button and drive the
 * v1.7.2+ confirm dialog through to a successful close. Resolves once
 * the modal has closed; callers chain their own visibility checks on
 * the row to verify the API call landed.
 *
 * `kind` can be passed explicitly when the caller already knows the
 * type (saves a DB round-trip in big multi-deployment specs). When
 * omitted, the helper queries the test DB to decide which branch of
 * the dialog applies — same logic the page itself runs.
 */
export async function deleteDeploymentViaDialog(
  page: Page,
  deploymentName: string,
  kind?: DeploymentKind,
): Promise<void> {
  const type = kind ?? (await lookupType(deploymentName));

  // The Delete button lives behind the card's expand chevron (v1.26).
  await expandDeployment(page, deploymentName);
  await page
    .getByRole("button", {
      name: new RegExp(`delete deployment ${deploymentName}`, "i"),
    })
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  if (type === "prod") {
    await dialog.locator("#confirm-delete-name").fill(deploymentName);
  }
  await dialog.getByTestId("confirm-delete-deployment").click();

  // Modal closes on success. If it lingers, the API call errored —
  // callers see this as a stack trace pointing at this expect, which
  // is much more useful than a flaky downstream "row never disappeared".
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}
