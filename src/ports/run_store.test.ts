import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  RunDetail,
  RunEventRow,
  RunFailure,
  RunKind,
  RunStore,
  RunSummary,
} from './run_store.ts';

/** Minimal in-memory fake — proves the port's widened shapes (the
 * `'catchup'` `RunKind` member, `catchupSlots` on `RunSummary`/`RunDetail`,
 * the `startRun` meta field, and the new `hasRunOfKind` reader method)
 * typecheck and are usable against a real implementer, the same style
 * `deferred_slots.test.ts` used for its own port. The real SQL body for
 * `hasRunOfKind` (and `catchupSlots` persistence) is a later task's adapter
 * work — this fake exists only to exercise the port's shape. */
function fakeStore(): RunStore {
  const rows = new Map<number, RunSummary & { result: unknown; failure: unknown }>();
  const events = new Map<number, RunEventRow[]>();
  let nextId = 1;

  return {
    startRun(meta) {
      const id = nextId++;
      rows.set(id, {
        id,
        date: meta.date,
        timeDir: meta.timeDir ?? null,
        kind: meta.kind,
        resumedFrom: meta.resumedFrom ?? null,
        status: 'running',
        startedAt: meta.startedAt,
        finishedAt: null,
        heartbeatAt: null,
        progress: null,
        catchupSlots: meta.catchupSlots ?? null,
        result: null,
        failure: null,
      });
      events.set(id, []);
      return id;
    },
    appendEvents(runId, evts) {
      events.get(runId)?.push(...evts);
    },
    heartbeat(runId, at) {
      const row = rows.get(runId);
      if (row) row.heartbeatAt = at;
    },
    recordProgress() {},
    recordFailure(runId, failure: RunFailure) {
      const row = rows.get(runId);
      if (row) row.failure = failure;
    },
    recordSyncDryrun() {},
    finishRun(runId, outcome, result, finishedAt) {
      const row = rows.get(runId);
      if (row) {
        row.status = outcome;
        row.result = result;
        row.finishedAt = finishedAt;
      }
    },
    listRuns() {
      return [...rows.values()];
    },
    getRun(id): RunDetail | null {
      const row = rows.get(id);
      if (!row) return null;
      return { ...row, syncDryrun: null };
    },
    listEvents(runId) {
      return events.get(runId) ?? [];
    },
    findRunId(date, timeDir) {
      for (const row of rows.values()) {
        if (row.date === date && row.timeDir === timeDir) return row.id;
      }
      return null;
    },
    listRunTimeDirs(date) {
      const dirs = new Set<string>();
      for (const row of rows.values()) {
        if (row.date === date && row.timeDir !== null) dirs.add(row.timeDir);
      }
      return [...dirs];
    },
    pruneRunsOlderThan(today, ttlDays) {
      let deleted = 0;
      for (const [id, row] of rows) {
        if (row.date < today && ttlDays >= 0) {
          rows.delete(id);
          events.delete(id);
          deleted++;
        }
      }
      return deleted;
    },
    hasRunOfKind(date: string, kind: RunKind) {
      for (const row of rows.values()) {
        if (row.date === date && row.kind === kind) return true;
      }
      return false;
    },
    close() {},
  };
}

test('startRun accepts a catchup kind and optional catchupSlots, surfaced on the summary', () => {
  const store = fakeStore();
  const id = store.startRun({
    date: '2026-08-13',
    kind: 'catchup',
    startedAt: '2026-08-13T09:31:00.000Z',
    catchupSlots: ['09:00', '14:00'],
  });
  const [summary] = store.listRuns();
  assert.equal(summary?.id, id);
  assert.equal(summary?.kind, 'catchup');
  assert.deepEqual(summary?.catchupSlots, ['09:00', '14:00']);
});

test('catchupSlots defaults to null when omitted', () => {
  const store = fakeStore();
  store.startRun({
    date: '2026-08-13',
    kind: 'run',
    startedAt: '2026-08-13T09:31:00.000Z',
  });
  assert.equal(store.listRuns()[0]?.catchupSlots, null);
});

test('getRun inherits catchupSlots onto RunDetail without redeclaring it', () => {
  const store = fakeStore();
  const id = store.startRun({
    date: '2026-08-13',
    kind: 'catchup',
    startedAt: '2026-08-13T09:31:00.000Z',
    catchupSlots: ['09:00'],
  });
  const detail = store.getRun(id);
  assert.deepEqual(detail?.catchupSlots, ['09:00']);
});

test('hasRunOfKind is true only for a matching (date, kind) pair', () => {
  const store = fakeStore();
  store.startRun({
    date: '2026-08-13',
    kind: 'catchup',
    startedAt: '2026-08-13T09:31:00.000Z',
  });
  assert.equal(store.hasRunOfKind('2026-08-13', 'catchup'), true);
  assert.equal(store.hasRunOfKind('2026-08-13', 'run'), false);
  assert.equal(store.hasRunOfKind('2026-08-12', 'catchup'), false);
});

test('every RunKind member is assignable to startRun.meta.kind', () => {
  const store = fakeStore();
  const kinds: RunKind[] = ['run', 'stage', 'reconcile', 'catchup'];
  for (const kind of kinds) {
    store.startRun({ date: '2026-08-13', kind, startedAt: '2026-08-13T09:31:00.000Z' });
  }
  assert.equal(store.listRuns().length, kinds.length);
});
