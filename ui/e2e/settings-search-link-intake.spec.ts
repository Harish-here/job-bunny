/**
 * e2e coverage for the "Where jobs come from" search-URL editor's intake
 * flow (task 23's e2e half — spec R2/R4/R9/R10, ux-notes.md §3/§14, C4/C12).
 * Driven against the REAL board server over `profiles/rajni`'s seeded
 * fixture, same shape as `settings-where-you-work.spec.ts`: every test
 * captures `search_urls.md`'s original text BEFORE mutating and restores it
 * in a `finally` — `seed.ts`'s `globalSetup` wipes `config_docs` ONCE per
 * whole suite run, so a leftover mutation here would leak into every later
 * test in this same invocation.
 *
 * Every mutating test seeds a known, controlled starting doc first (rather
 * than depending on the fixture's own pre-existing rows) so each scenario
 * is self-contained and doesn't couple to unrelated fixture content — a
 * bare header with zero bullet rows, which the section's own empty-state
 * auto-add (ux-notes C12) turns into exactly one blank row on load.
 */
import { expect, type Page, test } from '@playwright/test';
import { FIELD_ERROR_COPY } from '../src/features/settings/sections/searchUrlRow.classify.ts';
import { pinProfile } from './run-fixtures';

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

async function fetchConfigText(page: Page, doc: string): Promise<string> {
  const res = await page.request.get(`/api/profiles/rajni/config/${doc}`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { text: string };
  return body.text;
}

async function putConfigText(page: Page, doc: string, text: string): Promise<void> {
  const res = await page.request.put(`/api/profiles/rajni/config/${doc}`, {
    data: { text },
  });
  expect(res.ok()).toBe(true);
}

function section(page: Page) {
  return page.getByTestId('settings-section');
}

// A non-empty doc (`validateConfigDoc` refuses a raw-empty PUT) that
// normalizes down to zero bullet rows — the exact "empty card" starting
// point ux-notes C12's auto-add targets.
const EMPTY_DOC = '# Search URLs\n\n## linkedin\n';

test('search-url-intake: pasting a dirty search-results link shows the Search results badge and a cleaned note after blur, and saves cleaned + correctly filed', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    await putConfigText(page, 'search_urls.md', EMPTY_DOC);
    await page.goto('/#/settings/where-jobs-come-from');

    const row = section(page).locator('[data-qa="search-url-row-0"]');
    await expect(row).toBeVisible();
    const urlInput = row.locator('[data-qa="search-url-input-0"]');
    const dirtyUrl =
      'https://www.linkedin.com/jobs/search-results/?keywords=sre&currentJobId=4242&origin=JOB_SEARCH_PAGE_JOB_FILTER';
    await urlInput.fill(dirtyUrl);
    await urlInput.press('Tab');

    await expect(row.locator('[data-qa="search-url-page-type-badge-0"]')).toHaveText(
      'Search results',
    );
    await expect(row.locator('[data-qa="search-url-row-note-0"]')).toContainText(
      'Cleaned',
    );

    await row.locator('[data-qa="search-url-label-input-0"]').fill('SRE Search Results');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('save-success-line')).toBeVisible();

    const saved = await fetchConfigText(page, 'search_urls.md');
    expect(saved).not.toContain('currentJobId');
    expect(saved).not.toContain('origin=');
    const headingIndex = saved.indexOf('### linkedin__jobs-search-results');
    const bulletIndex = saved.indexOf('SRE Search Results');
    expect(headingIndex).toBeGreaterThan(-1);
    expect(bulletIndex).toBeGreaterThan(headingIndex);
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});

test('search-url-intake: an unrecognised link is refused inline and blocks Save', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    await putConfigText(page, 'search_urls.md', EMPTY_DOC);
    await page.goto('/#/settings/where-jobs-come-from');
    const seeded = await fetchConfigText(page, 'search_urls.md');

    const row = section(page).locator('[data-qa="search-url-row-0"]');
    const urlInput = row.locator('[data-qa="search-url-input-0"]');
    await urlInput.fill('https://www.zafin.com/careers');
    await urlInput.press('Tab');

    // Byte-identical to ux-notes C4's own copy — never BE's `refused: `
    // -prefixed wire string.
    await expect(row.locator('[data-qa="search-url-error-0"]')).toHaveText(
      FIELD_ERROR_COPY,
    );

    await row.locator('[data-qa="search-url-label-input-0"]').fill('Zafin');
    await page.getByTestId('save-button').click();

    const summary = page.locator('[data-qa="validation-summary"]');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Zafin — not a LinkedIn jobs search link');
    await expect(summary.locator('a')).toHaveAttribute(
      'href',
      '#where-jobs-search-urls.0',
    );

    const saved = await fetchConfigText(page, 'search_urls.md');
    expect(saved).toBe(seeded);
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});

test('search-url-intake: two links identical after cleaning show a duplicate note, merge on save, and the merged row is gone with no reload', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    await putConfigText(page, 'search_urls.md', EMPTY_DOC);
    await page.goto('/#/settings/where-jobs-come-from');

    // The empty-state auto-add already seeded row 0; a second click adds
    // row 1.
    await section(page).locator('[data-qa="search-urls-add"]').click();

    const row0 = section(page).locator('[data-qa="search-url-row-0"]');
    await row0
      .locator('[data-qa="search-url-input-0"]')
      .fill('https://www.linkedin.com/jobs/search/?keywords=sre&currentJobId=1');
    await row0.locator('[data-qa="search-url-label-input-0"]').fill('SRE A');
    await row0.locator('[data-qa="search-url-input-0"]').press('Tab');

    const row1 = section(page).locator('[data-qa="search-url-row-1"]');
    await row1
      .locator('[data-qa="search-url-input-1"]')
      .fill(
        'https://www.linkedin.com/jobs/search/?keywords=sre&origin=JOB_SEARCH_PAGE_JOB_FILTER',
      );
    await row1.locator('[data-qa="search-url-label-input-1"]').fill('SRE B');
    await row1.locator('[data-qa="search-url-input-1"]').press('Tab');

    await expect(row1.locator('[data-qa="search-url-row-note-1"]')).toContainText(
      'merged',
    );
    await expect(row1.locator('[data-qa="search-url-duplicate-remove"]')).toHaveText(
      'Remove now',
    );

    await page.getByTestId('save-button').click();
    // ux-notes §10: only the FIRST clause after the base sentence is
    // capitalized — "merged" here since refiled/cleaned are both zero.
    await expect(page.getByTestId('save-success-line')).toContainText(
      'Merged 1 duplicate',
    );

    const saved = await fetchConfigText(page, 'search_urls.md');
    const cleanedUrl = 'https://www.linkedin.com/jobs/search/?keywords=sre';
    const occurrences = saved.split(cleanedUrl).length - 1;
    expect(occurrences).toBe(1);

    // No reload — the merged row is gone immediately, from the PUT-echo
    // reseed alone.
    await expect(section(page).locator('[data-qa^="search-url-row"]')).toHaveCount(1);
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});

test('search-url-intake: an empty card auto-adds and focuses one row', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    await putConfigText(page, 'search_urls.md', EMPTY_DOC);
    await page.goto('/#/settings/where-jobs-come-from');

    await expect(section(page).locator('[data-qa^="search-url-row"]')).toHaveCount(1);
    const input = section(page).locator('[data-qa="search-url-input-0"]');
    await expect(input).toBeFocused();
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});
