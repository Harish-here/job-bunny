/**
 * e2e coverage for the "Where you'll work" screen's cross-document timezone
 * conflict notice (`WhereYouWorkSection`, `#/settings/where-you-work`) —
 * blueprint.md step 11's e2e half. Covers the notice's hard/soft/absent/
 * no-rule branches, driven against the REAL board server over
 * `profiles/rajni`'s seeded fixture. Every test seeds BOTH filter.json and
 * profile.json (this screen spans both documents) via fetch-mutate-put
 * before navigating, captures both docs' original text BEFORE mutating, and
 * restores both in a `finally` — `seed.ts`'s `globalSetup` wipes
 * `config_docs` ONCE per whole suite run, not per test, so a leftover
 * mutation here would leak into every later test in this same invocation.
 */
import { expect, type Page, test } from '@playwright/test';
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

async function fetchConfigJson(
  page: Page,
  doc: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await fetchConfigText(page, doc)) as Record<string, unknown>;
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

test('settings: where you work notice names the unlisted timezone on a hard conflict', async ({
  page,
}) => {
  const originalFilter = await fetchConfigText(page, 'filter.json');
  const originalProfile = await fetchConfigText(page, 'profile.json');
  try {
    const filter = await fetchConfigJson(page, 'filter.json');
    filter.timezones = { accept: ['Asia/Kolkata'], severity: 'hard' };
    await putConfigText(page, 'filter.json', JSON.stringify(filter));

    const profile = await fetchConfigJson(page, 'profile.json');
    const settings = profile.settings as Record<string, unknown>;
    const rank = settings.rank as Record<string, unknown>;
    const location = rank.location as Record<string, unknown>;
    location.acceptableTimezones = ['Asia/Kolkata', 'America/New_York'];
    // The rajni fixture's own profile.json seeds a stray borderlineTimezones
    // entry ('EMEA') that computeTimezoneConflict unions into its check —
    // clear it so this test's conflict set is exactly the acceptable list
    // above, not polluted by unrelated fixture state.
    location.borderlineTimezones = [];
    await putConfigText(page, 'profile.json', JSON.stringify(profile));

    await page.goto('/#/settings/where-you-work');
    const notice = page.locator('[data-qa="geo-conflict-notice"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('America/New_York');
  } finally {
    await putConfigText(page, 'filter.json', originalFilter);
    await putConfigText(page, 'profile.json', originalProfile);
  }
});

test('settings: where you work notice does not render when every rank timezone is already accepted', async ({
  page,
}) => {
  const originalFilter = await fetchConfigText(page, 'filter.json');
  const originalProfile = await fetchConfigText(page, 'profile.json');
  try {
    const filter = await fetchConfigJson(page, 'filter.json');
    filter.timezones = { accept: ['Asia/Kolkata', 'America/New_York'], severity: 'hard' };
    await putConfigText(page, 'filter.json', JSON.stringify(filter));

    const profile = await fetchConfigJson(page, 'profile.json');
    const settings = profile.settings as Record<string, unknown>;
    const rank = settings.rank as Record<string, unknown>;
    const location = rank.location as Record<string, unknown>;
    location.acceptableTimezones = ['Asia/Kolkata', 'America/New_York'];
    // The rajni fixture's own profile.json seeds a stray borderlineTimezones
    // entry ('EMEA') that computeTimezoneConflict unions into its check —
    // clear it so this test's conflict set is exactly the acceptable list
    // above, not polluted by unrelated fixture state.
    location.borderlineTimezones = [];
    await putConfigText(page, 'profile.json', JSON.stringify(profile));

    await page.goto('/#/settings/where-you-work');
    await expect(section(page)).toHaveAttribute('data-section', 'where-you-work');
    await expect(page.locator('[data-qa="geo-conflict-notice"]')).toHaveCount(0);
  } finally {
    await putConfigText(page, 'filter.json', originalFilter);
    await putConfigText(page, 'profile.json', originalProfile);
  }
});

test('settings: where you work notice renders the soft-branch copy under soft severity', async ({
  page,
}) => {
  const originalFilter = await fetchConfigText(page, 'filter.json');
  const originalProfile = await fetchConfigText(page, 'profile.json');
  try {
    const filter = await fetchConfigJson(page, 'filter.json');
    filter.timezones = { accept: ['Asia/Kolkata'], severity: 'soft' };
    await putConfigText(page, 'filter.json', JSON.stringify(filter));

    const profile = await fetchConfigJson(page, 'profile.json');
    const settings = profile.settings as Record<string, unknown>;
    const rank = settings.rank as Record<string, unknown>;
    const location = rank.location as Record<string, unknown>;
    location.acceptableTimezones = ['Asia/Kolkata', 'America/New_York'];
    // The rajni fixture's own profile.json seeds a stray borderlineTimezones
    // entry ('EMEA') that computeTimezoneConflict unions into its check —
    // clear it so this test's conflict set is exactly the acceptable list
    // above, not polluted by unrelated fixture state.
    location.borderlineTimezones = [];
    await putConfigText(page, 'profile.json', JSON.stringify(profile));

    await page.goto('/#/settings/where-you-work');
    const notice = page.locator('[data-qa="geo-conflict-notice"]');
    await expect(notice).toBeVisible();
    const text = await notice.textContent();
    // Proves the soft branch rendered materially different copy from the
    // hard branch, without pinning the soft copy's own exact wording (left
    // open by the blueprint) — only the mechanism (branch on severity) is
    // fixed.
    expect(text).not.toContain('no job');
    expect(text).not.toContain('can reach the board');
  } finally {
    await putConfigText(page, 'filter.json', originalFilter);
    await putConfigText(page, 'profile.json', originalProfile);
  }
});

test('settings: where you work rules card renders the no-rule empty state and Add seeds one empty location row', async ({
  page,
}) => {
  const originalFilter = await fetchConfigText(page, 'filter.json');
  const originalProfile = await fetchConfigText(page, 'profile.json');
  try {
    const filter = await fetchConfigJson(page, 'filter.json');
    filter.locations = [];
    delete filter.timezones;
    await putConfigText(page, 'filter.json', JSON.stringify(filter));

    // profile.json is untouched by this test but every other test in this
    // file mutates it, so re-seed it via the same fetch-mutate-put idiom to
    // keep the fixture-seeding shape uniform across the file (a no-op put).
    const profile = await fetchConfigJson(page, 'profile.json');
    await putConfigText(page, 'profile.json', JSON.stringify(profile));

    await page.goto('/#/settings/where-you-work');
    const rulesCard = page.locator('[data-qa="geo-rules-card"]');
    await expect(rulesCard).toContainText(
      'No rules — nothing is dropped for this reason',
    );

    const addButton = rulesCard.getByRole('button', { name: /add/i });
    await addButton.click();

    await expect(rulesCard.getByLabel('Location city')).toBeVisible();
    await expect(rulesCard.getByLabel('Location city')).toHaveValue('');
  } finally {
    await putConfigText(page, 'filter.json', originalFilter);
    await putConfigText(page, 'profile.json', originalProfile);
  }
});
