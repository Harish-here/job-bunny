/**
 * e2e coverage for the 12-section Settings IA (task 22's atomic
 * switchover), driven against the REAL board server over `profiles/rajni`'s
 * seeded fixture. Every test captures the doc it is about to mutate BEFORE
 * editing and restores it in a `finally` — `seed.ts`'s `globalSetup` wipes
 * `config_docs` ONCE per whole suite run, not per test, so a leftover
 * mutation here would leak into every later test in this same invocation,
 * including this file's own and `profile-lifecycle.spec.ts`'s. Every
 * round-trip asserts server-side state via `page.request.get`, never the
 * form alone.
 *
 * Tests 1, 3, 4, 5, 6, 7, 8 below are RELOCATIONS from the pre-switchover
 * 6-section IA — only their `page.goto` target (and, for 6/7, the
 * dialog-open step and textarea locator) changed; their assertion bodies
 * are otherwise materially unchanged. Test 2 survives completely
 * unchanged. Do not read the apparent overlap between tests 1 and 5 (both
 * now targeting `#/settings/where-jobs-come-from`) as duplication — they
 * cover the section's two distinct cards (Lanes, Search URLs).
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

test('settings: where jobs come from section round-trips a lane toggle through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'profile.json');
  try {
    await page.goto('/#/settings/where-jobs-come-from');
    await expect(section(page)).toHaveAttribute('data-section', 'where-jobs-come-from');

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

test('settings: skills section round-trips a minimum skill match count through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'filter.json');
  try {
    await page.goto('/#/settings/skills');
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

test('settings: about you section round-trips years of experience through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'resume.json');
  try {
    await page.goto('/#/settings/about-you');
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

test('settings: where jobs come from section round-trips a new search-url entry through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'search_urls.md');
  try {
    await page.goto('/#/settings/where-jobs-come-from');
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
    // WhereJobsComeFromSection renders row labels only as an input value,
    // never as text content — mirrors the section's own colocated test
    // precedent (a Testing Library API; Playwright's equivalent is
    // asserting the input's value directly) for the identical scenario.
    await expect(section(page).getByLabel('Label').last()).toHaveValue('Platform roles');
  } finally {
    await putConfigText(page, 'search_urls.md', original);
  }
});

test('settings: raw config section round-trips raw filter.json text through the server', async ({
  page,
}) => {
  const original = await fetchConfigText(page, 'filter.json');
  try {
    await page.goto('/#/settings/raw-config');
    await page
      .locator('[data-qa="raw-doc-filter-json"]')
      .getByRole('button', { name: 'filter.json', exact: true })
      .click();
    const textarea = page.locator('[data-qa="raw-editor"]');
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
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('validation-summary')).toHaveCount(0);

    const saved = await fetchConfigJson(page, 'filter.json');
    expect((saved.companies as { avoid: string[] }).avoid).toContain(
      'E2EPhase4SettingsHatch',
    );

    await page.reload();
    await page
      .locator('[data-qa="raw-doc-filter-json"]')
      .getByRole('button', { name: 'filter.json', exact: true })
      .click();
    await expect(page.locator('[data-qa="raw-editor"]')).toContainText(
      'E2EPhase4SettingsHatch',
    );
  } finally {
    await putConfigText(page, 'filter.json', original);
  }
});

test("settings: invalid JSON in the raw config editor is rejected inline with SaveBar's validation summary", async ({
  page,
}) => {
  await page.goto('/#/settings/raw-config');
  await page
    .locator('[data-qa="raw-doc-filter-json"]')
    .getByRole('button', { name: 'filter.json', exact: true })
    .click();
  const textarea = page.locator('[data-qa="raw-editor"]');
  await expect(textarea).toBeVisible();
  await textarea.fill('{not valid json');
  // Save is never disabled (repo-wide rule) — clicking it surfaces the
  // client-side parse error via SaveBar's validation summary instead.
  await page.getByTestId('save-button').click();

  const summary = page.getByTestId('validation-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/Invalid JSON/);
  // A failed save must never stomp the user's in-progress (invalid) edit.
  await expect(textarea).toHaveValue('{not valid json');
});

test('settings: where-jobs-come-from search-url rows are reachable by a real scroll gesture when they overflow the viewport', async ({
  page,
}) => {
  // The shell (`Shell.tsx`/`SettingsShell.tsx`) pins `h-screen
  // overflow-hidden` and delegates scrolling to the settings main column;
  // Playwright's own scrollIntoView-based auto-scroll is programmatic and
  // works even under `overflow: hidden`, so this test drives a REAL wheel
  // gesture instead — the only way to catch a page that forgot its own
  // `overflow-y-auto` container.
  //
  // The pre-switchover version of this test used the section's own Save
  // button as the below-the-fold indicator; `SaveBar` (task 5) is `sticky
  // bottom-0` inside `main`, so it is ALWAYS in viewport once `main` is
  // on screen — a bad proxy for "did we forget overflow-y-auto" now. The
  // last search-url row's own input is not sticky and serves the same
  // purpose. Rows are added via a raw DOM `.click()` (bypassing
  // Playwright's action-driven auto-scroll-into-view) so the loop itself
  // never moves the scroll position — only the final wheel gesture does.
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto('/#/settings/where-jobs-come-from');
  await expect(section(page)).toHaveAttribute('data-section', 'where-jobs-come-from');

  const addRow = section(page).getByRole('button', { name: 'Add another search URL' });

  // Pile on enough rows to push the last row below the fold at this
  // viewport height — the rajni fixture's own row count alone isn't
  // enough to overflow.
  for (let i = 0; i < 15; i++) {
    await addRow.evaluate((el: HTMLElement) => el.click());
  }
  const lastRowUrlInput = section(page).getByLabel('Search URL', { exact: true }).last();
  await expect(lastRowUrlInput).not.toBeInViewport();

  await page.mouse.move(640, 200);
  // A large delta — wheel scroll clamps at the container's max scrollTop,
  // so this reliably reaches the bottom regardless of exactly how tall 15
  // extra rows render, without needing a fragile pixel-perfect estimate.
  await page.mouse.wheel(0, 4000);
  await expect(lastRowUrlInput).toBeInViewport();
});
