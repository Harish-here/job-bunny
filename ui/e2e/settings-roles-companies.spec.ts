/**
 * e2e coverage for the "Roles & companies" screen (`RolesCompaniesSection`,
 * `#/settings/roles-companies`, blueprint.md step 13) — driven against the
 * REAL board server over `profiles/rajni`'s seeded fixture. Covers
 * profile.json's new `settings.rank.title.domainKeywords` round-trip,
 * filter.json's `companies.avoid` round-trip, and the rules card's no-rule
 * empty state. Every test captures the doc it is about to mutate BEFORE
 * editing and restores it in a `finally` — `seed.ts`'s `globalSetup` wipes
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

async function saveSection(page: Page): Promise<void> {
  await section(page).getByRole('button', { name: /save/i }).click();
  await expect(page.getByTestId('settings-error')).toHaveCount(0);
}

test('settings: roles & companies preferences card round-trips a domain keyword through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/roles-companies');
    await expect(section(page)).toHaveAttribute('data-section', 'roles-companies');

    const prefsCard = page.locator('[data-qa="roles-prefs-card"]');
    // roles-prefs-card has TWO ChipInputs (domain keywords, seniority
    // targets), each with its own "Add" button — scope to the specific
    // input's own draft row rather than the whole card to avoid a
    // strict-mode violation on the repeated "Add" label.
    const domainInput = prefsCard.getByRole('textbox', {
      name: 'Domain keyword preference',
    });
    await domainInput.fill('fintech');
    await domainInput.locator('xpath=..').getByRole('button', { name: 'Add' }).click();
    await saveSection(page);

    const saved = await fetchConfigJson(page, 'profile.json');
    const settings = saved.settings as Record<string, unknown>;
    const rank = settings.rank as Record<string, unknown>;
    const title = rank.title as Record<string, unknown>;
    expect(title.domainKeywords).toContain('fintech');
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});

test('settings: roles & companies companies-to-avoid card round-trips a company name through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'filter.json');
  try {
    await page.goto('/#/settings/roles-companies');
    await expect(section(page)).toHaveAttribute('data-section', 'roles-companies');

    const companiesCard = page.locator('[data-qa="companies-avoid-card"]');
    await companiesCard
      .getByRole('textbox', { name: 'Companies to avoid' })
      .fill('Acme Staffing');
    await companiesCard.getByRole('button', { name: 'Add' }).click();
    await saveSection(page);

    const saved = await fetchConfigJson(page, 'filter.json');
    const companies = saved.companies as { avoid: string[] };
    expect(companies.avoid).toContain('Acme Staffing');
  } finally {
    await putConfigText(page, 'filter.json', original);
  }
});

test('settings: roles & companies rules card renders the no-rule empty state with a working Add', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'filter.json');
  try {
    const filter = await fetchConfigJson(page, 'filter.json');
    filter.title = {
      domain: { match: [], reject: [] },
      function: { match: [], reject: [] },
      seniority: { match: [], reject: [] },
    };
    await putConfigText(page, 'filter.json', JSON.stringify(filter));

    await page.goto('/#/settings/roles-companies');
    const rulesCard = page.locator('[data-qa="roles-rules-card"]');
    await expect(rulesCard).toContainText(
      'No rules — nothing is dropped for this reason',
    );

    const addButton = rulesCard.getByRole('button', { name: /add/i });
    await expect(addButton).toBeVisible();
    await expect(addButton).toBeEnabled();
  } finally {
    await putConfigText(page, 'filter.json', original);
  }
});
