import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
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
  // `path` was retired (config→db Phase 4 — see `builders.ts`'s
  // `assertSqlitePathRetired`); `dryRun` is the schema's only remaining
  // field, so a wrong-typed `dryRun` is now the invalid-settings trigger.
  assert.throws(() => tmpConnector({ dryRun: 'not-a-boolean' }));
});

test('settings.sqlite.path is no longer part of the schema — an extra `path` key is ignored, not honored (the db always opens at defaultDbPath)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-conn-'));
  const defaultDbPath = path.join(dir, 'jobbunny.db');
  const otherDbPath = path.join(dir, 'other.db');
  const connector = new SqliteConnector(
    { path: otherDbPath },
    defaultDbPath,
    () => '2026-08-01T12:00:00.000Z',
  );
  await connector.syncJobs([makeJd('li-99')], fakeCtx());
  assert.equal(existsSync(defaultDbPath), true);
  assert.equal(existsSync(otherDbPath), false);
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

test('close(): releases the lazily-opened handle — a subsequent op reopens and works', async () => {
  const connector = tmpConnector();
  await connector.syncJobs([makeJd('li-40')], fakeCtx());

  connector.close();

  const cache = await connector.rebuildCache(fakeCtx());
  assert.equal(cache[0]?.id, 'li-40');
});

test('close(): before any op is a no-op that does not throw', () => {
  const connector = tmpConnector();
  assert.doesNotThrow(() => connector.close());
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
