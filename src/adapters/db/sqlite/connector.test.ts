import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { JD } from '../../../core/jd/index.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import { isStale, SqliteConnector } from './connector.ts';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function fakeCtx(): RunContext {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: noopLogger,
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

function tmpConnector(settings: unknown = {}): SqliteConnector {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-conn-'));
  return new SqliteConnector(
    settings,
    path.join(dir, 'jobbunny.db'),
    () => '2026-08-01T12:00:00.000Z',
  );
}

test('name is sqlite; construction does no IO; bad settings throw at construction', () => {
  const connector = tmpConnector();
  assert.equal(connector.name, 'sqlite');
  assert.throws(() => tmpConnector({ path: '' }));
});

test('rebuildCache on a fresh profile returns [] (empty DB is created, not an error)', async () => {
  const connector = tmpConnector();
  assert.deepEqual(await connector.rebuildCache(fakeCtx()), []);
});

test('syncJobs upserts and stamps sync {pageId: identity.id, syncedAt}; rebuildCache sees it', async () => {
  const connector = tmpConnector();
  const synced = await connector.syncJobs([makeJd('li-10')], fakeCtx());

  assert.deepEqual(synced[0]?.sync, {
    pageId: 'li-10',
    syncedAt: '2026-08-01T12:00:00.000Z',
  });
  const cache = await connector.rebuildCache(fakeCtx());
  assert.equal(cache[0]?.id, 'li-10');
});

test('archiveStale dryRun (default) counts would-archive but writes nothing', async () => {
  const connector = tmpConnector(); // dryRun defaults to true
  await connector.syncJobs([makeJd('li-11')], fakeCtx()); // dateFound 2026-07-01, no status

  const result = await connector.archiveStale(
    { passedOlderThanDays: 7, untouchedOlderThanDays: 14 },
    fakeCtx(),
  );
  assert.deepEqual(result, { archived: 1, dropped: [] });
  assert.equal(
    (await connector.rebuildCache(fakeCtx())).length,
    1,
    'dry run must not write',
  );
});

test('archiveStale with dryRun:false archives untouched-old rows and hides them from cache', async () => {
  const connector = tmpConnector({ dryRun: false });
  await connector.syncJobs([makeJd('li-12')], fakeCtx());

  const result = await connector.archiveStale(
    { passedOlderThanDays: 7, untouchedOlderThanDays: 14 },
    fakeCtx(),
  );
  assert.deepEqual(result, { archived: 1, dropped: [] });
  assert.deepEqual(await connector.rebuildCache(fakeCtx()), []);
});

test('isStale: Passed uses passedOlderThanDays; untouched uses untouchedOlderThanDays; other statuses never stale', () => {
  const nowMs = Date.parse('2026-08-01T12:00:00.000Z');
  const tenDaysAgo = '2026-07-22T12:00:00.000Z';
  const policy = { passedOlderThanDays: 7, untouchedOlderThanDays: 14 };

  assert.equal(isStale({ dateFound: tenDaysAgo, status: 'Passed' }, policy, nowMs), true);
  assert.equal(isStale({ dateFound: tenDaysAgo, status: null }, policy, nowMs), false);
  assert.equal(
    isStale({ dateFound: tenDaysAgo, status: 'Applied' }, policy, nowMs),
    false,
  );
  const twentyDaysAgo = '2026-07-12T12:00:00.000Z';
  assert.equal(isStale({ dateFound: twentyDaysAgo, status: null }, policy, nowMs), true);
});
