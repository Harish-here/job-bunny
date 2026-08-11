import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SqliteRunStore } from '../runs/index.ts';
import { openJobsDb } from '../store/index.ts';
import { fetchRunHealth } from './runs_read.ts';

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
