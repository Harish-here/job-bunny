import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CACHE_ENTRIES_PATH, loadCacheIds } from './cache_gate.ts';
import { FakeStateStore } from './testkit/browser_fakes.ts';
import { fakeCtx } from './testkit/fixtures.ts';

test('cache absent: gate disabled, returns an empty set, no throw', async () => {
  const stateStore = new FakeStateStore();
  const ids = await loadCacheIds(stateStore, fakeCtx());
  assert.deepEqual(ids, new Set());
});

test('cache present: returns the set of every non-empty entry id', async () => {
  const stateStore = new FakeStateStore();
  stateStore.set(CACHE_ENTRIES_PATH, [
    { id: 'li-1', company: 'Acme', title: 'Eng', pageId: 'p1' },
    { id: 'li-2', company: 'Acme', title: 'Eng', pageId: 'p2' },
  ]);
  const ids = await loadCacheIds(stateStore, fakeCtx());
  assert.deepEqual(ids, new Set(['li-1', 'li-2']));
});

test('a stateStore.readDoc rejection is fail-soft: cache gate disabled, returns an empty set', async () => {
  const throwingStateStore = {
    readDoc: async () => {
      throw new Error('boom');
    },
    writeDoc: async () => {},
    close: () => {},
  };
  const ids = await loadCacheIds(throwingStateStore, fakeCtx());
  assert.deepEqual(ids, new Set());
});
