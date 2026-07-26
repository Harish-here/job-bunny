/**
 * client.ts tests — always against a stubbed SDK (never the real
 * `@notionhq/client`, never the network). Each stub implements just
 * `NotionSdkClientLike`'s three methods and records call counts so tests
 * can assert retry/give-up behavior precisely.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSoftError } from '../../../core/errors/soft_error.ts';
import { NotionApi, type NotionSdkClientLike } from './client.ts';

// Fast retry timings — real defaults (300ms doubling, 3 attempts) would
// make this suite slow; behavior under test is call counts/ordering, not
// wall-clock backoff duration.
const FAST = { maxAttempts: 3, baseDelayMs: 2, timeoutMs: 2_000 };

function ctx(signal: AbortSignal = new AbortController().signal) {
  return { signal };
}

function statusError(
  status: number,
  message = `HTTP ${status}`,
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

test('constructor: throws a clear error when NOTION_TOKEN is absent and no client/token is given', () => {
  const original = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  try {
    assert.throws(() => new NotionApi(), /NOTION_TOKEN/);
  } finally {
    if (original === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = original;
  }
});

test('constructor: does not throw when a client is injected, even with no token', () => {
  const original = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  try {
    const stub: NotionSdkClientLike = {
      databases: {
        query: async () => ({ results: [], has_more: false, next_cursor: null }),
      },
      pages: {
        create: async () => ({ id: 'p1' }),
        update: async () => ({ id: 'p1' }),
      },
    };
    assert.doesNotThrow(() => new NotionApi({ client: stub }));
  } finally {
    if (original === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = original;
  }
});

test('queryDatabase: retries on 429 and succeeds once the transient error clears', async () => {
  let calls = 0;
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => {
        calls++;
        if (calls < 3) throw statusError(429);
        return { results: [{ id: 'a' }], has_more: false, next_cursor: null };
      },
    },
    pages: { create: async () => ({ id: 'x' }), update: async () => ({ id: 'x' }) },
  };
  const api = new NotionApi({ client: stub, ...FAST });
  const results = await api.queryDatabase('db1', ctx());
  assert.deepEqual(results, [{ id: 'a' }]);
  assert.equal(calls, 3, 'expected exactly 3 attempts (2 failures + 1 success)');
});

test('queryDatabase: gives up after 3 attempts on a persistent 5xx and throws plainly', async () => {
  let calls = 0;
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => {
        calls++;
        throw statusError(503);
      },
    },
    pages: { create: async () => ({ id: 'x' }), update: async () => ({ id: 'x' }) },
  };
  const api = new NotionApi({ client: stub, ...FAST });
  await assert.rejects(() => api.queryDatabase('db1', ctx()), /503/);
  assert.equal(calls, 3, 'expected exactly maxAttempts calls before giving up');
});

test('queryDatabase: a persistent failure is NOT wrapped as SoftError (whole-read failure, not per-item)', async () => {
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => {
        throw statusError(500);
      },
    },
    pages: { create: async () => ({ id: 'x' }), update: async () => ({ id: 'x' }) },
  };
  const api = new NotionApi({ client: stub, ...FAST });
  await assert.rejects(
    () => api.queryDatabase('db1', ctx()),
    (err: unknown) => {
      assert.equal(isSoftError(err), false, 'queryDatabase must not throw SoftError');
      return true;
    },
  );
});

test('queryDatabase: paginates across has_more/next_cursor until exhausted', async () => {
  const pages = [
    { results: [{ id: 'a' }, { id: 'b' }], has_more: true, next_cursor: 'cursor-2' },
    { results: [{ id: 'c' }], has_more: true, next_cursor: 'cursor-3' },
    { results: [{ id: 'd' }], has_more: false, next_cursor: null },
  ];
  const seenCursors: (string | undefined)[] = [];
  const stub: NotionSdkClientLike = {
    databases: {
      query: async ({ start_cursor }) => {
        seenCursors.push(start_cursor);
        const page = pages[seenCursors.length - 1];
        if (!page) throw new Error('called more times than expected');
        return page;
      },
    },
    pages: { create: async () => ({ id: 'x' }), update: async () => ({ id: 'x' }) },
  };
  const api = new NotionApi({ client: stub, ...FAST });
  const results = await api.queryDatabase('db1', ctx());
  assert.deepEqual(results, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  assert.deepEqual(seenCursors, [undefined, 'cursor-2', 'cursor-3']);
});

test('createPage: a non-retryable error (e.g. 400 validation) propagates immediately, no retry', async () => {
  let calls = 0;
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => {
        calls++;
        throw statusError(400, 'validation_error: bad select value');
      },
      update: async () => ({ id: 'x' }),
    },
  };
  const api = new NotionApi({ client: stub, ...FAST });
  await assert.rejects(() => api.createPage('db1', {}, ctx()), /validation_error/);
  assert.equal(calls, 1, 'non-retryable errors must not be retried');
});

test('createPage: exhausted retries on a retryable error throws SoftError, batch-continuable', async () => {
  let calls = 0;
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => {
        calls++;
        throw statusError(429);
      },
      update: async () => ({ id: 'x' }),
    },
  };
  const api = new NotionApi({ client: stub, ...FAST });
  await assert.rejects(
    () => api.createPage('db1', {}, ctx()),
    (err: unknown) => {
      assert.ok(isSoftError(err), 'expected a SoftError');
      assert.equal((err as { scope: string }).scope, 'notion.createPage');
      return true;
    },
  );
  assert.equal(calls, 3);
});

test('createPage: succeeds on the underlying create call and returns its id', async () => {
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async (args) => {
        assert.deepEqual(args, {
          parent: { database_id: 'db1' },
          properties: { foo: 'bar' },
        });
        return { id: 'page-123' };
      },
      update: async () => ({ id: 'x' }),
    },
  };
  const api = new NotionApi({ client: stub, ...FAST });
  const page = await api.createPage('db1', { foo: 'bar' }, ctx());
  assert.deepEqual(page, { id: 'page-123' });
});

test('updatePage: exhausted retries on a retryable error also throws SoftError', async () => {
  let calls = 0;
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => ({ id: 'x' }),
      update: async () => {
        calls++;
        throw statusError(409);
      },
    },
  };
  const api = new NotionApi({ client: stub, ...FAST });
  await assert.rejects(
    () => api.updatePage('page-1', {}, ctx()),
    (err: unknown) => {
      assert.ok(isSoftError(err));
      assert.equal((err as { scope: string }).scope, 'notion.updatePage');
      return true;
    },
  );
  assert.equal(calls, 3);
});

test('archivePage: sends { page_id, archived: true } with no properties, and returns the id', async () => {
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => ({ id: 'x' }),
      update: async (args) => {
        assert.deepEqual(args, { page_id: 'page-9', archived: true });
        return { id: 'page-9' };
      },
    },
  };
  const api = new NotionApi({ client: stub, ...FAST });
  const result = await api.archivePage('page-9', ctx());
  assert.deepEqual(result, { id: 'page-9' });
});

test('archivePage: exhausted retries on a retryable error throws SoftError, batch-continuable', async () => {
  let calls = 0;
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => ({ id: 'x' }),
      update: async () => {
        calls++;
        throw statusError(429);
      },
    },
  };
  const api = new NotionApi({ client: stub, ...FAST });
  await assert.rejects(
    () => api.archivePage('page-9', ctx()),
    (err: unknown) => {
      assert.ok(isSoftError(err));
      assert.equal((err as { scope: string }).scope, 'notion.archivePage');
      return true;
    },
  );
  assert.equal(calls, 3);
});

test('abort: an already-aborted signal rejects without calling the SDK at all', async () => {
  let calls = 0;
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => {
        calls++;
        return { results: [], has_more: false, next_cursor: null };
      },
    },
    pages: { create: async () => ({ id: 'x' }), update: async () => ({ id: 'x' }) },
  };
  const controller = new AbortController();
  controller.abort(new Error('already gone'));
  const api = new NotionApi({ client: stub, ...FAST });
  await assert.rejects(() => api.queryDatabase('db1', ctx(controller.signal)));
  assert.equal(calls, 0, 'the SDK must not be called for an already-aborted signal');
});

test('abort: aborting mid-flight rejects promptly instead of waiting on the pending call', async () => {
  const stub: NotionSdkClientLike = {
    databases: {
      query: () => new Promise(() => {}), // never resolves
    },
    pages: { create: async () => ({ id: 'x' }), update: async () => ({ id: 'x' }) },
  };
  const controller = new AbortController();
  const api = new NotionApi({
    client: stub,
    maxAttempts: 3,
    baseDelayMs: 2,
    timeoutMs: 60_000,
  });
  const start = Date.now();
  const pending = api.queryDatabase('db1', ctx(controller.signal));
  setTimeout(() => controller.abort(new Error('test abort')), 30);
  await assert.rejects(() => pending);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 2_000, `expected prompt rejection, took ${elapsedMs}ms`);
});

test('abort: does not retry after the signal aborts mid-backoff', async () => {
  let calls = 0;
  const controller = new AbortController();
  const stub: NotionSdkClientLike = {
    databases: {
      query: async () => {
        calls++;
        if (calls === 1) controller.abort(new Error('abort after first failure'));
        throw statusError(429);
      },
    },
    pages: { create: async () => ({ id: 'x' }), update: async () => ({ id: 'x' }) },
  };
  const api = new NotionApi({
    client: stub,
    maxAttempts: 3,
    baseDelayMs: 50,
    timeoutMs: 60_000,
  });
  await assert.rejects(() => api.queryDatabase('db1', ctx(controller.signal)));
  assert.equal(calls, 1, 'must not retry once the caller signal has aborted');
});
