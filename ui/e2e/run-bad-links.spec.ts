/**
 * e2e coverage for task 27 (blueprint.md Step 11, R11/S2) — `BadLinksPanel`
 * wired into `RunDetailView` as an independent conditional, sibling to the
 * `DiagnosisPanel` gate. Reuses `run-experience.spec.ts`'s `mountSingleRun`
 * route-stubbing idiom (`run-fixtures.ts`), never the real-server idiom.
 */

import { expect, test } from '@playwright/test';
import {
  type FunnelStage,
  makeRow,
  mountSingleRun,
  pinProfile,
  type RunDetailFixture,
  type RunListRow,
  stage,
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
