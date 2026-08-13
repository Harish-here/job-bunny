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
