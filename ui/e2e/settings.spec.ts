/**
 * e2e coverage for the rebuilt Settings page (phase 4 tasks 7–11): one
 * round-trip test per section (profile, schedule, filters, resume,
 * search-urls) plus the shared JSON escape hatch and its invalid-JSON
 * rejection, driven against the REAL board server over `profiles/rajni`'s
 * seeded fixture. Every test captures the doc it is about to mutate
 * BEFORE editing and restores it in a `finally` — `seed.ts`'s
 * `globalSetup` wipes `config_docs` ONCE per whole suite run, not per
 * test, so a leftover mutation here would leak into every later test in
 * this same invocation, including this file's own and
 * `profile-lifecycle.spec.ts`'s. Every round-trip asserts server-side
 * state via `page.request.get`, never the form alone.
 */
import { expect, type Page, test } from '@playwright/test';
import { pinProfile } from './wizard.helpers';

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

test('settings: profile section round-trips a lane toggle through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/profile');
    await expect(section(page)).toHaveAttribute('data-section', 'profile');

    const keka = section(page).getByRole('checkbox', { name: 'keka', exact: true });
    await expect(keka).not.toBeChecked();
    await keka.check();
    await saveSection(page);

    const saved = await fetchConfigJson(page, 'profile.json');
    expect(saved.lanes).toEqual(expect.arrayContaining(['linkedin', 'keka']));

    await page.reload();
    await expect(
      section(page).getByRole('checkbox', { name: 'keka', exact: true }),
    ).toBeChecked();
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});

test('settings: schedule section round-trips grace minutes and the enabled switch through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/schedule');
    await section(page).getByLabel('Grace minutes').fill('45');
    await section(page).getByRole('switch', { name: 'Enabled' }).click();
    await saveSection(page);

    const saved = await fetchConfigJson(page, 'profile.json');
    const schedule = saved.schedule as { graceMinutes: number; enabled: boolean };
    expect(schedule.graceMinutes).toBe(45);
    expect(schedule.enabled).toBe(true);

    await page.reload();
    await expect(section(page).getByLabel('Grace minutes')).toHaveValue('45');
    await expect(section(page).getByRole('switch', { name: 'Enabled' })).toBeChecked();
  } finally {
    await putConfigText(page, 'profile.json', original);
  }
});

test('settings: filters section round-trips a minimum skill match count through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'filter.json');
  try {
    await page.goto('/#/settings/filters');
    await section(page).getByLabel('Minimum skill matches').fill('3');
    await saveSection(page);

    const saved = await fetchConfigJson(page, 'filter.json');
    const skills = saved.skills as { minMatch: number };
    expect(skills.minMatch).toBe(3);

    await page.reload();
    await expect(section(page).getByLabel('Minimum skill matches')).toHaveValue('3');
  } finally {
    await putConfigText(page, 'filter.json', original);
  }
});

test('settings: resume section round-trips years of experience through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'resume.json');
  try {
    await page.goto('/#/settings/resume');
    await section(page).getByLabel('Current years of experience').fill('11');
    await saveSection(page);

    const saved = await fetchConfigJson(page, 'resume.json');
    expect(saved.current_yoe).toBe(11);

    await page.reload();
    await expect(section(page).getByLabel('Current years of experience')).toHaveValue(
      '11',
    );
  } finally {
    await putConfigText(page, 'resume.json', original);
  }
});

test('settings: search urls section round-trips a new entry through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    await page.goto('/#/settings/search-urls');
    await section(page)
      .getByLabel('Search URL', { exact: true })
      .last()
      .fill('https://www.linkedin.com/jobs/search/?keywords=platform');
    await section(page).getByLabel('Label').last().fill('Platform roles');
    await saveSection(page);

    const saved = await fetchConfigText(page, 'search_urls.md');
    expect(saved).toContain(
      'Platform roles - https://www.linkedin.com/jobs/search/?keywords=platform',
    );

    await page.reload();
    // SearchUrlsSection renders row labels only as an input value, never
    // as text content — mirrors SearchUrlsSection.test.tsx's own
    // `getByDisplayValue` precedent (a Testing Library API; Playwright's
    // equivalent is asserting the input's value directly) for the
    // identical scenario.
    await expect(section(page).getByLabel('Label').last()).toHaveValue('Platform roles');
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});

test('settings: the JSON escape hatch round-trips raw text through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'filter.json');
  try {
    await page.goto('/#/settings/filters');
    await page.getByTestId('settings-json-open').click();
    const textarea = page.getByTestId('settings-json-textarea');
    await expect(textarea).toBeVisible();

    const parsed: { companies?: { avoid?: string[] } } = JSON.parse(
      await textarea.inputValue(),
    );
    parsed.companies ??= { avoid: [] };
    parsed.companies.avoid ??= [];
    if (!parsed.companies.avoid.includes('E2EPhase4SettingsHatch')) {
      parsed.companies.avoid.push('E2EPhase4SettingsHatch');
    }
    await textarea.fill(JSON.stringify(parsed, null, 2));
    await page.getByTestId('settings-json-save').click();
    await expect(page.getByTestId('settings-error')).toHaveCount(0);

    const saved = await fetchConfigJson(page, 'filter.json');
    expect((saved.companies as { avoid: string[] }).avoid).toContain(
      'E2EPhase4SettingsHatch',
    );

    await page.reload();
    await page.getByTestId('settings-json-open').click();
    await expect(page.getByTestId('settings-json-textarea')).toContainText(
      'E2EPhase4SettingsHatch',
    );
  } finally {
    await putConfigText(page, 'filter.json', original);
  }
});

test("settings: invalid JSON in the escape hatch is rejected inline with the server's message", async ({
  page,
}) => {
  await page.goto('/#/settings/filters');
  await page.getByTestId('settings-json-open').click();
  const textarea = page.getByTestId('settings-json-textarea');
  await textarea.fill('{not valid json');
  await page.getByTestId('settings-json-save').click();

  await expect(page.getByTestId('settings-error')).toContainText(
    /filter\.json is invalid:/,
  );
  // A failed save must never stomp the user's in-progress (invalid) edit.
  await expect(textarea).toHaveValue('{not valid json');
});
