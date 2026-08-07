/**
 * Shell-chrome e2e suite (T12) — the collapsible sidebar rail (task 3) and
 * the Lapin mascot (task 4), covered separately from `smoke.spec.ts`'s
 * critical-path board suite because shell chrome is a different concern
 * from any one page's own data/business logic: a chrome regression should
 * fail here, with an unambiguous file name, not inside an unrelated board
 * spec. Every test pins the profile via `localStorage` before navigating,
 * for the same reason `smoke.spec.ts` does — the dev machine running these
 * tests may hold real, non-fixture profiles, so the default profile pick
 * must never be relied on. Each test gets its own fresh browser context
 * (Playwright's default per-test isolation), so no stored sidebar
 * preference carries over from a prior test — the only extra care needed
 * is within a single test: `page.addInitScript` re-runs on every
 * navigation, including `page.reload()`, so it must set nothing beyond
 * the profile pin, or a mid-test reload would silently re-clear whatever
 * the app itself just persisted, defeating the very persistence this
 * suite proves.
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

test('shell: sidebar collapses to the rail and persists across reload', async ({
  page,
}) => {
  await page.goto('/#/triage');
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  await expect(sidebar).toHaveCSS('width', '224px');

  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
  await expect(sidebar).toHaveCSS('width', '56px');

  const stored = await page.evaluate(() => localStorage.getItem('jobbunny.sidebar'));
  expect(stored).toBe('collapsed');

  // The reload is the whole point of this spec (design spec §7: "sidebar
  // collapse persists") — everything above only proves the click reacts;
  // this proves the preference survives a fresh page load.
  await page.reload();
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
  await expect(sidebar).toHaveCSS('width', '56px');
});

test('shell: the keyboard shortcut toggles the sidebar', async ({ page }) => {
  await page.goto('/#/triage');
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false');

  await page.keyboard.press('ControlOrMeta+b');
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true');

  await page.keyboard.press('ControlOrMeta+b');
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
});

test('shell: every page renders at rail width', async ({ page }) => {
  await page.goto('/#/triage');
  const sidebar = page.getByTestId('sidebar');
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('job-row').first()).toBeVisible();
  await expect(sidebar).toHaveCSS('width', '56px');

  await page.goto('/#/tracker');
  await expect(page.getByTestId('kanban-column').first()).toBeVisible();
  await expect(sidebar).toHaveCSS('width', '56px');

  await page.goto('/#/runs');
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect(sidebar).toHaveCSS('width', '56px');

  await page.goto('/#/analytics');
  await expect(page.getByText(/Coming soon/)).toBeVisible();
  await expect(sidebar).toHaveCSS('width', '56px');

  await page.goto('/#/onboarding');
  await expect(page.getByRole('heading', { name: 'Create profile' })).toBeVisible();
  await expect(sidebar).toHaveCSS('width', '56px');

  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(sidebar).toHaveCSS('width', '56px');
});

test('shell: nav items stay reachable by name at rail width', async ({ page }) => {
  await page.goto('/#/triage');
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');

  for (const label of [
    'Triage',
    'Tracker',
    'Runs',
    'Analytics',
    'Onboarding',
    'Settings',
  ]) {
    await expect(page.getByRole('button', { name: label })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/#\/settings/);
});

test('shell: the mascot renders with a named state', async ({ page }) => {
  await page.goto('/#/triage');
  const mascot = page.getByTestId('mascot');
  await expect(mascot).toBeVisible();

  // The state is asserted structurally, never by value — it is derived
  // from the seeded runs table's contents, which is not this spec's
  // contract to pin (see this brief's Rationale).
  const state = await mascot.getAttribute('data-state');
  expect(['asleep', 'ears-up', 'hopping', 'celebrating']).toContain(state);

  const name = await mascot.getAttribute('aria-label');
  expect(name).toBeTruthy();
});
