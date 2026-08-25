/**
 * e2e coverage for the Settings Landing screen (`#/settings`'s bare-route
 * default, `LandingSection` — blueprint.md's step 9d, mockup-fragment.html's
 * `s1` frame) — the default render off a seeded run, the empty-run case, the
 * bare-route-resolves-with-zero-clicks case, and the loading/error states of
 * its thin-run card, driven against the REAL board server over
 * `profiles/rajni`'s seeded fixture. Every test here only READS config docs
 * (never mutates one) or stubs the run-list/run-detail endpoints via
 * `page.route` (client-side interception, touching no server state) — so,
 * unlike `settings.spec.ts`, no test needs a `finally`-restore.
 */
import { expect, type Page, test } from '@playwright/test';
import {
  type FunnelStage,
  makeRow,
  mountSingleRun,
  pinProfile,
  type RunDetailFixture,
  type RunListRow,
  stage,
  stubRunDetail,
  stubRunsList,
  stubSoftErrors,
} from './run-fixtures';

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

// --- local helpers (module-private copies of settings.spec.ts's own
// fetchConfigText/fetchConfigJson/section, same shape/body — this file only
// ever reads config docs, so putConfigText/saveSection aren't needed here) ---

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

function section(page: Page) {
  return page.getByTestId('settings-section');
}

// --- fixture-building helpers local to this file ---

const CAP_ROW_IDS = [
  'landing-cap-row-max-new-per-lane',
  'landing-cap-row-max-probes-per-run',
  'landing-cap-row-max-cards-per-url',
  'landing-cap-row-max-age-days',
] as const;

/** Builds one 3-stage funnel whose LAST stage holds the single largest drop
 * count (`rank`/`belowThreshold` at 146, bigger than every other stage's own
 * rule counts), so `getBiggestDrop` resolves unambiguously, plus the
 * `RunListRow`/`RunDetailFixture` pair `mountSingleRun` needs. */
function buildRunFixture(id: number): {
  row: RunListRow;
  detail: RunDetailFixture;
  stages: FunnelStage[];
} {
  const stages: FunnelStage[] = [
    stage('source', 200, 190, { badUrl: 3 }),
    stage('filter', 190, 150, { locations: 30, companies: 10 }),
    stage('rank', 150, 4, { belowThreshold: 146 }),
  ];
  const row: RunListRow = {
    ...makeRow({ id, status: 'passed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const detail: RunDetailFixture = {
    ...row,
    result: { stages },
    failure: null,
    syncDryrun: null,
  };
  return { row, detail, stages };
}

/** Mirrors `LandingCapsTable.tsx`'s own `positiveNumber` fallback posture:
 * anything other than a positive finite number falls back to the shipped
 * default, so a test computing an "expected" cap value from raw config JSON
 * degrades the same way the component itself does. */
function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

async function expectedCapValues(page: Page): Promise<{
  maxNewPerLane: number;
  maxProbesPerRun: number;
  maxCardsPerUrl: number;
  maxAgeDays: number;
}> {
  const profileJson = await fetchConfigJson(page, 'profile.json');
  const settings = (profileJson.settings ?? {}) as Record<string, unknown>;
  const source = (settings.source ?? {}) as Record<string, unknown>;
  const linkedin = (settings.linkedin ?? {}) as Record<string, unknown>;
  return {
    maxNewPerLane: positiveNumber(source.maxNewPerLane, 40),
    maxProbesPerRun: positiveNumber(source.maxProbesPerRun, 25),
    maxCardsPerUrl: positiveNumber(linkedin.maxCardsPerUrl, 40),
    maxAgeDays: positiveNumber(linkedin.maxAgeDays, 30),
  };
}

test('landing: default render surfaces the scraped count, on-board count and biggest-drop rule from a seeded run', async ({
  page,
}) => {
  const { row, detail, stages } = buildRunFixture(501);
  await mountSingleRun(page, { row, detail });

  // Bare `#/settings` (NOT `#/settings/landing`) — proves the bare-route
  // default too; test (c) below covers that positively and explicitly.
  await page.goto('/#/settings');

  const scraped = stages[0]?.jobsIn;
  const lastStage = stages[stages.length - 1];
  const onBoard = lastStage ? lastStage.jobsOut : 0;
  let biggest: { stage: string; rule: string; count: number } | null = null;
  for (const s of stages) {
    for (const [rule, count] of Object.entries(s.dropsByRule)) {
      if (!biggest || count > biggest.count) biggest = { stage: s.name, rule, count };
    }
  }
  if (!biggest) throw new Error('fixture must have an unambiguous biggest drop');

  const card = page.locator('[data-qa="landing-thin-run"]');
  await expect(card).toContainText(String(scraped));
  await expect(card).toContainText(String(onBoard));
  await expect(card).toContainText(biggest.stage);
  await expect(card).toContainText(biggest.rule);
});

// An empty `[]` response is NOT a failing request — this case alone does not
// prove failure-independence of the caps/rules tables. Cases (d) and (e)
// below (a held request, and a 500) are what prove that.
test('landing: an empty run list replaces the thin-run card with the muted empty line, while caps/rules still render from config', async ({
  page,
}) => {
  await stubRunsList(page, []);

  await page.goto('/#/settings');

  const card = page.locator('[data-qa="landing-thin-run"]');
  await expect(card).toHaveText('No run recorded yet');

  await expect(page.locator('[data-qa="landing-caps-table"]')).toBeVisible();
  await expect(page.locator('[data-qa="landing-caps-table"] tbody tr')).toHaveCount(4);
  await expect(page.locator('[data-qa="landing-rules-summary"]')).toBeVisible();
  await expect(page.locator('[data-qa="landing-rules-summary"] tbody tr')).toHaveCount(3);
});

test('landing: bare #/settings resolves to the Landing section with zero extra clicks', async ({
  page,
}) => {
  const { row, detail } = buildRunFixture(502);
  await mountSingleRun(page, { row, detail });

  await page.goto('/#/settings');

  // No click anywhere before this assertion — proves `parseHash`'s
  // `#/settings`-with-no-section default ('landing') mounts LandingSection
  // immediately, not just after some nav interaction.
  await expect(page.locator('[data-qa="landing-caps-table"]')).toBeVisible();
  await expect(section(page)).toHaveAttribute('data-section', 'landing');
});

test('landing: loading — GET runs held past first paint shows the thin-run skeleton and pending caps bindings, while rules-summary renders immediately', async ({
  page,
}) => {
  const { row, detail, stages } = buildRunFixture(503);

  await page.route('**/api/profiles/rajni/runs*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = route.request().url();
    // Excludes every nested per-run path (`:id`, `:id/soft-errors`,
    // `:id/events`) so only the bare list request is held — mirrors
    // `stubRunsList`'s own glob-and-exclusion idiom.
    if (/\/runs\/\d+/.test(url)) return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({ json: { rows: [row], total: 1, limit: 100, offset: 0 } });
  });
  await stubRunDetail(page, detail);
  await stubSoftErrors(page, row.id, { total: 0, groups: [], breakerOpen: false });

  await page.goto('/#/settings');

  // Immediately (well before the 1.5s delay resolves):
  await expect(page.locator('[data-qa="landing-thin-run-loading"]')).toBeVisible();

  for (const id of CAP_ROW_IDS) {
    // `runId` is still unknown (the runs list itself hasn't resolved), so
    // `softErrorsQuery` is disabled and every row's Binding cell reads the
    // "no signal yet" placeholder, never a false "not hit".
    await expect(page.locator(`[data-qa="${id}"] td`).nth(2)).toHaveText('—');
  }

  // Depends only on the already-resolved filter.json/profile.json queries,
  // not on the held runs request — renders its real content right away, in
  // the same assertion window as the above.
  await expect(page.locator('[data-qa="landing-rules-summary"] tbody tr')).toHaveCount(3);
  await expect(page.locator('[data-qa="landing-rules-summary"]')).toContainText(
    'Roles & companies',
  );

  // After the delay elapses, the thin-run card resolves to real content.
  const lastStage = stages[stages.length - 1];
  const onBoard = lastStage ? lastStage.jobsOut : 0;
  await expect(page.locator('[data-qa="landing-thin-run"]')).toContainText(
    String(onBoard),
    { timeout: 10_000 },
  );
});

test('landing: error — GET runs 500s, thin-run shows an inline error+retry while caps/rules still render real config values', async ({
  page,
}) => {
  const expected = await expectedCapValues(page);

  await page.route('**/api/profiles/rajni/runs*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = route.request().url();
    if (/\/runs\/\d+/.test(url)) return route.fallback();
    await route.fulfill({
      status: 500,
      json: { error: { code: 'boom', message: 'server error' } },
    });
  });

  await page.goto('/#/settings');

  const card = page.locator('[data-qa="landing-thin-run"]');
  // The runs query's default `retry: 1` backs off before settling into its
  // error state — a generous timeout avoids a flake in slower CI runs.
  await expect(card).toContainText("Couldn't load your last run.", { timeout: 10_000 });
  await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible();

  // No crash: all 4 cap rows are present with their real config-derived
  // values; binding badges are simply absent (a fail-soft skip, since
  // `runId` never resolves) rather than a false "not hit".
  await expect(
    page.locator('[data-qa="landing-cap-row-max-new-per-lane"] td').nth(1),
  ).toHaveText(String(expected.maxNewPerLane));
  await expect(
    page.locator('[data-qa="landing-cap-row-max-probes-per-run"] td').nth(1),
  ).toHaveText(String(expected.maxProbesPerRun));
  await expect(
    page.locator('[data-qa="landing-cap-row-max-cards-per-url"] td').nth(1),
  ).toHaveText(String(expected.maxCardsPerUrl));
  await expect(
    page.locator('[data-qa="landing-cap-row-max-age-days"] td').nth(1),
  ).toHaveText(String(expected.maxAgeDays));
  for (const id of CAP_ROW_IDS) {
    await expect(page.locator(`[data-qa="${id}"] td`).nth(2)).toHaveText('—');
  }

  await expect(page.locator('[data-qa="landing-rules-summary"] tbody tr')).toHaveCount(3);
});
