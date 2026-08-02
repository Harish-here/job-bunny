import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardStore } from '../../../ports/board.ts';
import { HttpError } from '../../shared/index.ts';
import { boardService } from './service.ts';

function fakeStore(overrides: Partial<BoardStore> = {}): BoardStore {
  return {
    listJobs: () => ({ rows: [], total: 0 }),
    getJob: () => null,
    updateTracking: () => null,
    close() {},
    ...overrides,
  };
}

test('list: passes the query through to the store and returns its result verbatim', () => {
  const store = fakeStore({ listJobs: () => ({ rows: [], total: 3 }) });
  const result = boardService(store).list({ archived: false });
  assert.deepEqual(result, { rows: [], total: 3 });
});

test('get: throws HttpError(404, not_found) when the store returns null', () => {
  const service = boardService(fakeStore({ getJob: () => null }));
  assert.throws(
    () => service.get('missing'),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
});

test('patchTracking: throws HttpError(404, not_found) when the store returns null', () => {
  const service = boardService(fakeStore({ updateTracking: () => null }));
  assert.throws(
    () =>
      service.patchTracking('missing', { status: 'Applied' }, '2026-08-02T00:00:00.000Z'),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
});
