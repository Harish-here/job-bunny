/**
 * cache.ts tests — always against a stubbed `NotionSdkClientLike` (via
 * `NotionApi({ client: stub })`), never the real SDK, never the network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger, RunContext } from '../../../ports/context.ts';
import { rebuildCache } from './cache.ts';
import { NotionApi, type NotionSdkClientLike } from './client.ts';
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

function rt(content: string) {
  return { rich_text: [{ plain_text: content }] };
}

function titleVal(content: string) {
  return { title: [{ plain_text: content }] };
}

function page(id: string, props: Record<string, unknown>) {
  return { id, properties: props };
}

function stubWithPages(pages: unknown[]): NotionSdkClientLike {
  return {
    databases: {
      query: async () => ({ results: pages, has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => ({ id: 'x' }),
      update: async () => ({ id: 'x' }),
    },
  };
}

test('rebuildCache: maps a full page to a CacheEntry, including city from Location City', async () => {
  const pages = [
    page('page-1', {
      [PROPERTIES.jobTitle.name]: titleVal('Staff Frontend Engineer'),
      [PROPERTIES.company.name]: rt('Acme Corp'),
      [PROPERTIES.locationCity.name]: rt('Chennai'),
      [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/12345' },
    }),
  ];
  const api = new NotionApi({ client: stubWithPages(pages) });

  const cache = await rebuildCache(api, 'db1', fakeCtx());

  assert.deepEqual(cache, [
    {
      id: 'li-12345',
      company: 'Acme Corp',
      title: 'Staff Frontend Engineer',
      pageId: 'page-1',
      city: 'Chennai',
    },
  ]);
});

test('rebuildCache: omits city when Location City is empty', async () => {
  const pages = [
    page('page-2', {
      [PROPERTIES.jobTitle.name]: titleVal('Backend Engineer'),
      [PROPERTIES.company.name]: rt('Other Co'),
      [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/999' },
    }),
  ];
  const api = new NotionApi({ client: stubWithPages(pages) });

  const [entry] = await rebuildCache(api, 'db1', fakeCtx());

  assert.equal(entry?.city, undefined);
  assert.ok(
    entry && !('city' in entry),
    'city key must be absent, not present-as-undefined',
  );
});

test('rebuildCache: derives a gh- id from a Greenhouse job_boards URL (gh_jid query param)', async () => {
  const pages = [
    page('page-3', {
      [PROPERTIES.jobTitle.name]: titleVal('SRE'),
      [PROPERTIES.company.name]: rt('Widget Inc'),
      [PROPERTIES.jobUrl.name]: {
        url: 'https://boards.greenhouse.io/widget?gh_jid=778899',
      },
    }),
  ];
  const api = new NotionApi({ client: stubWithPages(pages) });

  const [entry] = await rebuildCache(api, 'db1', fakeCtx());
  assert.equal(entry?.id, 'gh-778899');
});

test('rebuildCache: derives a gh- id from a greenhouse.io job path URL (no query param)', async () => {
  const pages = [
    page('page-4', {
      [PROPERTIES.jobTitle.name]: titleVal('SRE'),
      [PROPERTIES.company.name]: rt('Widget Inc'),
      [PROPERTIES.jobUrl.name]: {
        url: 'https://boards.greenhouse.io/widget/jobs/445566',
      },
    }),
  ];
  const api = new NotionApi({ client: stubWithPages(pages) });

  const [entry] = await rebuildCache(api, 'db1', fakeCtx());
  assert.equal(entry?.id, 'gh-445566');
});

test('rebuildCache: derives a kk- id from a Keka jobdetails URL', async () => {
  const pages = [
    page('page-5', {
      [PROPERTIES.jobTitle.name]: titleVal('Support Engineer'),
      [PROPERTIES.company.name]: rt('Foo Ltd'),
      [PROPERTIES.jobUrl.name]: { url: 'https://foo.keka.com/careers/jobdetails/321' },
    }),
  ];
  const api = new NotionApi({ client: stubWithPages(pages) });

  const [entry] = await rebuildCache(api, 'db1', fakeCtx());
  assert.equal(entry?.id, 'kk-321');
});

test('rebuildCache: an unrecognized URL shape yields an empty id (falsy — treated as "no id" downstream)', async () => {
  const pages = [
    page('page-6', {
      [PROPERTIES.jobTitle.name]: titleVal('Mystery Role'),
      [PROPERTIES.company.name]: rt('Mystery Co'),
      [PROPERTIES.jobUrl.name]: { url: 'https://example.com/careers/mystery' },
    }),
  ];
  const api = new NotionApi({ client: stubWithPages(pages) });

  const [entry] = await rebuildCache(api, 'db1', fakeCtx());
  assert.equal(entry?.id, '');
});

test('rebuildCache: paginates via NotionApi.queryDatabase and returns every page', async () => {
  const calls: (string | undefined)[] = [];
  const client: NotionSdkClientLike = {
    databases: {
      query: async ({ start_cursor }) => {
        calls.push(start_cursor);
        if (!start_cursor) {
          return {
            results: [
              page('page-a', {
                [PROPERTIES.jobTitle.name]: titleVal('A'),
                [PROPERTIES.company.name]: rt('Co A'),
                [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/1' },
              }),
            ],
            has_more: true,
            next_cursor: 'cursor-2',
          };
        }
        return {
          results: [
            page('page-b', {
              [PROPERTIES.jobTitle.name]: titleVal('B'),
              [PROPERTIES.company.name]: rt('Co B'),
              [PROPERTIES.jobUrl.name]: { url: 'https://www.linkedin.com/jobs/view/2' },
            }),
          ],
          has_more: false,
          next_cursor: null,
        };
      },
    },
    pages: { create: async () => ({ id: 'x' }), update: async () => ({ id: 'x' }) },
  };
  const api = new NotionApi({ client });

  const cache = await rebuildCache(api, 'db1', fakeCtx());

  assert.deepEqual(calls, [undefined, 'cursor-2']);
  assert.deepEqual(
    cache.map((e) => e.pageId),
    ['page-a', 'page-b'],
  );
});

test('rebuildCache: a whole-read failure throws plainly, never wrapped as SoftError', async () => {
  const client: NotionSdkClientLike = {
    databases: {
      query: async () => {
        const err = new Error('HTTP 500') as Error & { status: number };
        err.status = 500;
        throw err;
      },
    },
    pages: { create: async () => ({ id: 'x' }), update: async () => ({ id: 'x' }) },
  };
  const api = new NotionApi({ client, maxAttempts: 1 });

  await assert.rejects(
    () => rebuildCache(api, 'db1', fakeCtx()),
    (err: unknown) => {
      assert.equal((err as { name?: string }).name, 'Error');
      return true;
    },
  );
});
