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
import { serializeSearchUrlRows } from '../src/features/settings/sections/searchUrls.model.ts';
import { pinProfile } from './run-fixtures';
import {
  DUPLICATE_MISFILED_URL,
  seedDuplicateMisfiledSearchUrl,
} from './seed_duplicate_misfiled_search_url.ts';
import { seedMisfiledSearchUrl } from './seed_misfiled_search_url.ts';

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

// Task 24 (S1 Loading/Error + R13 misfile/Re-file). `releaseRoute` idiom
// mirrors `settings.spec.ts:229-238`'s own gated-GET pattern — gates only
// the GET so the section's own PUTs (unused by these two read-path tests)
// are never touched.
test('search-url-intake: the card shows a skeleton while search_urls.md is loading, then resolves', async ({
  page,
}) => {
  let releaseRoute: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });
  await page.route('**/api/profiles/rajni/config/search_urls.md', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await gate;
    await route.continue();
  });

  await page.goto('/#/settings/where-jobs-come-from');

  // B6 fix (QA search-link-intake): the mockup's S1 Loading view keeps the
  // Search URLs card's own title/helper AND the sibling Lanes card visible
  // — only the row-list region swaps for skeleton rows, never the whole
  // section for a bare, unframed skeleton.
  const card = section(page).locator('[data-qa="search-urls-card"]');
  const skeleton = section(page).locator('[data-qa="search-urls-skeleton"]');
  await expect(card).toBeVisible();
  await expect(skeleton).toBeVisible();
  await expect(card.getByText('Search URLs')).toBeVisible();
  await expect(card.locator('[data-qa="search-urls-helper"]')).toBeVisible();
  await expect(section(page).locator('[data-qa="where-jobs-lanes-card"]')).toBeVisible();

  releaseRoute?.();
  await expect(skeleton).not.toBeVisible();
  await expect(card).toBeVisible();
});

test("search-url-intake: a failed load shows the Couldn't-load alert with a working Retry", async ({
  page,
}) => {
  await page.route('**/api/profiles/rajni/config/search_urls.md', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'server_error', message: 'boom' } }),
    });
  });

  await page.goto('/#/settings/where-jobs-come-from');

  const alert = section(page).locator('[data-qa="search-urls-load-error"]');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Couldn't load search links.");

  const retry = alert.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();

  await page.unroute('**/api/profiles/rajni/config/search_urls.md');
  await retry.click();

  await expect(section(page).locator('[data-qa="search-urls-card"]')).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('search-url-intake: a misfiled link is flagged on load and Re-file fixes it in one click', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    await seedMisfiledSearchUrl();

    // Gates only the Re-file PUT (the GET that loads the seeded doc runs
    // unblocked) so the transient "Re-filing…" button label is observable
    // deterministically rather than racing a real, possibly-instant PUT
    // round trip.
    let releasePut: (() => void) | undefined;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    await page.route('**/api/profiles/rajni/config/search_urls.md', async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue();
        return;
      }
      await putGate;
      await route.continue();
    });

    await page.goto('/#/settings/where-jobs-come-from');

    const notice = section(page).locator('[data-qa="search-urls-misfile-notice"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('1 link is filed under the wrong page type');

    const button = section(page).locator('[data-qa="search-urls-refile-button"]');
    await expect(button).toHaveText('Re-file 1 link');

    await button.click();
    await expect(button).toHaveText('Re-filing…');

    releasePut?.();
    await expect(notice).toHaveCount(0);

    const saved = await fetchConfigText(page, 'search_urls.md');
    const headingIndex = saved.indexOf('### linkedin__jobs-search-results');
    const bulletIndex = saved.indexOf('Acme DevOps');
    expect(headingIndex).toBeGreaterThan(-1);
    expect(bulletIndex).toBeGreaterThan(headingIndex);
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});

// Deviation from the brief's literal "misfile notice count 2": the sole
// achievable construction for "two rows collapse into one on Re-file" is
// ONE misfiled row plus one ALREADY-correctly-filed row sharing its
// `page|cleanedUrl` key — `classifyRowsForDisplay`'s own precedence rule
// (searchUrlRow.classify.ts's own doc comment: "duplicate" wins over
// "misfiled" for every row after the first with a given key) makes two
// SIMULTANEOUSLY-misfiled rows sharing one key impossible: the second
// such row always classifies as `duplicate`, not `misfiled`, however it's
// arranged. Verified directly against `classifyRowsForDisplay` +
// `normalizeSearchUrlsDoc` before writing this test. Every OTHER literal
// assertion below (singular "Re-file 1 link"/"Re-filed 1 link.", exactly
// one row remaining, one server-side bullet) is unchanged from the brief
// and independently confirms the merge-on-Refile behavior end to end.
//
// Seeded via a direct-write helper (`seedDuplicateMisfiledSearchUrl`),
// never `putConfigText`: an ordinary PUT always normalizes+merges
// search_urls.md server-side (spec R9/R10), which would merge these two
// rows down to one before the test ever navigates.
test('search-url-intake: a re-file that merges duplicates shows one row without a reload', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    await seedDuplicateMisfiledSearchUrl();
    await page.goto('/#/settings/where-jobs-come-from');

    const notice = section(page).locator('[data-qa="search-urls-misfile-notice"]');
    await expect(notice).toBeVisible();
    const button = section(page).locator('[data-qa="search-urls-refile-button"]');
    await expect(button).toHaveText('Re-file 1 link');

    await button.click();

    // Before any reload: the PUT-echo reseed alone collapses the two rows
    // into one.
    await expect(section(page).locator('[data-qa^="search-url-row"]')).toHaveCount(1);
    await expect(page.getByTestId('save-success-line')).toHaveText('Re-filed 1 link.');

    const saved = await fetchConfigText(page, 'search_urls.md');
    const occurrences = saved.split(DUPLICATE_MISFILED_URL).length - 1;
    expect(occurrences).toBe(1);
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});

// B13 (QA search-link-intake): pins the three mockup/ux row states the QA
// round found untested — typing, real-paste-classifies, and Discard.

test('search-url-intake: typing (not yet blurred) shows no badge and no error', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    await putConfigText(page, 'search_urls.md', EMPTY_DOC);
    await page.goto('/#/settings/where-jobs-come-from');

    const row = section(page).locator('[data-qa="search-url-row-0"]');
    const urlInput = row.locator('[data-qa="search-url-input-0"]');
    await urlInput.fill('https://www.linkedin.com/jobs/search/?keywords=sre');

    await expect(row.locator('[data-qa="search-url-page-type-badge-0"]')).toHaveCount(0);
    await expect(row.locator('[data-qa="search-url-error-0"]')).toHaveCount(0);
    await expect(urlInput).toBeFocused();
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});

test('search-url-intake: a real paste classifies immediately, badge and cleaned note appearing while still focused', async ({
  page,
  context,
}) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    await putConfigText(page, 'search_urls.md', EMPTY_DOC);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/#/settings/where-jobs-come-from');

    const row = section(page).locator('[data-qa="search-url-row-0"]');
    const urlInput = row.locator('[data-qa="search-url-input-0"]');
    await urlInput.click();
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      'https://www.linkedin.com/jobs/search/?keywords=sre&currentJobId=1',
    );
    await urlInput.press('ControlOrMeta+V');

    // Classified and cleaned WHILE the field is still focused — no blur.
    await expect(urlInput).toBeFocused();
    await expect(row.locator('[data-qa="search-url-page-type-badge-0"]')).toHaveText(
      'Jobs search',
    );
    await expect(row.locator('[data-qa="search-url-row-note-0"]')).toContainText(
      'Cleaned',
    );
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});

test('search-url-intake: Discard reverts an unsaved row removal', async ({ page }) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    const SEEDED_ROWS = [
      {
        page: 'linkedin__jobs-search' as const,
        label: 'Comcast SRE',
        url: 'https://www.linkedin.com/jobs/search/?keywords=sre',
        touched: true,
      },
    ];
    await putConfigText(page, 'search_urls.md', serializeSearchUrlRows(SEEDED_ROWS));
    await page.goto('/#/settings/where-jobs-come-from');

    const rows = section(page).locator('[data-qa^="search-url-row"]');
    await expect(rows).toHaveCount(1);
    await expect(section(page).locator('[data-qa="search-url-input-0"]')).toHaveValue(
      'https://www.linkedin.com/jobs/search/?keywords=sre',
    );

    await section(page).locator('[data-qa="search-url-remove-0"]').click();
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId('save-bar')).toBeVisible();

    await page.getByTestId('discard-button').click();

    await expect(rows).toHaveCount(1);
    await expect(section(page).locator('[data-qa="search-url-input-0"]')).toHaveValue(
      'https://www.linkedin.com/jobs/search/?keywords=sre',
    );
    await expect(page.getByTestId('save-bar')).toHaveCount(0);
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});
