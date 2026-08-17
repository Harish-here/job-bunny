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
import { stubDaemonStatus, stubDaemonUnreachable } from './run-fixtures';
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

test('settings: search-urls section content is reachable by a real scroll gesture when it overflows the viewport', async ({
  page,
}) => {
  // The shell (`Shell.tsx`) pins `h-screen overflow-hidden` and delegates
  // scrolling to each page; Playwright's own scrollIntoView-based
  // auto-scroll is programmatic and works even under `overflow: hidden`,
  // so this test drives a REAL wheel gesture instead — the only way to
  // catch a page that forgot its own `overflow-y-auto` container.
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto('/#/settings/search-urls');
  await expect(section(page)).toHaveAttribute('data-section', 'search-urls');

  const addRow = section(page).getByRole('button', { name: 'Add another search URL' });
  const saveButton = section(page).getByRole('button', { name: 'Save', exact: true });

  // Pile on enough rows to push the Save button below the fold at this
  // viewport height — the rajni fixture's own row count alone isn't
  // enough to overflow.
  for (let i = 0; i < 15; i++) {
    await addRow.click();
  }
  await expect(saveButton).not.toBeInViewport();

  await page.mouse.move(640, 200);
  await page.mouse.wheel(0, 1000);
  await expect(saveButton).toBeInViewport();
});

test("settings: schedule section shows the daemon's degraded state with cause and remedy", async ({
  page,
}) => {
  const degradedReason =
    "the database schema (v8) is newer than the running daemon's build (v7). This happens after an update that changes the schema.";
  await stubDaemonStatus(page, [
    {
      profile: 'rajni',
      enabled: true,
      nextRunAt: null,
      degraded: true,
      degradedReason,
      schemaVersion: 8,
      buildVersion: 7,
    },
  ]);
  await page.goto('/#/settings/schedule');

  const degraded = page.locator('[data-qa="schedule-daemon-status-degraded"]');
  await expect(degraded).toBeVisible();
  // Terse "Degraded — schema vN > daemon build vM" form (mockup:717), not
  // the full sentence — that already appears once in the global banner.
  await expect(degraded).toContainText('Degraded — schema v8 > daemon build v7');
  await expect(degraded).not.toContainText(degradedReason);
  await expect(degraded).toContainText('jobbunny serve stop && jobbunny serve start');
  await expect(page.locator('[data-qa="schedule-daemon-status-healthy"]')).toHaveCount(0);
});

test("settings: schedule section shows the daemon's healthy state with zero degraded markup", async ({
  page,
}) => {
  await stubDaemonStatus(page, [
    {
      profile: 'rajni',
      enabled: true,
      nextRunAt: '2026-08-13T11:30:00.000Z',
      degraded: false,
      degradedReason: null,
      schemaVersion: null,
      buildVersion: null,
    },
  ]);
  await page.goto('/#/settings/schedule');

  await expect(page.locator('[data-qa="schedule-daemon-status-healthy"]')).toBeVisible();
  await expect(page.locator('[data-qa="schedule-daemon-status-degraded"]')).toHaveCount(
    0,
  );
});

test('settings: schedule section renders the unreachable-daemon error state, and it is never mistaken for the degraded state (Degraded ≠ unreachable, ux-notes.md callout 13)', async ({
  page,
}) => {
  // Same idiom `run-experience.spec.ts` already uses for the Run Now
  // sidebar's daemon-unknown state, reused here for the Schedule section's
  // own error state — the gap this test closes.
  await stubDaemonUnreachable(page);
  await page.goto('/#/settings/schedule');

  const error = page.locator('[data-qa="schedule-daemon-status-error"]');
  await expect(error).toBeVisible();
  await expect(error).toContainText("Can't reach the daemon API");
  // The distinguishing assertion: an unreachable probe must never render
  // as degraded — collapsing "we can't tell" into "we know, and it's
  // broken" is the exact regression this test guards.
  await expect(page.locator('[data-qa="schedule-daemon-status-degraded"]')).toHaveCount(
    0,
  );
  await expect(page.locator('[data-qa="schedule-daemon-status-healthy"]')).toHaveCount(0);

  // Retry is wired, not inert: it re-issues the GET.
  let requestCount = 0;
  page.on('request', (req) => {
    if (req.url().includes('/api/daemon') && req.method() === 'GET') requestCount++;
  });
  const countBefore = requestCount;
  await error.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => requestCount, { timeout: 5_000 }).toBeGreaterThan(countBefore);
});

test('settings: schedule section renders the loading skeleton while /api/daemon is genuinely in flight, and nothing else', async ({
  page,
}) => {
  // A held-open route — the query is actually pending, not merely
  // resolved-fast-enough-to-look-pending, which is the distinction this
  // test needs to be meaningful.
  await page.route('**/api/daemon*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({
      status: 200,
      json: {
        state: 'running',
        pid: 4242,
        startedAt: '2026-08-13T09:00:00.000Z',
        lastTickAt: new Date().toISOString(),
        inFlight: null,
        profiles: [],
      },
    });
  });
  await page.goto('/#/settings/schedule');

  await expect(page.locator('[data-qa="schedule-daemon-status-loading"]')).toBeVisible();
  await expect(page.locator('[data-qa="schedule-daemon-status-healthy"]')).toHaveCount(0);
  await expect(page.locator('[data-qa="schedule-daemon-status-error"]')).toHaveCount(0);

  // ...and it resolves into the healthy state once the request lands.
  await expect(page.locator('[data-qa="schedule-daemon-status-healthy"]')).toBeVisible({
    timeout: 5_000,
  });
});
