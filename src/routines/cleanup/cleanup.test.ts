import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CacheEntry, JD, SyncedJD } from '../../core/jd/index.ts';
import type { PipelineCtx, WiredPorts } from '../../pipeline/runner/index.ts';
import type {
  ArchivePolicy,
  Connector,
  LogData,
  Logger,
  RunContext,
} from '../../ports/index.ts';
import { CleanupSettingsSchema, cleanupRoutine } from './cleanup.ts';

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
  archiveStale?: (policy: ArchivePolicy, ctx: RunContext) => Promise<number>;
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
    async archiveStale(policy: ArchivePolicy, ctx: RunContext): Promise<number> {
      archiveCalls.push(policy);
      return overrides?.archiveStale ? overrides.archiveStale(policy, ctx) : 3;
    },
  };
}

function fakeCtx(opts?: {
  settings?: Record<string, unknown>;
  connector?: Connector;
  logger?: Logger;
}): PipelineCtx {
  const connector = opts?.connector ?? fakeConnector();
  const ports: WiredPorts = { lanes: [], connector, notifiers: [] };
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: opts?.logger ?? { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: {
      async readJson() {
        return undefined;
      },
      async writeJson() {},
    },
    config: {
      lanes: [],
      connector: 'notion',
      notifiers: [],
      routines: ['cleanup'],
      settings: opts?.settings ?? {},
    },
    ports,
    async notify() {},
  };
}

test('CleanupSettingsSchema: empty object parses to v0-pinned defaults (7 / 30)', () => {
  const settings = CleanupSettingsSchema.parse({});
  assert.deepEqual(settings, { passedOlderThanDays: 7, untouchedOlderThanDays: 30 });
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
  const connector = fakeConnector({ archiveStale: async () => 5 });
  const ctx = fakeCtx({ connector, logger });

  await cleanupRoutine.run(ctx);

  const infoCall = logger.calls.find((c) => c.level === 'info');
  assert.ok(infoCall);
  assert.equal(infoCall?.data?.archived, 5);
});

test('run(): rejects an invalid settings.cleanup slice loudly rather than silently falling back', async () => {
  const connector = fakeConnector();
  const ctx = fakeCtx({ connector, settings: { cleanup: { passedOlderThanDays: -1 } } });

  await assert.rejects(() => cleanupRoutine.run(ctx));
});
