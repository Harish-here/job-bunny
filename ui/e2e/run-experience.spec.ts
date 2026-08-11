/**
 * e2e coverage for docs/product/run-experience-overhaul/mockup.html's
 * seven-way outcome vocabulary and its detail-pane diagnosis classes —
 * everything `runcontrol.spec.ts` doesn't already cover (queued/pending
 * dedupe, live header with progress, stale heartbeat, daemon-down copy
 * button). Reuses that spec's stub idiom via `run-fixtures.ts`: every
 * state here is produced by stubbing `GET /api/profiles/rajni/runs`,
 * `/runs/:id`, `/runs/:id/soft-errors`, `/runs/:id/events`, and
 * `/run-intents` — never by seeding a run into rajni's shared sqlite
 * fixture, which stays empty of `runs` rows for every other suite.
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
  stubDaemonUnreachable,
  stubEvents,
  stubIntents,
  stubRunDetail,
  stubRunsList,
  stubRunsListOnceThenFail,
  stubSoftErrors,
} from './run-fixtures';

test.beforeEach(async ({ page }) => {
  await pinProfile(page);
});

// ---- shared fixture funnels, mirroring mockup.html's S3/S4 numbers ------

/** S3's produced run: 214 scraped down to 7 synced. */
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

/** S4's clean-empty run: all 10 stages complete, `filter` drops everything. */
const CLEAN_STAGES: FunnelStage[] = [
  stage('reconcile', 0, 0),
  stage('farm', 0, 0),
  stage('source', 214, 214),
  stage('compress', 214, 214),
  stage('structure', 214, 214),
  stage('assemble', 214, 214),
  stage('filter', 214, 0, { locations: 189, title: 25 }),
  stage('dedup', 0, 0),
  stage('rank', 0, 0),
  stage('sync', 0, 0),
];

function rowLocator(page: import('@playwright/test').Page, id: number) {
  return page.locator(`[data-testid="run-row"][data-run-id="${id}"]`);
}

test('run history: the 7 outcome kinds render as distinguishable text', async ({
  page,
}) => {
  const producedRow: RunListRow = {
    ...makeRow({ id: 301, status: 'passed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const emptyRow: RunListRow = {
    ...makeRow({ id: 302, status: 'passed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const degradedRow: RunListRow = {
    ...makeRow({ id: 303, status: 'passed' }),
    softErrors: { total: 8, groups: [], breakerOpen: false },
  };
  const failedRow: RunListRow = {
    ...makeRow({ id: 304, status: 'failed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const crashedRow: RunListRow = {
    ...makeRow({ id: 305, status: 'crashed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const unrecordedRow: RunListRow = {
    ...makeRow({ id: 306, status: 'crashed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const runningRow: RunListRow = {
    ...makeRow({
      id: 307,
      status: 'running',
      finishedAt: null,
      progress: {
        stage: 'filter',
        stageIndex: 7,
        stageTotal: 10,
        stageStartedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        itemCurrent: null,
        itemTotal: null,
      },
    }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };

  await stubIntents(page, []);
  await stubRunsList(page, [
    producedRow,
    emptyRow,
    degradedRow,
    failedRow,
    crashedRow,
    unrecordedRow,
    runningRow,
  ]);
  await stubRunDetail(page, {
    ...producedRow,
    result: { stages: PRODUCED_STAGES },
    failure: null,
    syncDryrun: null,
  });
  await stubRunDetail(page, {
    ...emptyRow,
    result: { stages: CLEAN_STAGES },
    failure: null,
    syncDryrun: null,
  });
  await stubRunDetail(page, {
    ...degradedRow,
    result: { stages: CLEAN_STAGES },
    failure: null,
    syncDryrun: null,
  });
  await stubRunDetail(page, {
    ...crashedRow,
    result: null,
    failure: { stage: 'source', error: 'boom', elapsedMs: 1000 },
    syncDryrun: null,
  });
  const unrecordedDetail: RunDetailFixture = {
    ...unrecordedRow,
    result: null,
    failure: null,
    syncDryrun: null,
  };
  await stubRunDetail(page, unrecordedDetail);
  // The selected (rows[0] = producedRow) run's own detail-pane fetches —
  // not required for this test's list-only assertions, but stubbed so no
  // request escapes to the real server.
  await stubSoftErrors(page, producedRow.id, {
    total: 0,
    groups: [],
    breakerOpen: false,
  });
  await stubEvents(page, producedRow.id, []);

  await page.goto('/#/runs');

  await expect(rowLocator(page, 301).getByTestId('run-row-label')).toHaveText(
    'New jobs on your board',
  );
  await expect(rowLocator(page, 301).getByTestId('run-row-number')).toHaveText('7');

  await expect(rowLocator(page, 302).getByTestId('run-row-label')).toHaveText(
    'Ran clean',
  );
  await expect(rowLocator(page, 302).getByTestId('run-row-subline')).toContainText(
    '10/10 stages',
  );

  await expect(rowLocator(page, 303).getByTestId('run-row-label')).toHaveText(
    'Ran with warnings',
  );
  await expect(rowLocator(page, 303).getByTestId('run-row-subline')).toHaveText(
    '8 soft errors',
  );

  await expect(rowLocator(page, 304).getByTestId('run-row-label')).toHaveText('Failed');

  await expect(rowLocator(page, 305).getByTestId('run-row-label')).toHaveText(
    'Lost contact',
  );

  await expect(rowLocator(page, 306).getByTestId('run-row-label')).toHaveText(
    'Telemetry missing',
  );
  await expect(rowLocator(page, 306).getByTestId('run-row-number')).toHaveText('—');

  await expect(rowLocator(page, 307).getByTestId('run-row-label')).toContainText(
    'Running',
  );

  // Sanity cross-check on the outcome-kind attribute, independent of copy.
  await expect(rowLocator(page, 301)).toHaveAttribute('data-outcome-kind', 'produced');
  await expect(rowLocator(page, 302)).toHaveAttribute('data-outcome-kind', 'empty');
  await expect(rowLocator(page, 303)).toHaveAttribute('data-outcome-kind', 'degraded');
  await expect(rowLocator(page, 304)).toHaveAttribute('data-outcome-kind', 'failed');
  await expect(rowLocator(page, 305)).toHaveAttribute('data-outcome-kind', 'crashed');
  await expect(rowLocator(page, 306)).toHaveAttribute('data-outcome-kind', 'unrecorded');
  await expect(rowLocator(page, 307)).toHaveAttribute('data-outcome-kind', 'running');
});

test('run detail: produced shows the yield, stage rail, an additive (never-zero) farm row, and the evidence line', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 401, status: 'passed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  await mountSingleRun(page, {
    row,
    detail: {
      ...row,
      result: { stages: PRODUCED_STAGES },
      failure: null,
      syncDryrun: null,
    },
  });

  await page.goto('/#/runs');

  const header = page.getByTestId('rundetail-outcome-header');
  await expect(header).toContainText('7');
  await expect(header).toContainText('New jobs on your board');

  await expect(page.getByTestId('rundetail-stage-rail')).toBeVisible();

  const funnel = page.getByTestId('rundetail-funnel-table');
  const farmRow = funnel.locator('tr', { hasText: 'farm' });
  await expect(farmRow).toContainText('— → 18');
  await expect(farmRow).not.toContainText('0 → 18');
  const reconcileRow = funnel.locator('tr', { hasText: 'reconcile' });
  await expect(reconcileRow).toContainText('n/a · state-sync only');

  await expect(page.getByTestId('evidence-disclosure-trigger')).toBeVisible();
});

test('run detail: empty (zero-yield healthy) renders a calm diagnosis with no primary action', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 402, status: 'passed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  await mountSingleRun(page, {
    row,
    detail: { ...row, result: { stages: CLEAN_STAGES }, failure: null, syncDryrun: null },
  });

  await page.goto('/#/runs');

  const panel = page.getByTestId('diagnosis-panel');
  await expect(panel.getByTestId('diagnosis-line-1')).toContainText('Ran clean —');

  // No primary action: the panel's only button is the quiet
  // "Review filter rules" link (C8 — an action affordance here would
  // re-manufacture the alarm this feature exists to remove).
  await expect(panel.getByRole('button')).toHaveCount(1);
  await expect(panel.getByRole('button')).toHaveText(/Review filter rules/);
});

test('run detail: failed with a stall diagnosis reports "stopped reporting progress" and exactly one Run again action', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 403, status: 'failed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const partialStages: FunnelStage[] = [
    stage('reconcile', 0, 0),
    stage('farm', 0, 2),
    stage('source', 176, 176),
    stage('compress', 176, 176),
  ];
  await mountSingleRun(page, {
    row,
    detail: {
      ...row,
      result: { stages: partialStages },
      failure: {
        stage: 'structure',
        error: 'stage "structure" stalled: no beat() within 360000ms',
        elapsedMs: 360_000,
      },
      syncDryrun: null,
    },
  });

  await page.goto('/#/runs');

  const panel = page.getByTestId('diagnosis-panel');
  await expect(panel.getByTestId('diagnosis-line-1')).toContainText(
    /stopped reporting progress/,
  );
  await expect(panel.getByRole('button', { name: 'Run again' })).toHaveCount(1);

  // Every stage past the failure point (structure onward) never ran. Matches
  // the `sync` row's own exact-text cell, not `reconcile`'s "state-sync"
  // subline, which a loose `hasText: 'sync'` filter also matches.
  const funnel = page.getByTestId('rundetail-funnel-table');
  const syncRow = funnel.locator('tr', {
    has: page.getByRole('cell', { name: 'sync', exact: true }),
  });
  await expect(syncRow).toContainText('not reached');
});

test('run detail: failed with a total-outage diagnosis mentions an expired login or broader outage', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 404, status: 'failed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  await mountSingleRun(page, {
    row,
    detail: {
      ...row,
      result: null,
      failure: {
        stage: 'source',
        error: 'linkedin lane: total outage, not one broken lane',
        elapsedMs: 5000,
      },
      syncDryrun: null,
    },
  });

  await page.goto('/#/runs');

  const panel = page.getByTestId('diagnosis-panel');
  await expect(panel.getByTestId('diagnosis-line-1')).toContainText(
    /expired login|broader outage/,
  );
  await expect(panel.getByRole('button', { name: 'Run again' })).toHaveCount(1);
});

test('run detail: failed with the expired-login diagnosis reports "LinkedIn login has expired." (S5)', async ({
  page,
}) => {
  // Registry matcher (runDiagnosis.ts): `getFailedStage(run.failure) ===
  // 'source' && EXPIRED_LOGIN_PATTERN.test(errorText(run))`, where
  // EXPIRED_LOGIN_PATTERN is /all \d+ attempted url\(s\) failed this run/ —
  // matched against the top-level `failure.error` string alone
  // (evidence.ts:120-125's exact wording). No soft-error row shape feeds
  // this matcher; the per-URL warn events below are included purely for
  // the Evidence section's realism (mirroring mockup S5's "Evidence — 6
  // soft errors"), not because the diagnosis classification needs them.
  const row: RunListRow = {
    ...makeRow({ id: 411, status: 'failed' }),
    softErrors: { total: 6, groups: [], breakerOpen: false },
  };
  await mountSingleRun(page, {
    row,
    detail: {
      ...row,
      result: null,
      failure: {
        stage: 'source',
        error: 'linkedin lane: all 6 attempted url(s) failed this run.',
        elapsedMs: 110_000,
      },
      syncDryrun: null,
    },
    softErrors: {
      total: 6,
      groups: [
        {
          key: 'source·linkedin',
          label: 'source: empty job shell (linkedin)',
          count: 6,
          sample: 'source: empty job shell — url_1 (linkedin)',
        },
      ],
      breakerOpen: false,
    },
    events: [
      'source: empty job shell — url_1 (linkedin)',
      'source: empty job shell — url_2 (linkedin)',
    ],
  });

  await page.goto('/#/runs');

  const panel = page.getByTestId('diagnosis-panel');
  // Implemented copy — verbatim-identical to the mockup's S5/class (i)
  // text ("LinkedIn login has expired."), so no divergence to flag.
  await expect(panel.getByTestId('diagnosis-line-1')).toHaveText(
    'LinkedIn login has expired.',
  );
  await expect(panel.getByRole('button', { name: 'Run again' })).toHaveCount(1);
});

test('run detail: a failure matching BOTH total-outage and expired-login signatures renders total-outage — the registry order the plan pins', async ({
  page,
}) => {
  // The registry checks `total-outage` BEFORE `expired-login` specifically
  // so an overlapping fixture (a `source`-stage failure whose text
  // contains both the total-outage substring and the expired-login regex)
  // never misclassifies as expired-login (runDiagnosis.ts's own doc
  // comment on `TOTAL_OUTAGE_SUBSTRING`). This error string deliberately
  // satisfies both matchers at once to prove that ordering holds.
  const row: RunListRow = {
    ...makeRow({ id: 412, status: 'failed' }),
    softErrors: { total: 6, groups: [], breakerOpen: false },
  };
  await mountSingleRun(page, {
    row,
    detail: {
      ...row,
      result: null,
      failure: {
        stage: 'source',
        error:
          'linkedin lane: total outage, not one broken lane — ' +
          'all 6 attempted url(s) failed this run.',
        elapsedMs: 110_000,
      },
      syncDryrun: null,
    },
  });

  await page.goto('/#/runs');

  const panel = page.getByTestId('diagnosis-panel');
  await expect(panel.getByTestId('diagnosis-line-1')).toHaveText(
    'Every attempted lane in the `source` stage failed this run — ' +
      'this looks like an expired login or a broader outage.',
  );
  await expect(panel.getByTestId('diagnosis-line-1')).not.toHaveText(
    'LinkedIn login has expired.',
  );
});

test('run detail: failed with the breaker-open diagnosis reports the throttle-breaker copy', async ({
  page,
}) => {
  // Registry matcher (runDiagnosis.ts): `softErrors?.breakerOpen ?? false`
  // — a first-class flag, not an error-text substring (fix-round finding
  // #3's own reasoning for why a `sample`-text match was unreliable). The
  // failure text below deliberately avoids the earlier-registry
  // substrings (`stalled: no beat()`, `total outage`) and isn't at the
  // `source` stage, so this can't accidentally match stall/total-outage/
  // expired-login first.
  const row: RunListRow = {
    ...makeRow({ id: 409, status: 'failed' }),
    softErrors: { total: 5, groups: [], breakerOpen: true },
  };
  await mountSingleRun(page, {
    row,
    detail: {
      ...row,
      result: null,
      failure: {
        stage: 'farm',
        error: 'linkedin lane: withheld job shell',
        elapsedMs: 4000,
      },
      syncDryrun: null,
    },
    softErrors: { total: 5, groups: [], breakerOpen: true },
  });

  await page.goto('/#/runs');

  const panel = page.getByTestId('diagnosis-panel');
  // Implemented copy (runDiagnosis.ts) — verbatim-identical to the
  // mockup's class (ii) text ("LinkedIn is soft-blocking us — the
  // throttle breaker is open."), so there's no divergence to flag here.
  await expect(panel.getByTestId('diagnosis-line-1')).toHaveText(
    'LinkedIn is soft-blocking us — the throttle breaker is open.',
  );
  await expect(
    panel.getByRole('button', { name: 'Run again once the throttle breaker reopens' }),
  ).toHaveCount(1);
});

test('run detail: failed with the chrome-not-found diagnosis reports the "no Chrome executable" copy', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 410, status: 'failed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  await mountSingleRun(page, {
    row,
    detail: {
      ...row,
      result: null,
      failure: {
        stage: 'farm',
        // Registry substring (runDiagnosis.ts): 'no Chrome executable found'
        // (launcher.ts's exact wording).
        error: 'no Chrome executable found at any known path (darwin, 4 candidates)',
        elapsedMs: 500,
      },
      syncDryrun: null,
    },
  });

  await page.goto('/#/runs');

  const panel = page.getByTestId('diagnosis-panel');
  // Implemented copy — verbatim-identical to the mockup's class (v) text
  // ("Chrome wasn't found at any known path."), so again no divergence.
  await expect(panel.getByTestId('diagnosis-line-1')).toHaveText(
    "Chrome wasn't found at any known path.",
  );
  await expect(panel.getByRole('button', { name: 'Run `jobbunny doctor`' })).toHaveCount(
    1,
  );
});

test('run detail: failed with an unmatched error falls back to the raw error and last checkpoint, inventing no diagnosis', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 405, status: 'failed' }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  const rawError =
    "TypeError: Cannot read properties of undefined (reading 'choices')\n" +
    '    at StructureStage.run (structure/index.ts:142:18)';
  await mountSingleRun(page, {
    row,
    detail: {
      ...row,
      result: null,
      failure: {
        stage: 'structure',
        error: rawError,
        elapsedMs: 11_000,
        lastCheckpoint: 'compress',
      },
      syncDryrun: null,
    },
  });

  await page.goto('/#/runs');

  const panel = page.getByTestId('diagnosis-panel');
  // No invented diagnosis class — the title is the plain "Failed at
  // `stage`" fallback sentence, not one of the named classes' copy.
  await expect(panel.getByTestId('diagnosis-line-1')).toHaveText('Failed at `structure`');
  await expect(panel.getByTestId('diagnosis-line-1')).not.toContainText(
    /stopped reporting|expired login|outage|Ran clean/,
  );
  await expect(panel.getByTestId('diagnosis-raw-error')).toContainText(
    "Cannot read properties of undefined (reading 'choices')",
  );
  await expect(panel.getByTestId('diagnosis-last-checkpoint')).toContainText('compress');
});

test('run detail: telemetry-missing (unrecorded) short-circuits to the dashed card, with no stage rail or funnel', async ({
  page,
}) => {
  const row: RunListRow = {
    ...makeRow({ id: 406, status: 'crashed', progress: null }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  await mountSingleRun(page, {
    row,
    detail: { ...row, result: null, failure: null, syncDryrun: null },
  });

  await page.goto('/#/runs');

  await expect(page.getByTestId('rundetail-unrecorded-card')).toContainText(
    /telemetry was never written/i,
  );
  await expect(page.getByTestId('rundetail-stage-rail')).toHaveCount(0);
  await expect(page.getByTestId('rundetail-funnel-table')).toHaveCount(0);
});

test('live strip: an alive (fresh-heartbeat) run renders "Alive" — distinct from the stalled/disconnected wording covered elsewhere', async ({
  page,
}) => {
  // The stalled case (old heartbeat while running -> "No heartbeat for
  // Nm") is already covered by runcontrol.spec.ts's stale-heartbeat test;
  // this test supplies the missing "alive" side of R11's stalled ≠
  // disconnected ≠ alive contrast, so the two texts differ across the
  // suite without re-testing the stalled state here.
  const now = new Date().toISOString();
  const row: RunListRow = {
    ...makeRow({
      id: 407,
      status: 'running',
      finishedAt: null,
      heartbeatAt: now,
      startedAt: now,
      progress: {
        stage: 'filter',
        stageIndex: 7,
        stageTotal: 10,
        stageStartedAt: now,
        updatedAt: now,
        itemCurrent: null,
        itemTotal: null,
      },
    }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  await mountSingleRun(page, {
    row,
    detail: { ...row, result: null, failure: null, syncDryrun: null },
  });

  await page.goto('/#/runs');

  await expect(page.getByTestId('live-run-header')).toBeVisible();
  await expect(page.getByTestId('live-run-stage')).toHaveText('Running — filter 7/10');
  await expect(page.getByTestId('live-run-heartbeat')).toContainText('Alive');
  await expect(page.getByTestId('live-run-heartbeat')).not.toContainText(/No heartbeat/);
});

test('live strip: a runs-list poll that starts failing renders the disconnected state, distinct from alive and stalled (R11)', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const row: RunListRow = {
    ...makeRow({
      id: 408,
      status: 'running',
      finishedAt: null,
      heartbeatAt: now,
      startedAt: now,
      progress: {
        stage: 'filter',
        stageIndex: 7,
        stageTotal: 10,
        stageStartedAt: now,
        updatedAt: now,
        itemCurrent: null,
        itemTotal: null,
      },
    }),
    softErrors: { total: 0, groups: [], breakerOpen: false },
  };
  await stubIntents(page, []);
  // The strip must mount off a genuine success first (`RunsPage`'s
  // `runningRow` is only ever true once real data has landed) — every
  // request after the first 500s, driving `runsQuery.isError` true.
  await stubRunsListOnceThenFail(page, [row]);
  await stubRunDetail(page, { ...row, result: null, failure: null, syncDryrun: null });
  await stubSoftErrors(page, row.id, { total: 0, groups: [], breakerOpen: false });
  await stubEvents(page, row.id, []);

  await page.goto('/#/runs');

  // Starts alive off the first (successful) fetch.
  await expect(page.getByTestId('live-run-header')).toBeVisible();
  await expect(page.getByTestId('live-run-heartbeat')).toContainText('Alive', {
    timeout: 10_000,
  });

  // The poll (2.5s while a run is 'running', `RunsPage`'s `LIVE_POLL_MS`)
  // plus its own query-level retry eventually exhausts into
  // `runsQuery.isError`, which `RunsPage` forwards to `LiveRunHeader` as
  // `pollError` — "we cannot tell", outranking the stale-but-cached
  // heartbeat per `livenessFor`'s own doc comment.
  await expect(page.getByTestId('live-run-heartbeat')).toContainText('Disconnected', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('live-run-heartbeat')).not.toContainText('Alive');
  await expect(page.getByTestId('live-run-heartbeat')).not.toContainText(/No heartbeat/);
  await expect(page.getByTestId('live-run-retry')).toBeVisible();
});

test('Run Now sidebar: an unreachable daemon probe renders the amber "can\'t reach the daemon" state for a pending intent', async ({
  page,
}) => {
  await stubDaemonUnreachable(page);
  await stubRunsList(page, []);
  await stubIntents(page, [
    {
      id: 9101,
      requestedAt: new Date().toISOString(),
      status: 'pending',
      claimedRunId: null,
    },
  ]);

  await page.goto('/#/triage');

  const runNow = page.getByTestId('run-now');
  await expect(runNow).toHaveText("Can't reach the daemon — queued anyway", {
    timeout: DAEMON_SETTLE_TIMEOUT_MS,
  });
  await expect(runNow).toHaveClass(/border-amber/);
  // Unlike daemon-down (which gets both a copy button and Keep-queued/
  // Cancel secondary controls), daemon-unknown has neither.
  await expect(page.getByTestId('run-now-copy')).toHaveCount(0);
  await expect(page.getByTestId('run-now-secondary')).toHaveCount(0);
});
