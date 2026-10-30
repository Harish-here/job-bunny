/**
 * e2e coverage for task 27 (blueprint.md Step 11, R11/S2) — `BadLinksPanel`
 * wired into `RunDetailView` as an independent conditional, sibling to the
 * `DiagnosisPanel` gate. Reuses `run-experience.spec.ts`'s `mountSingleRun`
 * route-stubbing idiom (`run-fixtures.ts`), never the real-server idiom.
 */

import { expect, test } from '@playwright/test';
import {
  DAEMON_SETTLE_TIMEOUT_MS,
  type FunnelStage,
  makeRow,
  mountSingleRun,
  pinProfile,
  type RunDetailFixture,
  type RunListRow,
  stage,
  stubEvents,
  stubIntents,
  stubRunsList,
  stubSoftErrors,
} from './run-fixtures';

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

const PRODUCED_STAGES: FunnelStage[] = [
  stage('reconcile', 0, 0),
  stage('farm', 0, 18),
  stage('source', 214, 211, { 'fetch timeout': 3 }),
  stage('compress', 211, 211),
  stage('structure', 211, 205, { unparseable: 6 }),
  stage('assemble', 205, 205),
  stage('filter', 205, 34, { locations: 171 }),
  stage('dedup', 34, 15, { duplicate: 19 }),
  stage('rank', 15, 15),
  stage('sync', 15, 7, { 'already on board': 8 }),
];

test('run detail: a produced run with 2 soft-failed links shows the bad-links panel, and Fix in Settings navigates to the search-urls card', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 501, status: 'passed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const detail: RunDetailFixture = {
    ...row,
    result: {
      stages: PRODUCED_STAGES,
      linkSoftErrors: [
        {
          url: 'https://www.linkedin.com/jobs/search/?keywords=sre&location=Remote',
          reason: 'results list never loaded',
          label: 'Comcast SRE',
        },
        {
          url: 'https://www.linkedin.com/jobs/search-results/?keywords=platform&location=Remote',
          reason: 'timed out',
          label: 'Zafin',
        },
      ],
    },
    failure: null,
    syncDryrun: null,
  };
  await mountSingleRun(page, { row, detail });

  await page.goto('/#/runs');

  const panel = page.getByTestId('rundetail-bad-links-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('2 search links failed — the run continued');

  const rows = panel.getByRole('listitem');
  await expect(rows.nth(0)).toContainText('Comcast SRE');
  await expect(rows.nth(0)).toContainText('results list never loaded');
  await expect(rows.nth(1)).toContainText('Zafin');
  await expect(rows.nth(1)).toContainText('timed out');

  await panel.getByRole('button', { name: 'Fix in Settings' }).click();
  await expect(page).toHaveURL(/#\/settings\/where-jobs-come-from/);
});

test('run detail: a produced run with zero soft-failed links shows no bad-links panel', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 502, status: 'passed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const detail: RunDetailFixture = {
    ...row,
    result: { stages: PRODUCED_STAGES },
    failure: null,
    syncDryrun: null,
  };
  await mountSingleRun(page, { row, detail });

  await page.goto('/#/runs');

  await expect(page.getByTestId('rundetail-outcome-header')).toBeVisible();
  await expect(page.getByTestId('rundetail-bad-links-panel')).toHaveCount(0);
});

test('run detail: a failed total-outage run shows the existing destructive panel, never the bad-links panel', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 503, status: 'failed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const detail: RunDetailFixture = {
    ...row,
    result: null,
    failure: {
      stage: 'source',
      error: 'every attempted LinkedIn URL yielded zero listings',
      elapsedMs: 60_000,
    },
    syncDryrun: null,
  };
  await mountSingleRun(page, { row, detail });

  await page.goto('/#/runs');

  await expect(page.getByTestId('diagnosis-panel')).toBeVisible();
  await expect(page.getByTestId('rundetail-bad-links-panel')).toHaveCount(0);
});

// B13 (QA search-link-intake) below — two mockup/ux states the QA round
// found untested: Copy links (real clipboard write) and S2's run-detail
// loading/error states showing no bad-links panel.

test('run detail: "Copy links" writes the newline-joined full URLs to the clipboard and flips its label', async ({
  page,
  context,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 504, status: 'passed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const detail: RunDetailFixture = {
    ...row,
    result: {
      stages: PRODUCED_STAGES,
      linkSoftErrors: [
        {
          url: 'https://www.linkedin.com/jobs/search/?keywords=sre&location=Remote',
          reason: 'results list never loaded',
          label: 'Comcast SRE',
        },
      ],
    },
    failure: null,
    syncDryrun: null,
  };
  await mountSingleRun(page, { row, detail });
  // Chromium denies `clipboard-write` by default in a fresh Playwright
  // context (same grant `operate.spec.ts`/`shell.spec.ts` already use for
  // this exact reason). The spy wraps (never replaces) the real
  // `writeText` — same idiom as `operate.spec.ts:613-623` — rather than
  // reading the clipboard back, which those two files' own doc comments
  // note is the flakier path.
  await context.grantPermissions(['clipboard-write'], {
    origin: 'http://127.0.0.1:4199',
  });
  await page.addInitScript(() => {
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    (window as unknown as { __copyCalls: string[] }).__copyCalls = [];
    navigator.clipboard.writeText = (text: string) => {
      (window as unknown as { __copyCalls: string[] }).__copyCalls.push(text);
      return original(text);
    };
  });

  await page.goto('/#/runs');

  const panel = page.getByTestId('rundetail-bad-links-panel');
  // `data-qa`, not `getByRole(..., { name: 'Copy links' })` — that
  // accessible-name filter stops matching the instant the label flips to
  // "Copied", so a `toHaveText` assertion against it would wait forever.
  const copyButton = panel.locator('[data-qa="run-bad-links-copy"]');
  await copyButton.click();

  await expect(copyButton).toHaveText('Copied');
  const calls = await page.evaluate(
    () => (window as unknown as { __copyCalls: string[] }).__copyCalls,
  );
  expect(calls).toEqual([
    'https://www.linkedin.com/jobs/search/?keywords=sre&location=Remote',
  ]);
});

test('run detail: loading and error states both show no bad-links panel', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 505, status: 'passed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  await stubIntents(page, []);
  await stubRunsList(page, [row]);
  await stubSoftErrors(page, row.id, { total: 0, groups: [], breakerOpen: false });
  await stubEvents(page, row.id, []);

  let releaseDetail: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  let shouldFail = false;
  await page.route(`**/api/profiles/rajni/runs/${row.id}*`, async (route) => {
    const url = route.request().url();
    if (url.includes('/events') || url.includes('/soft-errors')) return route.fallback();
    await gate;
    if (shouldFail) {
      await route.fulfill({
        status: 500,
        json: { error: { code: 'server_error', message: 'boom' } },
      });
      return;
    }
    await route.fulfill({
      json: {
        ...row,
        result: { stages: PRODUCED_STAGES },
        failure: null,
        syncDryrun: null,
      },
    });
  });

  await page.goto('/#/runs');

  // Loading: the detail fetch hasn't resolved yet — no bad-links panel.
  await expect(page.getByTestId('rundetail-bad-links-panel')).toHaveCount(0);

  shouldFail = true;
  releaseDetail?.();

  await expect(page.getByText("Couldn't load this run")).toBeVisible({
    timeout: DAEMON_SETTLE_TIMEOUT_MS,
  });
  await expect(page.getByTestId('rundetail-bad-links-panel')).toHaveCount(0);
});
