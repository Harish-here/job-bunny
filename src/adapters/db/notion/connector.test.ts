/**
 * connector.ts tests — always against a stubbed `NotionSdkClientLike` (via
 * `NotionApi({ client: stub })`), never the real SDK, never the network.
 * Exercises `NotionConnector` purely as thin delegation — the underlying
 * behavior (pagination, automated-fields-only writes, dry-run archiving) is
 * already covered exhaustively in cache.test.ts/sync.test.ts/archive.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JD } from '../../../core/jd/index.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import { NotionApi, type NotionSdkClientLike } from './client.ts';
import { NotionConnector, NotionConnectorSettingsSchema } from './connector.ts';
import { PROPERTIES } from './schema.ts';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeCtx(): RunContext {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: noopLogger,
    beat() {},
  };
}

function stub(overrides: Partial<NotionSdkClientLike> = {}): NotionSdkClientLike {
  return {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => ({ id: 'x' }),
      update: async (args) => ({ id: args.page_id }),
    },
    ...overrides,
  };
}

test('constructor: throws when dbId is missing', () => {
  const api = new NotionApi({ client: stub() });
  assert.throws(() => new NotionConnector({}, api));
});

test('constructor: throws when dbId is an empty string', () => {
  const api = new NotionApi({ client: stub() });
  assert.throws(() => new NotionConnector({ dbId: '' }, api));
});

test('constructor: dryRun defaults to true when omitted (v0 cleanup.js invariant)', () => {
  assert.equal(NotionConnectorSettingsSchema.parse({ dbId: 'db1' }).dryRun, true);
});

test('constructor: dryRun can be explicitly set to false', () => {
  assert.equal(
    NotionConnectorSettingsSchema.parse({ dbId: 'db1', dryRun: false }).dryRun,
    false,
  );
});

test('name is "notion"', () => {
  const connector = new NotionConnector(
    { dbId: 'db1' },
    new NotionApi({ client: stub() }),
  );
  assert.equal(connector.name, 'notion');
});

test('rebuildCache: delegates to the configured dbId and shapes CacheEntry[]', async () => {
  const seenDbIds: string[] = [];
  const api = new NotionApi({
    client: stub({
      databases: {
        query: async ({ database_id }) => {
          seenDbIds.push(database_id);
          return {
            results: [
              {
                id: 'page-1',
                properties: {
                  [PROPERTIES.jobTitle.name]: { title: [{ plain_text: 'Engineer' }] },
                  [PROPERTIES.company.name]: { rich_text: [{ plain_text: 'Acme' }] },
                  [PROPERTIES.jobUrl.name]: {
                    url: 'https://www.linkedin.com/jobs/view/1',
                  },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          };
        },
      },
    }),
  });
  const connector = new NotionConnector({ dbId: 'my-db' }, api);

  const cache = await connector.rebuildCache(fakeCtx());

  assert.deepEqual(seenDbIds, ['my-db']);
  assert.deepEqual(cache, [
    { id: 'li-1', company: 'Acme', title: 'Engineer', pageId: 'page-1' },
  ]);
});

test('syncJobs: delegates and inserts a job with no known pageId against the configured dbId', async () => {
  const createArgs: { parent: unknown }[] = [];
  const api = new NotionApi({
    client: stub({
      pages: {
        create: async (args) => {
          createArgs.push(args);
          return { id: 'new-page' };
        },
        update: async (args) => ({ id: args.page_id }),
      },
    }),
  });
  const connector = new NotionConnector({ dbId: 'my-db' }, api);

  const job: JD = {
    identity: {
      id: 'li-1',
      lane: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/1',
      company: 'Acme',
      title: 'Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
  };
  const results = await connector.syncJobs([job], fakeCtx());

  assert.deepEqual(createArgs[0]?.parent, { database_id: 'my-db' });
  assert.equal(results[0]?.sync.pageId, 'new-page');
});

test('archiveStale: defaults to dry-run (no writes) when the connector was built with no dryRun setting', async () => {
  let updateCalls = 0;
  const api = new NotionApi({
    client: stub({
      databases: {
        query: async () => ({
          results: [
            {
              id: 'stale-1',
              properties: {
                [PROPERTIES.status.name]: { select: { name: 'Passed' } },
                [PROPERTIES.dateFound.name]: { date: { start: '2020-01-01' } },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      },
      pages: {
        create: async () => ({ id: 'x' }),
        update: async (args) => {
          updateCalls++;
          return { id: args.page_id };
        },
      },
    }),
  });
  const connector = new NotionConnector({ dbId: 'my-db' }, api);

  const count = await connector.archiveStale(
    { passedOlderThanDays: 7, untouchedOlderThanDays: 30 },
    fakeCtx(),
  );

  assert.equal(count, 1);
  assert.equal(updateCalls, 0, 'default dry-run must never write');
});

test('archiveStale: an explicit dryRun: false connector performs the write', async () => {
  let updateCalls = 0;
  const api = new NotionApi({
    client: stub({
      databases: {
        query: async () => ({
          results: [
            {
              id: 'stale-1',
              properties: {
                [PROPERTIES.status.name]: { select: { name: 'Passed' } },
                [PROPERTIES.dateFound.name]: { date: { start: '2020-01-01' } },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      },
      pages: {
        create: async () => ({ id: 'x' }),
        update: async (args) => {
          updateCalls++;
          return { id: args.page_id };
        },
      },
    }),
  });
  const connector = new NotionConnector({ dbId: 'my-db', dryRun: false }, api);

  const count = await connector.archiveStale(
    { passedOlderThanDays: 7, untouchedOlderThanDays: 30 },
    fakeCtx(),
  );

  assert.equal(count, 1);
  assert.equal(updateCalls, 1);
});
