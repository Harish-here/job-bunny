import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CacheEntry, JD, SyncedJD } from '../../core/jd/index.ts';
import type { ArchivePolicy, Connector, RunContext } from '../../ports/index.ts';
import type { StageContext, StagePayload } from '../runner/stage.ts';
import { makeSyncStage } from './sync.ts';

function fakeCtx(): StageContext {
  return {
    profile: 'rajni',
    signal: AbortSignal.timeout(30_000),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: {
      async readJson() {
        return undefined;
      },
      async writeJson() {},
    },
  };
}

function fakeJob(id: string): JD {
  return {
    identity: {
      id,
      lane: 'linkedin',
      url: `https://example.com/jobs/${id}`,
      company: 'Acme Corp',
      title: 'Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
  };
}

function fakeConnector(overrides?: Partial<Connector>): Connector {
  return {
    name: 'fake',
    async rebuildCache(_ctx: RunContext): Promise<CacheEntry[]> {
      return [];
    },
    async syncJobs(jobs: JD[]): Promise<SyncedJD[]> {
      return jobs.map((jd) => ({
        ...jd,
        sync: { pageId: `page-${jd.identity.id}`, syncedAt: 'now' },
      }));
    },
    async archiveStale(_policy: ArchivePolicy): Promise<number> {
      return 0;
    },
    ...overrides,
  };
}

test('makeSyncStage: name/timeout/retries', () => {
  const stage = makeSyncStage(fakeConnector());
  assert.equal(stage.name, 'sync');
  assert.equal(
    stage.retries,
    0,
    'whole-stage retry is unsafe until syncJobs is retry-idempotent',
  );
  assert.ok(stage.timeoutMs > 0);
});

test('delegates the payload jobs to connector.syncJobs and returns the SyncedJD[] as the payload', async () => {
  const stage = makeSyncStage(fakeConnector());
  const input: StagePayload = { jobs: [fakeJob('li-1'), fakeJob('li-2')], dropped: [] };

  const out = await stage.run(input, fakeCtx());

  assert.deepEqual(
    out.jobs.map((j) => j.sync?.pageId),
    ['page-li-1', 'page-li-2'],
  );
});

test('preserves dropped records untouched', async () => {
  const priorDrop = { jd: fakeJob('li-0'), reasons: [] };
  const stage = makeSyncStage(fakeConnector());
  const input: StagePayload = { jobs: [fakeJob('li-1')], dropped: [priorDrop] };

  const out = await stage.run(input, fakeCtx());

  assert.deepEqual(out.dropped, [priorDrop]);
});

test('a per-page SoftError is already handled inside the connector — a batch that drops one job silently just returns fewer jobs, and the stage records a DroppedRecord for it', async () => {
  const stage = makeSyncStage(
    fakeConnector({
      async syncJobs(jobs: JD[]): Promise<SyncedJD[]> {
        // Simulates the connector's own internal SoftError handling: job
        // li-2's write failed and was dropped from the returned batch —
        // the stage wrapper must not need to know or care about this
        // per-job detail, only that li-2 vanished from what came back.
        return jobs
          .filter((jd) => jd.identity.id !== 'li-2')
          .map((jd) => ({
            ...jd,
            sync: { pageId: `page-${jd.identity.id}`, syncedAt: 'now' },
          }));
      },
    }),
  );
  const input: StagePayload = { jobs: [fakeJob('li-1'), fakeJob('li-2')], dropped: [] };

  const out = await stage.run(input, fakeCtx());

  assert.deepEqual(
    out.jobs.map((j) => j.identity.id),
    ['li-1'],
  );
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0]?.jd.identity.id, 'li-2');
  assert.equal(out.dropped[0]?.reasons[0]?.rule, 'sync.failed');
  assert.equal(out.dropped[0]?.reasons[0]?.severity, 'hard');
  assert.equal(out.dropped[0]?.reasons[0]?.pass, false);
  assert.match(out.dropped[0]?.reasons[0]?.detail ?? '', /page write failed/);
});

test('multiple jobs silently dropped by the connector each get exactly one DroppedRecord, appended after any prior drops', async () => {
  const priorDrop = { jd: fakeJob('li-0'), reasons: [] };
  const stage = makeSyncStage(
    fakeConnector({
      async syncJobs(jobs: JD[]): Promise<SyncedJD[]> {
        // Only li-3 succeeds — li-1 and li-2 both silently vanish.
        return jobs
          .filter((jd) => jd.identity.id === 'li-3')
          .map((jd) => ({
            ...jd,
            sync: { pageId: `page-${jd.identity.id}`, syncedAt: 'now' },
          }));
      },
    }),
  );
  const input: StagePayload = {
    jobs: [fakeJob('li-1'), fakeJob('li-2'), fakeJob('li-3')],
    dropped: [priorDrop],
  };

  const out = await stage.run(input, fakeCtx());

  assert.deepEqual(
    out.jobs.map((j) => j.identity.id),
    ['li-3'],
  );
  assert.equal(out.dropped.length, 3, 'the prior drop plus exactly one per missing job');
  assert.equal(out.dropped[0], priorDrop);
  assert.deepEqual(
    out.dropped.slice(1).map((d) => d.jd.identity.id),
    ['li-1', 'li-2'],
  );
  for (const d of out.dropped.slice(1)) {
    assert.equal(d.reasons[0]?.rule, 'sync.failed');
  }
});

test('a non-SoftError connector rejection propagates loudly (not caught/re-wrapped here)', async () => {
  const stage = makeSyncStage(
    fakeConnector({
      async syncJobs(): Promise<SyncedJD[]> {
        throw new Error('auth failure');
      },
    }),
  );
  const input: StagePayload = { jobs: [fakeJob('li-1')], dropped: [] };

  await assert.rejects(() => stage.run(input, fakeCtx()), /auth failure/);
});
