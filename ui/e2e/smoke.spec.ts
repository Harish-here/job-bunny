/**
 * Critical-path smoke suite (T11) — 12 specs against a real board server
 * (webServer in `playwright.config.ts`) over `profiles/rajni`'s seeded
 * local sqlite DB (`seed.ts` globalSetup). Every test pins the profile via
 * `localStorage` before navigating — the dev machine may hold real
 * profiles, so the default profile pick must never be relied on.
 *
 * The last 3 specs (Settings edit/error, create-profile) exercise the
 * config→db Phase 4 surface. The create-profile spec creates a REAL
 * `profiles/<throwaway>/` directory on disk, outside the rajni sandbox
 * every other spec here stays confined to — its own `test.afterAll`
 * cleans that up (belt-and-braces guard: refuses to `rm` anything whose
 * path doesn't literally start with `profiles/<that-exact-name>/`).
 */
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
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

// rajni's seeded DB (seed.ts) never inserts any `runs` rows — a fresh
// profile with jobs but no completed pipeline run is exactly the empty
// state this smoke covers.
test('runs page empty state', async ({ page }) => {
  await page.goto('/#/runs');
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect(page.getByTestId('runs-empty')).toBeVisible();
  await expect(page.getByTestId('runs-empty')).toContainText('No runs recorded yet');
  await expect(page.getByText('No run selected.')).toBeVisible();
});

test('settings page: edit filter.json, save, reload, still there', async ({ page }) => {
  await page.goto('/#/settings');
  const filterField = page.getByLabel('filter.json');
  await expect(filterField).toBeVisible();
  await expect(filterField).not.toHaveValue('');

  // Append a schema-valid, idempotent marker to the real seeded
  // `companies.avoid` array (rajni's actual filter.json, checked against
  // FilterConfigSchema) rather than a hand-typed guess — a re-run of this
  // suite against an already-mutated `config_docs` row (writeText never
  // touches the tracked legacy file, only the gitignored sqlite db) must
  // not grow the array unboundedly. Belt-and-braces: `seed.ts`'s
  // `globalSetup` now also `DELETE FROM config_docs` on every e2e
  // invocation (fix round 2), so the row this test writes never survives
  // past the current run anyway — the NEXT invocation's first read
  // re-lifts the pristine tracked `filter.json` fresh (`SqliteConfigStore`
  // falls back to the legacy file whenever no row exists); no separate
  // "restore the original doc" teardown is needed here, only this
  // within-run idempotency guard for repeat runs of this spec file alone
  // (e.g. `playwright test smoke.spec.ts` without a fresh global seed).
  const current = await filterField.inputValue();
  const parsed: { companies?: { avoid?: string[] } } = JSON.parse(current);
  parsed.companies ??= { avoid: [] };
  parsed.companies.avoid ??= [];
  if (!parsed.companies.avoid.includes('E2ESmokeAvoidCo')) {
    parsed.companies.avoid.push('E2ESmokeAvoidCo');
  }
  const edited = JSON.stringify(parsed, null, 2);
  await filterField.fill(edited);

  await page.getByRole('button', { name: 'Save filter.json' }).click();

  // No dedicated "Saved" toast/label exists (SettingsPage.tsx) — the save
  // succeeding is evidenced by the error region staying empty and the
  // Save button returning to its enabled, non-pending state.
  const saveButton = page.getByRole('button', { name: 'Save filter.json' });
  await expect(saveButton).toBeEnabled();
  await expect(page.getByText(/filter\.json is invalid/)).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel('filter.json')).toContainText('E2ESmokeAvoidCo');
});

test("settings page: invalid JSON shows the server's error message", async ({ page }) => {
  await page.goto('/#/settings');
  const filterField = page.getByLabel('filter.json');
  await expect(filterField).toBeVisible();
  await expect(filterField).not.toHaveValue('');

  await filterField.fill('{not valid json');
  await page.getByRole('button', { name: 'Save filter.json' }).click();

  // Server's real 422 message (validateConfigDoc, core/config/validators.ts):
  // `filter.json is invalid: ${JSON.parse's own error message}` — partial
  // match since the JSON.parse suffix isn't guaranteed byte-stable across
  // engine versions.
  await expect(page.getByText(/filter\.json is invalid:/)).toBeVisible();

  // A failed save must never stomp the user's in-progress (invalid) edit.
  await expect(filterField).toHaveValue('{not valid json');
});

let createdProfileName: string | undefined;

test('create profile: name it, see it in the switcher, land on its settings', async ({
  page,
}) => {
  const name = `e2e-tmp-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  createdProfileName = name;

  await page.goto('/#/onboarding');
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(page).toHaveURL(/#\/settings/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // The three docs `seedProfileDocs` actually writes for a brand-new
  // profile (profile.ts, config→db Phase 4): profile.json's minimal
  // pipeline config, filter.json's `{}`, and search_urls.md's template
  // header. `resume.json` is deliberately NEVER seeded (hand-maintained,
  // profile.ts's own doc comment) — its GET now returns 200 with an empty
  // draft rather than a 404 (fix round), so its editor renders an empty,
  // still-editable textarea instead of a permanent load error.
  await expect(page.getByLabel('profile.json')).toHaveValue(/"connector":\s*"sqlite"/);
  await expect(page.getByLabel('filter.json')).toHaveValue(/^\{\}\s*$/);
  await expect(page.getByLabel('search_urls.md')).toHaveValue(/# Search URLs/);
  await expect(page.getByLabel('resume.json')).toHaveValue('');
  await expect(page.getByText(/Couldn't load resume\.json/)).toHaveCount(0);

  // The new profile now resolves as the active one (OnboardingPage's own
  // `choose()` + navigate) and shows up in the switcher, both as the
  // trigger's current value and as a selectable option.
  const switcherTrigger = page.getByRole('combobox', { name: 'Profile' });
  await expect(switcherTrigger).toContainText(name);
  await switcherTrigger.click();
  await expect(page.getByRole('option', { name })).toBeVisible();
  await page.keyboard.press('Escape');
});

test.afterAll(async () => {
  if (!createdProfileName) return;
  const name = createdProfileName;
  // Belt-and-braces guard, inverted from `seed.ts`'s own "refusing: not
  // rajni" pattern: refuse to delete anything that ISN'T the exact
  // throwaway profile this spec created — reject any name carrying a path
  // separator, `..`, or any character outside the profile-name format the
  // server itself enforces, BEFORE it ever reaches `path.join`/`rm`.
  if (!/^[a-z0-9_-]+$/.test(name) || name === 'rajni') {
    throw new Error(`refusing: not a valid throwaway profile name (${name})`);
  }
  const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const target = path.join(REPO_ROOT, 'profiles', name);
  if (!target.endsWith(`${path.sep}profiles${path.sep}${name}`)) {
    throw new Error(`refusing: unexpected delete target (${target})`);
  }
  await rm(target, { recursive: true, force: true });
});
