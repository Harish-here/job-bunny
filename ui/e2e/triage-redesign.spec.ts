/**
 * Blueprint §6 Phase D steps 15–16 (task 5 of the ui-design-system epic) —
 * created at step 15 with `e2e-triage-verdict-header`, appended to at step
 * 16 with `e2e-jd-expand`. Both tests run against the real board server
 * over `profiles/rajni`'s seeded fixtures (`seed.ts`/`fixtures.ts`).
 */
import { expect, type Page, test } from '@playwright/test';

async function pinProfile(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('jobbunny.profile', 'rajni');
  });
}

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

test('e2e-triage-verdict-header', async ({ page }) => {
  await page.goto('/#/triage');

  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');
  await row1.click();
  await expect(row1).toHaveAttribute('aria-selected', 'true');

  const matchScore = page.locator('[data-qa="match-score"]');
  await expect(matchScore).toContainText('/100');

  const laneLabel = page.locator('[data-qa="lane-label"]');
  await expect(laneLabel).toContainText('LinkedIn');
  await expect(laneLabel).not.toHaveText('linkedin');

  const companyLink = page.locator('[data-qa="provenance-line"] a').first();
  await expect(companyLink).toHaveAttribute(
    'href',
    'https://example.com/jobs/rajni-e2e-1',
  );
});

test('e2e-jd-expand', async ({ page }) => {
  await page.goto('/#/triage');

  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');
  await row1.click();

  const clamp = page.locator('[data-testid="jd-clamp"]');
  await expect(clamp).toHaveCSS('max-height', '240px');

  const toggle = page.locator('[data-qa="jd-toggle"]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(clamp).not.toHaveCSS('max-height', '240px');

  const row2 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-2"]');
  await row2.click();
  await expect(row2).toHaveAttribute('aria-selected', 'true');

  // Session-sticky: `jdExpanded` lives above `selectedId` in `TriagePage`,
  // so selecting a different job renders it already expanded.
  await expect(page.locator('[data-qa="jd-toggle"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.locator('[data-testid="jd-clamp"]')).not.toHaveCSS(
    'max-height',
    '240px',
  );
});
