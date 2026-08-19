/**
 * e2e coverage for `RulePreviewStrip` (task 14), which mounts inside
 * `RolesCompaniesSection` at `#/settings/roles-companies`, between the rule
 * list and the save bar (`blueprint.md` step 14, lines 757-761). Covers the
 * strip's `available: true` and `available: false, reason: 'no_recent_run'`
 * states — both stubbed via `page.route('**\/api/profiles/rajni/preview/filter'`,
 * mirroring `run-fixtures.ts`'s own `page.route` stubbing idiom rather than
 * hitting the real preview endpoint (which needs a genuine last run to
 * answer `available: true` against).
 */
import { expect, test } from '@playwright/test';
import type { FilterPreviewResult } from '../src/lib/api/types';
import { pinProfile } from './run-fixtures';

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

async function stubFilterPreview(
  page: import('@playwright/test').Page,
  result: FilterPreviewResult,
): Promise<void> {
  await page.route('**/api/profiles/rajni/preview/filter', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ json: result });
  });
}

function section(page: import('@playwright/test').Page) {
  return page.getByTestId('settings-section');
}

// Triggers the strip's request regardless of whether the implementer chose
// debounce-on-change or fire-on-blur (task 14's done-condition leaves that
// open) — types one character into a title-match ChipInput draft input,
// then blurs it, on the always-non-empty rajni `filter.json.title.domain`
// rule.
async function triggerDraftEdit(page: import('@playwright/test').Page): Promise<void> {
  const domainMatchInput = section(page).getByRole('textbox', {
    name: 'Add to Domain match',
  });
  await domainMatchInput.pressSequentially('x');
  await domainMatchInput.blur();
}

test('settings: rule preview strip shows the drop-count copy for an available preview', async ({
  page,
}) => {
  const fixture: FilterPreviewResult = {
    available: true,
    totalJobs: 214,
    baselineDrops: 189,
    draftDrops: 201,
    newlyDropped: [{ title: 'Staff Engineer', company: 'Acme Corp' }],
  };
  await stubFilterPreview(page, fixture);

  await page.goto('/#/settings/roles-companies');
  await expect(section(page)).toHaveAttribute('data-section', 'roles-companies');
  await triggerDraftEdit(page);

  const strip = page.locator('[data-qa="rule-preview-strip"]');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(`${fixture.totalJobs} jobs`);
  await expect(strip).toContainText(String(fixture.draftDrops));
});

test('settings: rule preview strip shows the no-recent-run copy when unavailable', async ({
  page,
}) => {
  const fixture: FilterPreviewResult = { available: false, reason: 'no_recent_run' };
  await stubFilterPreview(page, fixture);

  await page.goto('/#/settings/roles-companies');
  await expect(section(page)).toHaveAttribute('data-section', 'roles-companies');
  await triggerDraftEdit(page);

  const strip = page.locator('[data-qa="rule-preview-strip"]');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('No recent run to preview against.');
});
