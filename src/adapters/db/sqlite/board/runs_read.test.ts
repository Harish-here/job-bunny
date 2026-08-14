import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunKind } from '../../../../ports/run_store.ts';
import { SqliteRunStore } from '../runs/index.ts';
import { openJobsDb } from '../store/index.ts';
import { estimateRunDurationQuery, fetchRunHealth } from './runs_read.ts';

/** A real temp-file DB (not `:memory:`) — the writer (`SqliteRunStore`) and
 * the reader under test (`fetchRunHealth`) are two independent
 * `DatabaseSync` connections onto the same file, the same shape
 * `board.test.ts`'s `freshRunsFixture` already uses for the rest of this
 * module. */
function freshFixture(): { dbPath: string; runStore: SqliteRunStore } {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-runs-health-'));
  const dbPath = path.join(dir, 'jobbunny.db');
  return { dbPath, runStore: new SqliteRunStore(dbPath) };
}

test('fetchRunHealth: empty runIds short-circuits to an empty map without querying', () => {
  const { dbPath } = freshFixture();
  const db = openJobsDb(dbPath);
  assert.deepEqual(fetchRunHealth(db, []), new Map());
});

test('fetchRunHealth: counts warn+error rows per run, excludes info, one batched query for multiple ids', () => {
  const { dbPath, runStore } = freshFixture();
  const runA = runStore.startRun({
    date: '2026-08-10',
    kind: 'run',
    startedAt: '2026-08-10T09:00:00.000Z',
  });
  const runB = runStore.startRun({
    date: '2026-08-10',
    kind: 'run',
    startedAt: '2026-08-10T10:00:00.000Z',
  });
  runStore.appendEvents(runA, [
    { ts: '2026-08-10T09:00:01.000Z', level: 'info', msg: 'stage started' },
    { ts: '2026-08-10T09:00:02.000Z', level: 'warn', msg: 'linkedin lane: url failed' },
    { ts: '2026-08-10T09:00:03.000Z', level: 'error', msg: 'board fetch failed' },
  ]);
  runStore.appendEvents(runB, [
    { ts: '2026-08-10T10:00:01.000Z', level: 'warn', msg: 'harvest: harvested 0 cards' },
  ]);
  runStore.close();

  const db = openJobsDb(dbPath);
  const health = fetchRunHealth(db, [runA, runB]);
  assert.deepEqual(health.get(runA), { total: 2, breakerOpen: false });
  assert.deepEqual(health.get(runB), { total: 1, breakerOpen: false });
});

test('fetchRunHealth: an id with zero warn/error events is absent from the map', () => {
  const { dbPath, runStore } = freshFixture();
  const runId = runStore.startRun({
    date: '2026-08-10',
    kind: 'run',
    startedAt: '2026-08-10T09:00:00.000Z',
  });
  runStore.appendEvents(runId, [
    { ts: '2026-08-10T09:00:01.000Z', level: 'info', msg: 'stage started' },
  ]);
  runStore.close();

  const db = openJobsDb(dbPath);
  const health = fetchRunHealth(db, [runId]);
  assert.equal(health.has(runId), false);
});

test('fetchRunHealth: breakerOpen is true when any of the three throttle-breaker warn messages is present, even scoped alongside unrelated farm warns (real ScopedLogger shape)', () => {
  const { dbPath, runStore } = freshFixture();
  const runId = runStore.startRun({
    date: '2026-08-10',
    kind: 'run',
    startedAt: '2026-08-10T09:00:00.000Z',
  });
  // Real order: several farm-scoped warns arrive BEFORE the breaker-open
  // warn — the same `scope: 'farm'` shape `withScope(ctx.logger, 'farm')`
  // produces (pipeline/runner/run.ts), which is exactly what made the old
  // group.sample-substring detector unreliable (fix-round finding #3).
  runStore.appendEvents(runId, [
    {
      ts: '2026-08-10T09:00:01.000Z',
      level: 'warn',
      msg: 'linkedin lane: page identity loss',
      data: { scope: 'farm' },
    },
    {
      ts: '2026-08-10T09:00:02.000Z',
      level: 'warn',
      msg: 'linkedin lane: throttle breaker is open — skipping this fire without launching a browser',
      data: { scope: 'farm', reopenAt: '2026-08-10T10:00:00.000Z', tripCount: 1 },
    },
  ]);
  runStore.close();

  const db = openJobsDb(dbPath);
  const health = fetchRunHealth(db, [runId]);
  assert.deepEqual(health.get(runId), { total: 2, breakerOpen: true });
});

for (const [label, msg] of [
  [
    'trip',
    'linkedin lane: 3 consecutive server-withheld JD shells — the session is throttled; opening the breaker and stopping this fire, keeping every capture so far',
  ],
  [
    'probe re-open',
    'linkedin lane: half-open probe still got a server-withheld shell — breaker re-opened, ending this fire',
  ],
] as const) {
  test(`fetchRunHealth: breakerOpen detects the ${label} message too`, () => {
    const { dbPath, runStore } = freshFixture();
    const runId = runStore.startRun({
      date: '2026-08-10',
      kind: 'run',
      startedAt: '2026-08-10T09:00:00.000Z',
    });
    runStore.appendEvents(runId, [
      { ts: '2026-08-10T09:00:01.000Z', level: 'warn', msg, data: { scope: 'farm' } },
    ]);
    runStore.close();

    const db = openJobsDb(dbPath);
    const health = fetchRunHealth(db, [runId]);
    assert.equal(health.get(runId)?.breakerOpen, true);
  });
}

// --- estimateRunDurationQuery (blueprint step 1.18) ---

/** One `runs` row, optionally finished and optionally carrying
 * `harvested`/`alreadyDone` `run_events` — the two counts the eligibility
 * discriminator (`already_done <= harvested`) reads. `status: 'running'`
 * skips `finishRun` entirely (no `finished_at`, matching production: a
 * still-running row is never eligible). */
function makeRun(
  runStore: SqliteRunStore,
  opts: {
    startedAt: string;
    finishedAt?: string;
    kind?: RunKind;
    resumedFrom?: number;
    status?: 'passed' | 'failed' | 'running';
    harvested?: number;
    alreadyDone?: number;
  },
): number {
  const runId = runStore.startRun({
    date: opts.startedAt.slice(0, 10),
    kind: opts.kind ?? 'run',
    ...(opts.resumedFrom !== undefined ? { resumedFrom: opts.resumedFrom } : {}),
    startedAt: opts.startedAt,
  });
  const events = [
    ...Array.from({ length: opts.harvested ?? 0 }, (_, i) => ({
      ts: opts.startedAt,
      level: 'info',
      msg: `linkedin lane: page harvested (${i})`,
    })),
    ...Array.from({ length: opts.alreadyDone ?? 0 }, (_, i) => ({
      ts: opts.startedAt,
      level: 'info',
      msg: `linkedin lane: skipping already-done url (${i})`,
    })),
  ];
  if (events.length > 0) runStore.appendEvents(runId, events);
  if (opts.status !== 'running' && opts.finishedAt !== undefined) {
    runStore.finishRun(
      runId,
      opts.status === 'failed' ? 'failed' : 'passed',
      {},
      opts.finishedAt,
    );
  }
  return runId;
}

function freshDurationFixture(): { dbPath: string; runStore: SqliteRunStore } {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-runs-duration-'));
  const dbPath = path.join(dir, 'jobbunny.db');
  return { dbPath, runStore: new SqliteRunStore(dbPath) };
}

test('estimateRunDurationQuery: fewer than 3 eligible rows returns null', () => {
  const { dbPath, runStore } = freshDurationFixture();
  makeRun(runStore, {
    startedAt: '2026-08-10T09:00:00.000Z',
    finishedAt: '2026-08-10T09:30:00.000Z',
    harvested: 80,
  });
  makeRun(runStore, {
    startedAt: '2026-08-11T09:00:00.000Z',
    finishedAt: '2026-08-11T09:30:00.000Z',
    harvested: 80,
  });
  runStore.close();

  const db = openJobsDb(dbPath);
  assert.equal(estimateRunDurationQuery(db), null);
});

test('estimateRunDurationQuery: a mix of ineligible rows (stage kind, resumed, failed) alongside eligible ones only counts the eligible ones', () => {
  const { dbPath, runStore } = freshDurationFixture();
  // Eligible: 3 passed, kind 'run', not resumed, 30 min each.
  const eligible = [
    '2026-08-10T09:00:00.000Z',
    '2026-08-11T09:00:00.000Z',
    '2026-08-12T09:00:00.000Z',
  ];
  for (const startedAt of eligible) {
    makeRun(runStore, {
      startedAt,
      finishedAt: new Date(Date.parse(startedAt) + 30 * 60_000).toISOString(),
      harvested: 80,
    });
  }
  // Ineligible: wrong kind.
  makeRun(runStore, {
    startedAt: '2026-08-09T09:00:00.000Z',
    finishedAt: '2026-08-09T09:05:00.000Z',
    kind: 'stage',
    harvested: 80,
  });
  // Ineligible: resumed (the "base" row it resumes from is itself given a
  // non-'run' kind so it doesn't sneak in as a 4th eligible row while still
  // satisfying the `resumed_from` foreign key).
  const base = makeRun(runStore, {
    startedAt: '2026-08-08T09:00:00.000Z',
    finishedAt: '2026-08-08T09:05:00.000Z',
    kind: 'stage',
    harvested: 80,
  });
  makeRun(runStore, {
    startedAt: '2026-08-08T10:00:00.000Z',
    finishedAt: '2026-08-08T10:05:00.000Z',
    resumedFrom: base,
    harvested: 80,
  });
  // Ineligible: failed.
  makeRun(runStore, {
    startedAt: '2026-08-07T09:00:00.000Z',
    finishedAt: '2026-08-07T09:05:00.000Z',
    status: 'failed',
    harvested: 80,
  });
  // Ineligible: still running (no finished_at).
  makeRun(runStore, { startedAt: '2026-08-13T09:00:00.000Z', status: 'running' });
  runStore.close();

  const db = openJobsDb(dbPath);
  const estimate = estimateRunDurationQuery(db);
  assert.deepEqual(estimate, { medianMs: 30 * 60_000, sampleSize: 3 });
});

test('estimateRunDurationQuery: a passed, kind-run, not-resumed run with MORE already-done skips than harvests is excluded (the real discriminator)', () => {
  const { dbPath, runStore } = freshDurationFixture();
  for (const startedAt of [
    '2026-08-10T09:00:00.000Z',
    '2026-08-11T09:00:00.000Z',
    '2026-08-12T09:00:00.000Z',
  ]) {
    makeRun(runStore, {
      startedAt,
      finishedAt: new Date(Date.parse(startedAt) + 30 * 60_000).toISOString(),
      harvested: 80,
    });
  }
  // Same-day re-fire: 20 already-done skips, only 2 fresh harvests.
  makeRun(runStore, {
    startedAt: '2026-08-13T09:00:00.000Z',
    finishedAt: '2026-08-13T09:03:00.000Z',
    harvested: 2,
    alreadyDone: 20,
  });
  runStore.close();

  const db = openJobsDb(dbPath);
  const estimate = estimateRunDurationQuery(db);
  assert.deepEqual(estimate, { medianMs: 30 * 60_000, sampleSize: 3 });
});

test('estimateRunDurationQuery: a run with ZERO matching run_events of either kind stays eligible (0 <= 0)', () => {
  const { dbPath, runStore } = freshDurationFixture();
  for (const startedAt of [
    '2026-08-10T09:00:00.000Z',
    '2026-08-11T09:00:00.000Z',
    '2026-08-12T09:00:00.000Z',
  ]) {
    makeRun(runStore, {
      startedAt,
      finishedAt: new Date(Date.parse(startedAt) + 30 * 60_000).toISOString(),
      // no events at all — LEFT JOIN group with no matching rows.
    });
  }
  runStore.close();

  const db = openJobsDb(dbPath);
  const estimate = estimateRunDurationQuery(db);
  assert.deepEqual(estimate, { medianMs: 30 * 60_000, sampleSize: 3 });
});

test('estimateRunDurationQuery: an even-count eligible sample computes the true two-value-average median, not the mean of the full set', () => {
  const { dbPath, runStore } = freshDurationFixture();
  // Durations (minutes): 10, 20, 30, 90 -> ascending median = (20+30)/2 = 25 min.
  // Mean would be 37.5 min — different, proving this isn't the mean.
  const minutes = [10, 20, 30, 90];
  minutes.forEach((mins, i) => {
    const startedAt = `2026-08-${String(10 + i).padStart(2, '0')}T09:00:00.000Z`;
    makeRun(runStore, {
      startedAt,
      finishedAt: new Date(Date.parse(startedAt) + mins * 60_000).toISOString(),
      harvested: 80,
    });
  });
  runStore.close();

  const db = openJobsDb(dbPath);
  const estimate = estimateRunDurationQuery(db);
  assert.deepEqual(estimate, { medianMs: 25 * 60_000, sampleSize: 4 });
});

test('estimateRunDurationQuery: exactly 10 eligible rows present -> sampleSize 10; an 11th OLDER eligible row is excluded (LIMIT 10 ORDER BY started_at DESC)', () => {
  const { dbPath, runStore } = freshDurationFixture();
  // 11 eligible runs, one per day, each 20 minutes, oldest first.
  for (let day = 1; day <= 11; day++) {
    const startedAt = `2026-08-${String(day).padStart(2, '0')}T09:00:00.000Z`;
    makeRun(runStore, {
      startedAt,
      finishedAt: new Date(Date.parse(startedAt) + 20 * 60_000).toISOString(),
      harvested: 80,
    });
  }
  runStore.close();

  const db = openJobsDb(dbPath);
  const estimate = estimateRunDurationQuery(db);
  // All 11 are the same 20-minute duration, so the median is unaffected by
  // which 10 are kept — sampleSize alone proves the LIMIT 10 took effect.
  assert.deepEqual(estimate, { medianMs: 20 * 60_000, sampleSize: 10 });
});

test("estimateRunDurationQuery: the blueprint's own verified real-data shape — 4 short-circuited same-day-resume runs (1-3 min) alongside 10+ genuine full-scrape runs (28-46 min) — excludes exactly the short-circuited ones", () => {
  const { dbPath, runStore } = freshDurationFixture();
  // 4 short-circuited runs: 20 already-done skips against 2-6 harvests each.
  const shortRuns = [
    { startedAt: '2026-08-01T09:00:00.000Z', mins: 1, harvested: 2 },
    { startedAt: '2026-08-02T09:00:00.000Z', mins: 2, harvested: 4 },
    { startedAt: '2026-08-03T09:00:00.000Z', mins: 2, harvested: 6 },
    { startedAt: '2026-08-04T09:00:00.000Z', mins: 3, harvested: 3 },
  ];
  for (const r of shortRuns) {
    makeRun(runStore, {
      startedAt: r.startedAt,
      finishedAt: new Date(Date.parse(r.startedAt) + r.mins * 60_000).toISOString(),
      harvested: r.harvested,
      alreadyDone: 20,
    });
  }
  // 10 genuine full-scrape runs: 0-6 already-done skips against 78-93
  // harvests each, durations 28.2-45.9 minutes.
  const genuineMinutes = [28.2, 30, 31, 33, 35, 36.5, 38, 40, 42, 45.9];
  const genuineStarts = genuineMinutes.map(
    (_, i) => `2026-08-${String(10 + i).padStart(2, '0')}T09:00:00.000Z`,
  );
  genuineMinutes.forEach((mins, i) => {
    const startedAt = genuineStarts[i] as string;
    makeRun(runStore, {
      startedAt,
      finishedAt: new Date(Date.parse(startedAt) + mins * 60_000).toISOString(),
      harvested: 78 + i,
      alreadyDone: i % 6,
    });
  });
  runStore.close();

  const db = openJobsDb(dbPath);
  const estimate = estimateRunDurationQuery(db);
  assert.ok(estimate);
  assert.equal(estimate.sampleSize, 10);
  // Median of the 10 most recent (all genuine, DESC by started_at) —
  // sorted ascending: 28.2 30 31 33 35 36.5 38 40 42 45.9 -> two middle
  // values 35 and 36.5, average 35.75 min.
  assert.equal(estimate.medianMs, 35.75 * 60_000);
});
