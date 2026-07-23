import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CacheEntry, JD } from '../../core/jd/index.ts';
import type { Storage } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { dedupStage } from './dedup.ts';
import { CACHE_PATH } from './reconcile.ts';

function fakeStorage(): Storage & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async readJson<T>(relPath: string, schema: { parse(v: unknown): T }) {
      if (!store.has(relPath)) return undefined;
      return schema.parse(store.get(relPath));
    },
    async writeJson(relPath: string, value: unknown) {
      store.set(relPath, value);
    },
  };
}

function fakeCtx(storage: ReturnType<typeof fakeStorage>): StageContext {
  return {
    profile: 'rajni',
    signal: AbortSignal.timeout(30_000),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage,
  };
}

function fakeJob(
  id: string,
  overrides?: Partial<{ title: string; company: string }>,
): JD {
  return {
    identity: {
      id,
      lane: 'linkedin',
      url: `https://example.com/jobs/${id}`,
      company: overrides?.company ?? 'Acme Corp',
      title: overrides?.title ?? 'Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
  };
}

test('dedupStage: name/timeout/retries', () => {
  assert.equal(dedupStage.name, 'dedup');
  assert.equal(dedupStage.retries, 0);
  assert.ok(dedupStage.timeoutMs > 0);
});

test('drops a job whose id matches a cache entry, keeps the rest', async () => {
  const storage = fakeStorage();
  const cache: CacheEntry[] = [
    { id: 'li-1', company: 'Acme Corp', title: 'Frontend Engineer', pageId: 'p1' },
  ];
  storage.store.set(CACHE_PATH, cache);
  const ctx = fakeCtx(storage);

  const input: StagePayload = {
    jobs: [
      fakeJob('li-1'),
      fakeJob('li-2', { title: 'Backend Engineer', company: 'Other Co' }),
    ],
    dropped: [],
  };
  const out = await dedupStage.run(input, ctx);

  assert.deepEqual(
    out.jobs.map((j) => j.identity.id),
    ['li-2'],
  );
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0]?.reasons[0]?.rule, 'dedup.id');
  // prior drops from earlier stages are preserved
  assert.equal(out.dropped[0]?.jd.identity.id, 'li-1');
});

test('empty cache: no jobs dropped by dedup, all kept', async () => {
  const storage = fakeStorage();
  storage.store.set(CACHE_PATH, []);
  const ctx = fakeCtx(storage);

  const input: StagePayload = {
    jobs: [
      fakeJob('li-1'),
      fakeJob('li-2', { title: 'Backend Engineer', company: 'Other Co' }),
    ],
    dropped: [],
  };
  const out = await dedupStage.run(input, ctx);

  assert.equal(out.jobs.length, 2);
  assert.equal(out.dropped.length, 0);
});

test('preserves dropped records already on the payload from earlier stages', async () => {
  const storage = fakeStorage();
  storage.store.set(CACHE_PATH, []);
  const ctx = fakeCtx(storage);

  const priorDrop = { jd: fakeJob('li-0'), reasons: [] };
  const input: StagePayload = { jobs: [fakeJob('li-1')], dropped: [priorDrop] };
  const out = await dedupStage.run(input, ctx);

  assert.deepEqual(out.dropped, [priorDrop]);
});

test('fails loud when the cache file is missing (dedup run before reconcile)', async () => {
  const storage = fakeStorage();
  const ctx = fakeCtx(storage);

  const input: StagePayload = { jobs: [fakeJob('li-1')], dropped: [] };
  await assert.rejects(() => dedupStage.run(input, ctx), /no cache found/);
});
