/**
 * Blueprint §6 Phase D steps 15–18 (tasks 5–6 of the ui-design-system epic) —
 * created at step 15 with `e2e-triage-verdict-header`, appended to at step
 * 16 with `e2e-jd-expand`, and appended to again at steps 17–18 (task 6)
 * with `e2e-decide-labels`/`e2e-row-lane-and-pip`. All tests run against the
 * real board server over `profiles/rajni`'s seeded fixtures
 * (`seed.ts`/`fixtures.ts`).
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

test('e2e-decide-labels', async ({ page }) => {
  await page.goto('/#/triage');

  const apply = page.locator('[data-qa="decide-apply"]');
  const lead = page.locator('[data-qa="decide-lead"]');
  const pass = page.locator('[data-qa="decide-pass"]');

  // The three buttons read exactly Apply / Lead / Pass — never the old
  // Save/Skip jargon (R11, the collision this rewrite closes).
  await expect(apply).toContainText('Apply');
  await expect(apply).not.toContainText('Save');
  await expect(apply).not.toContainText('Skip');
  await expect(lead).toContainText('Lead');
  await expect(lead).not.toContainText('Save');
  await expect(pass).toContainText('Pass');
  await expect(pass).not.toContainText('Skip');

  // decide-pass is styled `outline`, never `destructive` — a whole action
  // rendered as an error state was the collision this closes. `data-variant`
  // is the deterministic signal; the button's base class list always
  // includes `aria-invalid:*destructive*` utilities regardless of variant,
  // so a bare class-string substring match would false-positive — check for
  // the destructive variant's own distinguishing background class instead.
  await expect(pass).toHaveAttribute('data-variant', 'outline');
  const passClass = (await pass.getAttribute('class')) ?? '';
  expect(passClass).not.toContain('bg-destructive/10');
});

test('e2e-row-lane-and-pip', async ({ page }) => {
  await page.goto('/#/triage');

  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');
  await expect(row1).toContainText('LinkedIn');

  const pip = row1.locator('[data-testid="job-row-status"]');
  const ariaLabel = await pip.getAttribute('aria-label');
  expect(ariaLabel).toBeTruthy();
});
