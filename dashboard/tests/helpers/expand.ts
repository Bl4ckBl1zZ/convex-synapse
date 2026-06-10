import { expect, type Page } from "@playwright/test";

/**
 * Deployment cards render COLLAPSED (v1.26 UI polish): name + badges +
 * URLs only. The action buttons (Open dashboard / Restart / Resize /
 * Delete) and the credential/domain/backup panels exist in the DOM only
 * after the chevron expands the card. Any spec that touches those must
 * expand first — idempotent via aria-expanded.
 */
export async function expandDeployment(page: Page, name: string): Promise<void> {
  const btn = page.getByTestId(`deployment-expand-${name}`);
  await expect(btn).toBeVisible();
  if ((await btn.getAttribute("aria-expanded")) !== "true") {
    await btn.click();
  }
}
