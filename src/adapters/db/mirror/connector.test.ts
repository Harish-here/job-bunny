import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DroppedRecord, JD, SyncedJD } from '../../../core/jd/index.ts';
import type { ArchivePolicy, CacheEntry, Connector } from '../../../ports/connector.ts';
import type { LogData, Logger, RunContext } from '../../../ports/context.ts';
import { MirrorConnector } from './connector.ts';

type LogTuple = {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  data?: LogData;
};

function capturingLogger(): { logger: Logger; entries: LogTuple[] } {
  const entries: LogTuple[] = [];
  const logger: Logger = {
    debug(msg, data) {
      entries.push({ level: 'debug', msg, data });
    },
    info(msg, data) {
      entries.push({ level: 'info', msg, data });
    },
    warn(msg, data) {
      entries.push({ level: 'warn', msg, data });
    },
    error(msg, data) {
      entries.push({ level: 'error', msg, data });
    },
  };
  return { logger, entries };
}

function fakeCtx(logger: Logger): RunContext {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger,
    beat() {},
  };
}

function makeJd(id: string): JD {
  return {
    identity: {
      id,
      lane: 'linkedin',
      url: `https://www.linkedin.com/jobs/view/${id.replace('li-', '')}`,
      company: 'Acme Corp',
      title: 'Staff Frontend Engineer',
      scrapedAt: '2026-07-01T10:00:00.000Z',
    },
  };
}

function syncedFor(jobs: JD[]): SyncedJD[] {
  return jobs.map((job) => ({
    ...job,
    sync: { pageId: job.identity.id, syncedAt: 'now' },
  }));
}

function namedConnector(name: string, overrides: Partial<Connector> = {}): Connector {
  return {
    name,
    async rebuildCache(_ctx: RunContext): Promise<CacheEntry[]> {
      return [];
    },
    async syncJobs(jobs: JD[], _ctx: RunContext): Promise<SyncedJD[]> {
      return syncedFor(jobs);
    },
    async archiveStale(
      _policy: ArchivePolicy,
      _ctx: RunContext,
    ): Promise<{ archived: number; dropped: DroppedRecord[] }> {
      return { archived: 0, dropped: [] };
    },
    ...overrides,
  };
}

test('name is "sqlite+notion" when primary/mirror are so named', () => {
  const connector = new MirrorConnector(
    namedConnector('sqlite'),
    namedConnector('notion'),
  );
  assert.equal(connector.name, 'sqlite+notion');
});

test('rebuildCache delegates to primary only; mirror.rebuildCache never called', async () => {
  let mirrorCalled = false;
  const primary = namedConnector('sqlite', {
    async rebuildCache() {
      return [{ id: 'li-1' } as CacheEntry];
    },
  });
  const mirror = namedConnector('notion', {
    async rebuildCache() {
      mirrorCalled = true;
      return [];
    },
  });
  const connector = new MirrorConnector(primary, mirror);
  const { logger } = capturingLogger();
  const cache = await connector.rebuildCache(fakeCtx(logger));
  assert.deepEqual(cache, [{ id: 'li-1' }]);
  assert.equal(mirrorCalled, false);
});

test('archiveStale delegates to primary only', async () => {
  let mirrorCalled = false;
  const primary = namedConnector('sqlite', {
    async archiveStale() {
      return { archived: 3, dropped: [] };
    },
  });
  const mirror = namedConnector('notion', {
    async archiveStale() {
      mirrorCalled = true;
      return { archived: 0, dropped: [] };
    },
  });
  const connector = new MirrorConnector(primary, mirror);
  const { logger } = capturingLogger();
  const result = await connector.archiveStale(
    { passedOlderThanDays: 7, untouchedOlderThanDays: 14 },
    fakeCtx(logger),
  );
  assert.deepEqual(result, { archived: 3, dropped: [] });
  assert.equal(mirrorCalled, false);
});

test('syncJobs returns exactly primary results; mirror.syncJobs called with the ORIGINAL jobs array reference', async () => {
  const jobs = [makeJd('li-2')];
  let receivedJobs: JD[] | undefined;
  const primary = namedConnector('sqlite');
  const mirror = namedConnector('notion', {
    async syncJobs(jobsArg: JD[]) {
      receivedJobs = jobsArg;
      return syncedFor(jobsArg);
    },
  });
  const connector = new MirrorConnector(primary, mirror);
  const { logger } = capturingLogger();
  const result = await connector.syncJobs(jobs, fakeCtx(logger));
  assert.deepEqual(result, syncedFor(jobs));
  assert.equal(
    receivedJobs,
    jobs,
    'mirror must receive the ORIGINAL jobs array reference',
  );
});

test('mirror.syncJobs rejecting resolves with primary results; one warn logged containing "mirror" and the error message', async () => {
  const jobs = [makeJd('li-3')];
  const primary = namedConnector('sqlite');
  const mirror = namedConnector('notion', {
    async syncJobs(): Promise<SyncedJD[]> {
      throw new Error('notion down');
    },
  });
  const connector = new MirrorConnector(primary, mirror);
  const { logger, entries } = capturingLogger();
  const result = await connector.syncJobs(jobs, fakeCtx(logger));
  assert.deepEqual(result, syncedFor(jobs));

  const warns = entries.filter((e) => e.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0]?.msg ?? '', /mirror/);
  assert.match(JSON.stringify(warns[0]), /notion down/);
});

test('primary.syncJobs rejecting propagates the rejection; mirror never called', async () => {
  let mirrorCalled = false;
  const primary = namedConnector('sqlite', {
    async syncJobs(): Promise<SyncedJD[]> {
      throw new Error('sqlite disk full');
    },
  });
  const mirror = namedConnector('notion', {
    async syncJobs(jobsArg: JD[]) {
      mirrorCalled = true;
      return syncedFor(jobsArg);
    },
  });
  const connector = new MirrorConnector(primary, mirror);
  const { logger } = capturingLogger();
  await assert.rejects(
    () => connector.syncJobs([makeJd('li-4')], fakeCtx(logger)),
    /sqlite disk full/,
  );
  assert.equal(mirrorCalled, false);
});

test('DEADLINE: a hanging mirror that ignores its signal still lets syncJobs resolve with primary results, budget-bounded', async () => {
  const jobs = [makeJd('li-5')];
  const primary = namedConnector('sqlite');
  const mirror = namedConnector('notion', {
    syncJobs(): Promise<SyncedJD[]> {
      return new Promise(() => {}); // ignores its signal, never settles
    },
  });
  // Budget raised from the brief's illustrative 50ms to keep this test
  // robust under CI/local scheduling jitter while still running fast.
  const connector = new MirrorConnector(primary, mirror, 200);
  const { logger, entries } = capturingLogger();
  const result = await connector.syncJobs(jobs, fakeCtx(logger));
  assert.deepEqual(result, syncedFor(jobs));
  assert.equal(
    entries.filter((e) => e.level === 'warn').length,
    1,
    'a warn must be logged when the mirror deadline fires',
  );
});

test('PARTIAL: mirror resolves with fewer entries than jobs -> a WARN (not info) logged with { pushed, of }', async () => {
  const jobs = [makeJd('li-6'), makeJd('li-7')];
  const primary = namedConnector('sqlite');
  const mirror = namedConnector('notion', {
    async syncJobs(jobsArg: JD[]) {
      return syncedFor(jobsArg.slice(0, 1));
    },
  });
  const connector = new MirrorConnector(primary, mirror);
  const { logger, entries } = capturingLogger();
  await connector.syncJobs(jobs, fakeCtx(logger));

  const warns = entries.filter((e) => e.level === 'warn');
  const infos = entries.filter((e) => e.level === 'info');
  assert.equal(warns.length, 1);
  assert.equal(infos.length, 0);
  assert.equal(warns[0]?.data?.pushed, 1);
  assert.equal(warns[0]?.data?.of, 2);
});
