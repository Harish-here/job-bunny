/**
 * Critical-path smoke suite (T11) — 8 specs against a real board server
 * (webServer in `playwright.config.ts`) over `profiles/rajni`'s seeded
 * local sqlite DB (`seed.ts` globalSetup). Every test pins the profile via
 * `localStorage` before navigating — the dev machine may hold real
 * profiles, so the default profile pick must never be relied on.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PKG_VERSION = (
  JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, 'utf8')) as { version: string }
).version;

async function pinProfile(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('jobbunny.profile', 'rajni');
  });
}

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

test('board loads', async ({ page }) => {
  await page.goto('/#/triage');
  const rows = page.getByTestId('job-row');
  await expect(rows).toHaveCount(10);

  const first = rows.first();
  await expect(first).toHaveAttribute('data-job-id', 'rajni-e2e-1');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('heading', { name: 'Staff Frontend Engineer' }),
  ).toBeVisible();
});

test('sidebar branding', async ({ page }) => {
  await page.goto('/#/triage');
  await expect(page.getByRole('img', { name: 'Job Bunny' })).toBeVisible();
  await expect(page.getByText('Job Bunny', { exact: true })).toBeVisible();

  const versionText = await page.getByText(/^v\d+\.\d+\.\d+$/).textContent();
  expect(versionText).toMatch(/^v\d+\.\d+\.\d+$/);
  expect(versionText).toBe(`v${PKG_VERSION}`);
});

test('filter narrows', async ({ page }) => {
  await page.goto('/#/triage');
  const rows = page.getByTestId('job-row');
  await expect(rows).toHaveCount(10);

  const search = page.getByLabel('Search company');
  await search.fill('AlphaCo');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-job-id', 'rajni-e2e-1');

  await search.fill('');
  await expect(rows).toHaveCount(10);
});

test('keyboard selection', async ({ page }) => {
  await page.goto('/#/triage');
  const rows = page.getByTestId('job-row');
  await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('j');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'false');

  await page.keyboard.press('k');
  await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
});

test('decide persists', async ({ page }) => {
  await page.goto('/#/triage');
  const row1 = page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]');

  await row1.click();
  await expect(row1).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('a');
  await expect(row1).toHaveAttribute('aria-selected', 'false');
  await expect(row1.getByTestId('job-row-status')).toHaveAttribute('title', 'Applied');

  await page.reload();
  await row1.click();
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveText('Applied');
});

/** Columns are located by the `data-status` attribute, never `hasText` —
 * fixture card content (e.g. "Lead UI Engineer") can legitimately contain
 * a status word as a substring, which would falsely match a `hasText`
 * filter on the wrong column. */
function column(page: Page, status: string) {
  return page.locator(`[data-testid="kanban-column"][data-status="${status}"]`);
}

test('tracker kanban', async ({ page }) => {
  await page.goto('/#/tracker');

  for (const status of [
    'Lead',
    'Applied',
    'Recruiter Screen',
    'Tech Round',
    'Onsite',
    'Offer',
  ]) {
    await expect(column(page, status)).toBeVisible();
  }

  const techRoundColumn = column(page, 'Tech Round');
  await expect(
    techRoundColumn.locator('[data-testid="kanban-card"][data-job-id="rajni-e2e-3"]'),
  ).toBeVisible();

  const closedColumn = page.getByTestId('closed-column');
  await expect(
    closedColumn.getByRole('button', { name: /Closed \(\d+\)/ }),
  ).toBeVisible();
  await expect(
    closedColumn.getByRole('button', { name: /Closed \(\d+\)/ }),
  ).toContainText('Closed (1)');

  await expect(page.getByTestId('due-strip')).toContainText('prep sys design');
});

test('kanban move', async ({ page }) => {
  await page.goto('/#/tracker');

  const trigger = page.getByRole('combobox', { name: 'Status for Lead UI Engineer' });
  await trigger.click();
  await page.getByRole('option', { name: 'Onsite' }).click();

  const onsiteColumn = column(page, 'Onsite');
  await expect(
    onsiteColumn.locator('[data-testid="kanban-card"][data-job-id="rajni-e2e-2"]'),
  ).toBeVisible();

  await page.reload();
  await expect(
    column(page, 'Onsite').locator(
      '[data-testid="kanban-card"][data-job-id="rajni-e2e-2"]',
    ),
  ).toBeVisible();
});

test('full-page detail + back', async ({ page }) => {
  await page.goto('/#/triage');
  const rows = page.getByTestId('job-row');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/job\/rajni-e2e-1/);
  await expect(
    page.getByRole('heading', { name: 'Staff Frontend Engineer' }),
  ).toBeVisible();
  await expect(page.locator('pre')).toContainText('Staff Frontend Engineer at AlphaCo');

  await page.getByRole('button', { name: /Back/ }).click();
  await expect(page).toHaveURL(/#\/triage/);
  await expect(
    page.locator('[data-testid="job-row"][data-job-id="rajni-e2e-1"]'),
  ).toHaveAttribute('aria-selected', 'true');
});
