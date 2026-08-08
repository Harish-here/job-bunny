import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INTENT_EXPIRY_MS } from '../../../../ports/run_intents.ts';
import { openJobsDb } from '../store/index.ts';
import { deriveIntentStatus, SqliteRunIntentStore } from './store.ts';

// Real temp-file DB paths, not the literal ':memory:' string: ':memory:'
// gives each `DatabaseSync` connection its own PRIVATE database (no shared
// cache), so a test that opens a SECOND raw connection to assert against
// what the store already wrote (behind-the-back insert, row-count checks)
// would see an empty db, not the store's data. A real file is what every
// sibling adapter test in this family (checkpoints/, state/) already uses
// for exactly this reason.
const dirs: string[] = [];
const stores: SqliteRunIntentStore[] = [];

function freshDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-intentstore-'));
  dirs.push(dir);
  return path.join(dir, 'jobbunny.db');
}

function makeStore(dbPath: string): SqliteRunIntentStore {
  const store = new SqliteRunIntentStore(dbPath);
  stores.push(store);
  return store;
}

/** Seeds a real `runs` row and returns its id — `claimed_run_id` is a
 * real FK against `runs(id)` (`PRAGMA foreign_keys = ON`), so any test
 * exercising `attachRun` needs an actual row to point at. */
function seedRunRow(dbPath: string): number {
  const db = openJobsDb(dbPath);
  const result = db
    .prepare(
      `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
       VALUES ('2026-08-06', '10-00', 'run', 'running', '2026-08-06T10:00:00.000Z')`,
    )
    .run();
  db.close();
  return Number(result.lastInsertRowid);
}

after(() => {
  for (const store of stores) store.close();
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('deriveIntentStatus: a fresh pending row stays pending', () => {
  const requestedAt = '2026-08-06T10:00:00.000Z';
  const now = '2026-08-06T10:05:00.000Z';
  assert.equal(deriveIntentStatus('pending', requestedAt, now), 'pending');
});

test('deriveIntentStatus: a pending row older than 10 minutes reads expired', () => {
  const requestedAt = '2026-08-06T10:00:00.000Z';
  const now = new Date(Date.parse(requestedAt) + INTENT_EXPIRY_MS + 1).toISOString();
  assert.equal(deriveIntentStatus('pending', requestedAt, now), 'expired');
});

test('deriveIntentStatus: claimed and cancelled are returned unchanged even when old', () => {
  const requestedAt = '2026-08-06T10:00:00.000Z';
  const now = new Date(Date.parse(requestedAt) + INTENT_EXPIRY_MS + 60_000).toISOString();
  assert.equal(deriveIntentStatus('claimed', requestedAt, now), 'claimed');
  assert.equal(deriveIntentStatus('cancelled', requestedAt, now), 'cancelled');
});

test('deriveIntentStatus: an unparseable requestedAt fails open to pending', () => {
  assert.equal(
    deriveIntentStatus('pending', 'not-a-date', '2026-08-06T10:00:00.000Z'),
    'pending',
  );
});

test('request: inserts a pending intent and reports deduped false', () => {
  const store = makeStore(freshDbPath());
  const now = '2026-08-06T10:00:00.000Z';
  const { intent, deduped } = store.request(now);
  assert.equal(deduped, false);
  assert.equal(intent.status, 'pending');
  assert.equal(intent.requestedAt, now);
  assert.equal(intent.claimedRunId, null);
  assert.equal(typeof intent.id, 'number');
});

test('request: a second request while one is pending returns the same row with deduped true and inserts nothing', () => {
  const dbPath = freshDbPath();
  const store = makeStore(dbPath);
  const first = store.request('2026-08-06T10:00:00.000Z');
  const second = store.request('2026-08-06T10:01:00.000Z');
  assert.equal(second.deduped, true);
  assert.equal(second.intent.id, first.intent.id);

  const raw = openJobsDb(dbPath);
  const { c } = raw.prepare('SELECT COUNT(*) AS c FROM run_intents').get() as {
    c: number;
  };
  assert.equal(c, 1);
  raw.close();
});

test('request: an expired pending intent is cancelled and a fresh one inserted', () => {
  const dbPath = freshDbPath();
  const store = makeStore(dbPath);
  const t0 = '2026-08-06T10:00:00.000Z';
  const first = store.request(t0);
  const tExpired = new Date(Date.parse(t0) + INTENT_EXPIRY_MS + 60_000).toISOString();
  const second = store.request(tExpired);

  assert.equal(second.deduped, false);
  assert.notEqual(second.intent.id, first.intent.id);
  assert.equal(second.intent.status, 'pending');

  const raw = openJobsDb(dbPath);
  const oldRow = raw
    .prepare('SELECT status FROM run_intents WHERE id = ?')
    .get(first.intent.id) as { status: string };
  assert.equal(oldRow.status, 'cancelled');
  raw.close();
});

test("the partial unique index rejects a second pending row inserted behind the store's back", () => {
  const dbPath = freshDbPath();
  const store = makeStore(dbPath);
  store.request('2026-08-06T10:00:00.000Z');

  const raw = openJobsDb(dbPath);
  assert.throws(() => {
    raw
      .prepare(
        `INSERT INTO run_intents (requested_at, status, claimed_run_id) VALUES (?, 'pending', NULL)`,
      )
      .run('2026-08-06T10:05:00.000Z');
  });
  raw.close();
});

test('cancel: a pending intent cancels and comes back as cancelled', () => {
  const store = makeStore(freshDbPath());
  const t0 = '2026-08-06T10:00:00.000Z';
  const { intent } = store.request(t0);
  const result = store.cancel(intent.id, t0);
  assert.deepEqual(result, {
    outcome: 'cancelled',
    intent: { ...intent, status: 'cancelled' },
  });
});

test('cancel: an unknown id is not_found; an already-claimed intent is not_pending', () => {
  const store = makeStore(freshDbPath());
  const t0 = '2026-08-06T10:00:00.000Z';
  assert.deepEqual(store.cancel(999, t0), { outcome: 'not_found' });

  const { intent } = store.request(t0);
  assert.equal(store.claim(intent.id), true);
  assert.deepEqual(store.cancel(intent.id, t0), { outcome: 'not_pending' });
});

test('claim: flips pending to claimed once and returns false the second time', () => {
  const store = makeStore(freshDbPath());
  const { intent } = store.request('2026-08-06T10:00:00.000Z');
  assert.equal(store.claim(intent.id), true);
  assert.equal(store.claim(intent.id), false);
});

test('listClaimable / latest / attachRun', () => {
  const dbPath = freshDbPath();
  const store = makeStore(dbPath);
  const t0 = '2026-08-06T10:00:00.000Z';
  const { intent } = store.request(t0);

  const fresh = store.listClaimable(t0);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.id, intent.id);

  const tExpired = new Date(Date.parse(t0) + INTENT_EXPIRY_MS + 60_000).toISOString();
  assert.equal(store.listClaimable(tExpired).length, 0);

  assert.equal(store.latest(t0)?.status, 'pending');
  assert.equal(store.latest(tExpired)?.status, 'expired');

  const runId = seedRunRow(dbPath);
  assert.equal(store.claim(intent.id), true);
  store.attachRun(intent.id, runId);
  assert.equal(store.latest(t0)?.claimedRunId, runId);

  // attachRun is a no-op on a row that is not 'claimed'.
  const { intent: pendingAgain } = store.request(t0);
  store.attachRun(pendingAgain.id, runId);
  assert.equal(store.latest(t0)?.claimedRunId, null);
});

test('list: returns rows newest-first capped at limit, with a stale pending row read back as expired', () => {
  const store = makeStore(freshDbPath());
  const t0 = '2026-08-06T10:00:00.000Z';

  const r1 = store.request(t0);
  const cancelled = store.cancel(r1.intent.id, t0);
  assert.equal(cancelled.outcome, 'cancelled');
  const r2 = store.request(t0);
  assert.equal(r2.deduped, false);

  const list1 = store.list(t0, 5);
  assert.deepEqual(
    list1.map((i) => i.id),
    [r2.intent.id, r1.intent.id],
  );
  assert.equal(list1[0]?.status, 'pending');

  const tLater = new Date(Date.parse(t0) + INTENT_EXPIRY_MS + 60_000).toISOString();
  const list2 = store.list(tLater, 1);
  assert.deepEqual(
    list2.map((i) => i.id),
    [r2.intent.id],
  );
  assert.equal(list2[0]?.status, 'expired');

  const list3 = store.list(tLater, 5);
  const id1Row = list3.find((i) => i.id === r1.intent.id);
  assert.equal(id1Row?.status, 'cancelled');
});
