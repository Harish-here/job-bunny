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

// Step 1.9 — e2e for run detail catch-up (task 30). Cross-surface
// consistency pair is `run-row-catchup` (task 25's "Stood in for N
// slots" subline, a COUNT) vs. `run-detail-covered-slots` (task 29's
// "Covered slots: ..." list) — NOT the catch-up banner
// (`catchup-banner-standin`), which is out of scope: the banner and this
// row/detail pairing depict two different runs in the mockup (3 slots vs.
// 5), and the banner only exists for a run that's still `running`, which
// this test's `passed`, already-completed catch-up run deliberately is
// not. Both counts are anchored to ONE fixture's `catchupSlots` array via
// ONE navigation — a real consistency check, not two surfaces
// independently agreeing on a shared bug. `RunDetailView.tsx` renders
// this element as `data-testid="run-detail-covered-slots"` (not
// `data-qa`, unlike its sibling ids from the same task) — a pre-existing
// naming inconsistency in already-landed markup this test observes
// rather than corrects.
test('run detail: a catch-up run shows what it covered without leaving the page', async ({
  page,
}) => {
  const coveredSlots = ['09:00', '11:30', '14:00', '16:30', '19:00'];
  const row: RunListRow = {
    ...makeRow({
      id: 701,
      status: 'passed',
      kind: 'catchup',
      catchupSlots: coveredSlots,
    }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const detail: RunDetailFixture = {
    ...row,
    result: { stages: [] },
    failure: null,
    syncDryrun: null,
  };

  await stubIntents(page, []);
  await stubRunsList(page, [row]);
  await stubRunDetail(page, detail);
  await stubSoftErrors(page, row.id, { total: 0, groups: [], breakerOpen: false });
  await stubEvents(page, row.id, []);
  await stubDeferredSlots(page, []);

  await page.goto('/#/runs');

  // Single row -> `RunsPage` auto-selects it, so its detail is already
  // showing without a click ("without leaving the page" / one navigation).
  const subline = page.locator(
    '[data-qa="run-row-catchup"] [data-testid="run-row-subline"]',
  );
  await expect(subline).toBeVisible();
  const sublineText = (await subline.textContent()) ?? '';
  const sublineMatch = sublineText.match(/Stood in for (\d+) slot/);
  expect(sublineMatch).not.toBeNull();
  const sublineCount = Number(sublineMatch?.[1]);

  const covered = page.locator('[data-testid="run-detail-covered-slots"]');
  await expect(covered).toBeVisible();
  const coveredText = (await covered.textContent()) ?? '';
  const coveredMatch = coveredText.match(/Covered slots: (.+)$/);
  expect(coveredMatch).not.toBeNull();
  const coveredCount = (coveredMatch?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  expect(sublineCount).toBe(coveredSlots.length);
  expect(coveredCount).toBe(coveredSlots.length);
  expect(sublineCount).toBe(coveredCount);
});
