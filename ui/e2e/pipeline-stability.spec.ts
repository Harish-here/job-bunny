/**
 * e2e coverage for docs/product/pipeline-stability-hardening/blueprint.md
 * step 1.4 — wiring `DeferredGroup` into `RunsPage`. Mirrors
 * `run-experience.spec.ts`'s structural conventions (`pinProfile`,
 * `page.goto('/#/runs')`, stub-then-assert) and reuses `run-fixtures.ts`'s
 * `stubRunsList`/`stubRunDetail` helpers plus the new `stubDeferredSlots`.
 */

import { expect, test } from '@playwright/test';
import {
  type DeferredSlotRow,
  makeRow,
  pinProfile,
  type RunDetailFixture,
  type RunListRow,
  stubDeferredSlots,
  stubEvents,
  stubIntents,
  stubRunDetail,
  stubRunsList,
  stubSoftErrors,
} from './run-fixtures';

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

test('runs page: a day with 5 deferred slots and a catch-up run shows five reason-carrying entries and zero failed rows', async ({
  page,
}) => {
  // `kind: 'run'` is fine for this test — the catch-up badge itself is
  // task 25's own concern; this test only needs the runs list to have a
  // `passed` row so `data-outcome-kind="failed"` has zero matches.
  const catchupRow: RunListRow = {
    ...makeRow({ id: 401, status: 'passed', kind: 'run' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const catchupDetail: RunDetailFixture = {
    ...catchupRow,
    result: { stages: [] },
    failure: null,
    syncDryrun: null,
  };

  const deferredRows: DeferredSlotRow[] = [
    {
      runDate: '2026-08-12',
      slot: '09:00',
      reasonCode: 'host-asleep',
      reason: 'Job Bunny declined to start this run because the host was asleep.',
      decidedAt: '2026-08-12T09:00:05.000Z',
      notifiedAt: null,
    },
    {
      runDate: '2026-08-12',
      slot: '11:30',
      reasonCode: 'host-asleep',
      reason: 'Job Bunny declined to start this run because the host was asleep.',
      decidedAt: '2026-08-12T11:30:05.000Z',
      notifiedAt: null,
    },
    {
      runDate: '2026-08-12',
      slot: '13:00',
      reasonCode: 'network-unreachable',
      reason: 'Job Bunny declined to start this run because the network was unreachable.',
      decidedAt: '2026-08-12T13:00:05.000Z',
      notifiedAt: null,
    },
    {
      runDate: '2026-08-12',
      slot: '15:00',
      reasonCode: 'daemon-unavailable',
      reason: "Job Bunny's scheduler was not running during this scheduled window.",
      decidedAt: '2026-08-12T15:00:05.000Z',
      notifiedAt: null,
    },
    {
      runDate: '2026-08-12',
      slot: '17:00',
      reasonCode: 'host-asleep',
      reason: 'Job Bunny declined to start this run because the host was asleep.',
      decidedAt: '2026-08-12T17:00:05.000Z',
      notifiedAt: null,
    },
  ];

  await stubIntents(page, []);
  await stubRunsList(page, [catchupRow]);
  await stubRunDetail(page, catchupDetail);
  await stubSoftErrors(page, catchupRow.id, { total: 0, groups: [], breakerOpen: false });
  await stubEvents(page, catchupRow.id, []);
  await stubDeferredSlots(page, deferredRows);

  await page.goto('/#/runs');

  for (const n of [1, 2, 3, 4, 5]) {
    const entry = page.locator(`[data-qa="deferred-slot-entry-${n}"]`);
    await expect(entry).toBeVisible();
    await expect(entry).not.toHaveText('');
  }

  await expect(
    page.locator('[data-testid="run-row"][data-outcome-kind="failed"]'),
  ).toHaveCount(0);
});

// Step 1.7 — e2e for the catch-up banner (`LiveRunHeader`, task 26; the
// `estimatedDurationMs` prop threaded by `RunsPage`, task 27). Both tests
// share the same `startedAt` (5 minutes before "now" at fixture-build
// time) rather than mocking the clock — this repo's e2e suite has no
// clock-mocking convention (checked: no `page.clock` usage anywhere under
// `ui/e2e/`), and 5 minutes leaves a wide margin against real-world setup
// drift before either the remaining-minutes or the elapsed-minutes value
// could round to a different whole number.
const CATCHUP_SLOTS = ['09:00', '11:30', '14:00'];

function catchupRunFixtures(estimatedDurationMs: number | null) {
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const heartbeatAt = new Date().toISOString();
  const row: RunListRow = {
    ...makeRow({
      id: 601,
      status: 'running',
      kind: 'catchup',
      startedAt,
      finishedAt: null,
      heartbeatAt,
      catchupSlots: CATCHUP_SLOTS,
      progress: {
        stage: 'farm',
        stageIndex: 2,
        stageTotal: 10,
        stageStartedAt: startedAt,
        updatedAt: heartbeatAt,
        itemCurrent: null,
        itemTotal: null,
      },
    }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const detail: RunDetailFixture = {
    ...row,
    result: null,
    failure: null,
    syncDryrun: null,
    estimatedDurationMs,
  };
  return { row, detail };
}

test('runs page: a running catch-up shows the computed remaining time and never renders a stop control', async ({
  page,
}) => {
  // 20 min estimate - 5 min elapsed = a round 15 min remaining.
  const { row, detail } = catchupRunFixtures(20 * 60_000);

  await stubIntents(page, []);
  await stubRunsList(page, [row]);
  await stubRunDetail(page, detail);
  await stubSoftErrors(page, row.id, { total: 0, groups: [], breakerOpen: false });
  await stubEvents(page, row.id, []);
  await stubDeferredSlots(page, []);

  await page.goto('/#/runs');

  await expect(page.locator('[data-qa="catchup-banner-eta"]')).toHaveText('~15 min left');
  const standin = page.locator('[data-qa="catchup-banner-standin"]');
  for (const slot of CATCHUP_SLOTS) {
    await expect(standin).toContainText(slot);
  }
  await expect(page.locator('[data-qa="catchup-banner-stop"]')).toHaveCount(0);
});

test('runs page: a running catch-up with no duration estimate shows elapsed-only', async ({
  page,
}) => {
  const { row, detail } = catchupRunFixtures(null);

  await stubIntents(page, []);
  await stubRunsList(page, [row]);
  await stubRunDetail(page, detail);
  await stubSoftErrors(page, row.id, { total: 0, groups: [], breakerOpen: false });
  await stubEvents(page, row.id, []);
  await stubDeferredSlots(page, []);

  await page.goto('/#/runs');

  // `startedAt` is a fixed 5 minutes before fixture-build time, so the
  // rendered elapsed minutes is deterministically "5" with generous margin
  // against real-world drift; only the seconds component is left open.
  await expect(page.locator('[data-qa="catchup-banner-eta"]')).toHaveText(
    /^5m \d{1,2}s elapsed$/,
  );
  await expect(page.locator('[data-qa="catchup-banner"]')).not.toContainText('min left');
});
