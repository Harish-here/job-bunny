import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CacheEntry, DroppedRecord, JD, SyncedJD } from '../../core/jd/index.ts';
import type { PipelineCtx, WiredPorts } from '../../pipeline/runner/index.ts';
import type {
  ArchivePolicy,
  Connector,
  LogData,
  Logger,
  RunContext,
  RunStore,
  Storage,
} from '../../ports/index.ts';
import {
  CleanupSettingsSchema,
  cleanupRoutine,
  selectPrunableRunDirs,
} from './cleanup.ts';

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  data?: LogData;
}

function fakeLogger(): Logger & { calls: LogCall[] } {
  const calls: LogCall[] = [];
  return {
    calls,
    debug(msg, data) {
      calls.push({ level: 'debug', msg, data });
    },
    info(msg, data) {
      calls.push({ level: 'info', msg, data });
    },
    warn(msg, data) {
      calls.push({ level: 'warn', msg, data });
    },
    error(msg, data) {
      calls.push({ level: 'error', msg, data });
    },
  };
}

function fakeConnector(overrides?: {
  archiveStale?: (
    policy: ArchivePolicy,
    ctx: RunContext,
  ) => Promise<{ archived: number; dropped: DroppedRecord[] }>;
}): Connector & { archiveCalls: ArchivePolicy[] } {
  const archiveCalls: ArchivePolicy[] = [];
  return {
    name: 'fake',
    archiveCalls,
    async rebuildCache(): Promise<CacheEntry[]> {
      return [];
    },
    async syncJobs(jobs: JD[]): Promise<SyncedJD[]> {
      return jobs.map((jd) => ({ ...jd, sync: { pageId: 'x', syncedAt: 'now' } }));
    },
    async archiveStale(policy: ArchivePolicy, ctx: RunContext) {
      archiveCalls.push(policy);
      return overrides?.archiveStale
        ? overrides.archiveStale(policy, ctx)
        : { archived: 3, dropped: [] };
    },
  };
}

function fakeRunsStorage(opts?: {
  runDirs?: string[];
  failOn?: Set<string>;
}): Storage & { removedTrees: string[] } {
  const removedTrees: string[] = [];
  return {
    removedTrees,
    async readJson() {
      return undefined;
    },
    async writeJson() {},
    async listSubdirs(relPath: string) {
      if (relPath !== 'runs') return [];
      return opts?.runDirs ?? [];
    },
    async removeTree(relPath: string) {
      const dir = relPath.replace(/^runs\//, '');
      if (opts?.failOn?.has(dir)) throw new Error(`boom: ${dir}`);
      removedTrees.push(relPath);
    },
  };
}

/** Recording `RunStore` fake — `pruneRunsOlderThan` records its call args
 * and returns `opts.prunedResult` (default 0); every other method is a
 * stub, since this routine never calls them. */
function fakeRunStore(opts?: { prunedResult?: number }): {
  store: RunStore;
  prunedCalls: Array<{ today: string; ttlDays: number }>;
} {
  const prunedCalls: Array<{ today: string; ttlDays: number }> = [];
  const store: RunStore = {
    startRun() {
      return -1;
    },
    appendEvents() {},
    heartbeat() {},
    recordFailure() {},
    recordSyncDryrun() {},
    finishRun() {},
    listRuns() {
      return [];
    },
    getRun() {
      return null;
    },
    listEvents() {
      return [];
    },
    findRunId() {
      return null;
    },
    pruneRunsOlderThan(today, ttlDays) {
      prunedCalls.push({ today, ttlDays });
      return opts?.prunedResult ?? 0;
    },
    close() {},
  };
  return { store, prunedCalls };
}

function fakeCtx(opts?: {
  settings?: Record<string, unknown>;
  connector?: Connector;
  logger?: Logger;
  storage?: Storage;
  runStore?: RunStore;
  checkpointStore?: PipelineCtx['checkpointStore'];
}): PipelineCtx {
  const connector = opts?.connector ?? fakeConnector();
  const ports: WiredPorts = { lanes: [], connector, notifiers: [] };
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: opts?.logger ?? { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: opts?.storage ?? fakeRunsStorage(),
    config: {
      lanes: [],
      connector: 'notion',
      notifiers: [],
      routines: ['cleanup'],
      settings: opts?.settings ?? {},
    },
    ports,
    runStore: opts?.runStore ?? fakeRunStore().store,
    checkpointStore: opts?.checkpointStore ?? ({} as PipelineCtx['checkpointStore']),
    async notify() {},
  };
}

test('CleanupSettingsSchema: empty object parses to defaults (7 / 30 / 30)', () => {
  const settings = CleanupSettingsSchema.parse({});
  assert.deepEqual(settings, {
    passedOlderThanDays: 7,
    untouchedOlderThanDays: 30,
    runsOlderThanDays: 30,
  });
});

test('cleanupRoutine: name "cleanup", when "post-sync"', () => {
  assert.equal(cleanupRoutine.name, 'cleanup');
  assert.equal(cleanupRoutine.when, 'post-sync');
});

test('run(): with no settings.cleanup, calls archiveStale with the pinned defaults', async () => {
  const connector = fakeConnector();
  const ctx = fakeCtx({ connector });

  await cleanupRoutine.run(ctx);

  assert.deepEqual(connector.archiveCalls, [
    { passedOlderThanDays: 7, untouchedOlderThanDays: 30 },
  ]);
});

test('run(): a configured settings.cleanup slice overrides the defaults', async () => {
  const connector = fakeConnector();
  const ctx = fakeCtx({
    connector,
    settings: { cleanup: { passedOlderThanDays: 14, untouchedOlderThanDays: 60 } },
  });

  await cleanupRoutine.run(ctx);

  assert.deepEqual(connector.archiveCalls, [
    { passedOlderThanDays: 14, untouchedOlderThanDays: 60 },
  ]);
});

test('run(): does not pass a dryRun field — that stays owned entirely by the connector', async () => {
  const connector = fakeConnector();
  const ctx = fakeCtx({ connector, settings: { cleanup: { passedOlderThanDays: 1 } } });

  await cleanupRoutine.run(ctx);

  assert.deepEqual(Object.keys(connector.archiveCalls[0] ?? {}).sort(), [
    'passedOlderThanDays',
    'untouchedOlderThanDays',
  ]);
});

test('run(): logs the archived count', async () => {
  const logger = fakeLogger();
  const connector = fakeConnector({
    archiveStale: async () => ({ archived: 5, dropped: [] }),
  });
  const ctx = fakeCtx({ connector, logger });

  await cleanupRoutine.run(ctx);

  const infoCall = logger.calls.find((c) => c.level === 'info');
  assert.ok(infoCall);
  assert.equal(infoCall?.data?.archived, 5);
});

test('run(): a page the connector failed to archive is warned about instead of silently vanishing', async () => {
  const logger = fakeLogger();
  const droppedRecord: DroppedRecord = {
    jd: {
      identity: {
        id: 'page-1',
        lane: 'notion-archive',
        url: 'https://www.notion.so/page1',
        company: 'Acme',
        title: 'Engineer',
        scrapedAt: '2026-07-25T00:00:00.000Z',
      },
    },
    reasons: [
      { rule: 'archive.failed', severity: 'hard', pass: false, detail: 'HTTP 429' },
    ],
  };
  const connector = fakeConnector({
    archiveStale: async () => ({ archived: 1, dropped: [droppedRecord] }),
  });
  const ctx = fakeCtx({ connector, logger });

  await cleanupRoutine.run(ctx);

  const warnCall = logger.calls.find((c) => c.level === 'warn');
  assert.ok(warnCall, 'archive-failure drops must be logged, not silently dropped');
  assert.equal(warnCall?.data?.count, 1);
});

test('run(): rejects an invalid settings.cleanup slice loudly rather than silently falling back', async () => {
  const connector = fakeConnector();
  const ctx = fakeCtx({ connector, settings: { cleanup: { passedOlderThanDays: -1 } } });

  await assert.rejects(() => cleanupRoutine.run(ctx));
});

test('selectPrunableRunDirs: a date strictly older than the cutoff is pruned', () => {
  const result = selectPrunableRunDirs(['2026-06-01'], '2026-07-26', 30);
  assert.deepEqual(result, ['2026-06-01']);
});

test('selectPrunableRunDirs: a date exactly at the cutoff is kept', () => {
  const result = selectPrunableRunDirs(['2026-06-26'], '2026-07-26', 30);
  assert.deepEqual(result, []);
});

test("selectPrunableRunDirs: today's own date is always kept, even at ttlDays 0", () => {
  const result = selectPrunableRunDirs(['2026-07-26'], '2026-07-26', 0);
  assert.deepEqual(result, []);
});

test('selectPrunableRunDirs: non-date-shaped names are ignored', () => {
  const result = selectPrunableRunDirs(
    ['not-a-date', '.DS_Store', '2026-06-01'],
    '2026-07-26',
    30,
  );
  assert.deepEqual(result, ['2026-06-01']);
});

test('selectPrunableRunDirs: a recent date within the TTL is kept', () => {
  const result = selectPrunableRunDirs(['2026-07-20'], '2026-07-26', 30);
  assert.deepEqual(result, []);
});

test('run(): prunes run folders older than runsOlderThanDays, keeps today and recent, and still archives', async () => {
  const connector = fakeConnector();
  const storage = fakeRunsStorage({
    runDirs: ['2026-06-01', '2026-07-20', '2026-07-26', 'not-a-date'],
  });
  const ctx = fakeCtx({
    connector,
    storage,
    settings: { cleanup: { runsOlderThanDays: 30 } },
  });
  // Pin "today" via the fake ctx's storage listSubdirs('runs') input above;
  // the routine itself computes today from Date.now(), so this test only
  // exercises 2026-06-01 (unambiguously > 30 days before any plausible
  // "today") to avoid coupling to wall-clock time.

  await cleanupRoutine.run(ctx);

  assert.deepEqual(connector.archiveCalls, [
    { passedOlderThanDays: 7, untouchedOlderThanDays: 30 },
  ]);
  assert.deepEqual(storage.removedTrees, ['runs/2026-06-01']);
});

test('run(): prunes runs/run_events rows via ctx.runStore, with the same TTL and today used for the folder prune', async () => {
  const logger = fakeLogger();
  const connector = fakeConnector();
  const { store, prunedCalls } = fakeRunStore({ prunedResult: 4 });
  const ctx = fakeCtx({
    connector,
    logger,
    runStore: store,
    settings: { cleanup: { runsOlderThanDays: 45 } },
  });

  await cleanupRoutine.run(ctx);

  assert.equal(prunedCalls.length, 1);
  assert.equal(prunedCalls[0]?.ttlDays, 45);
  assert.match(prunedCalls[0]?.today ?? '', /^\d{4}-\d{2}-\d{2}$/);

  const infoCall = logger.calls.find((c) => c.msg === 'cleanup: pruned run rows');
  assert.ok(infoCall, 'must log the number of pruned run rows');
  assert.equal(infoCall?.data?.prunedDbRuns, 4);
  assert.equal(infoCall?.data?.runsOlderThanDays, 45);
});

test('run(): a removeTree failure for one run folder is warned about but does not throw, and other prunes still happen', async () => {
  const logger = fakeLogger();
  const connector = fakeConnector();
  const storage = fakeRunsStorage({
    runDirs: ['2020-01-01', '2020-02-02'],
    failOn: new Set(['2020-01-01']),
  });
  const ctx = fakeCtx({ connector, storage, logger });

  await assert.doesNotReject(() => cleanupRoutine.run(ctx));

  const warnCall = logger.calls.find(
    (c) => c.level === 'warn' && c.msg.includes('failed to prune'),
  );
  assert.ok(warnCall, 'a per-folder prune failure must be warned, not thrown');
  assert.deepEqual(storage.removedTrees, ['runs/2020-02-02']);
});
