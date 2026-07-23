import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CacheEntry, JD, SyncedJD } from '../../core/jd/index.ts';
import type { ArchivePolicy, Connector, RunContext, Storage } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { CACHE_PATH, makeReconcileStage } from './reconcile.ts';

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

function fakeConnector(
  overrides?: Partial<Connector>,
): Connector & { rebuildCalls: number } {
  let rebuildCalls = 0;
  return {
    name: 'fake',
    get rebuildCalls() {
      return rebuildCalls;
    },
    async rebuildCache(_ctx: RunContext): Promise<CacheEntry[]> {
      rebuildCalls += 1;
      return [{ id: 'li-1', company: 'Acme', title: 'Engineer', pageId: 'page-1' }];
    },
    async syncJobs(jobs: JD[]): Promise<SyncedJD[]> {
      return jobs.map((jd) => ({ ...jd, sync: { pageId: 'x', syncedAt: 'now' } }));
    },
    async archiveStale(_policy: ArchivePolicy): Promise<number> {
      return 0;
    },
    ...overrides,
  };
}

test('makeReconcileStage: stage name/timeout/retries', () => {
  const stage = makeReconcileStage(fakeConnector());
  assert.equal(stage.name, 'reconcile');
  assert.equal(stage.retries, 0);
  assert.ok(stage.timeoutMs > 0);
});

test('writes the rebuilt cache to CACHE_PATH and threads the payload through unchanged', async () => {
  const storage = fakeStorage();
  const ctx = fakeCtx(storage);
  const connector = fakeConnector();
  const stage = makeReconcileStage(connector);
  const input: StagePayload = { jobs: [], dropped: [] };

  const out = await stage.run(input, ctx);

  assert.equal(out, input);
  assert.equal(connector.rebuildCalls, 1);
  assert.deepEqual(storage.store.get(CACHE_PATH), [
    { id: 'li-1', company: 'Acme', title: 'Engineer', pageId: 'page-1' },
  ]);
});

test('a connector failure fails the stage loudly (read-only on Notion — never swallowed)', async () => {
  const storage = fakeStorage();
  const ctx = fakeCtx(storage);
  const connector = fakeConnector({
    async rebuildCache() {
      throw new Error('notion outage');
    },
  });
  const stage = makeReconcileStage(connector);

  await assert.rejects(() => stage.run({ jobs: [], dropped: [] }, ctx), /notion outage/);
  assert.equal(storage.store.has(CACHE_PATH), false);
});
