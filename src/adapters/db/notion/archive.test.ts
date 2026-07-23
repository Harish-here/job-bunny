/**
 * archive.ts tests — always against a stubbed `NotionSdkClientLike` (via
 * `NotionApi({ client: stub })`), never the real SDK, never the network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArchivePolicy } from '../../../ports/connector.ts';
import type { Logger, RunContext } from '../../../ports/context.ts';
import { archiveStale } from './archive.ts';
import { NotionApi, type NotionSdkClientLike } from './client.ts';
import { PROPERTIES } from './schema.ts';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: noopLogger,
    beat() {},
    ...overrides,
  };
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function page(id: string, status: string | undefined, dateFound: string | undefined) {
  return {
    id,
    properties: {
      [PROPERTIES.status.name]: status ? { select: { name: status } } : { select: null },
      [PROPERTIES.dateFound.name]: dateFound
        ? { date: { start: dateFound } }
        : { date: null },
    },
  };
}

const POLICY: ArchivePolicy = { passedOlderThanDays: 7, untouchedOlderThanDays: 30 };

function fixturePages() {
  return [
    page('passed-old', 'Passed', isoDaysAgo(10)), // stale: Passed, older than 7d
    page('passed-recent', 'Passed', isoDaysAgo(2)), // not stale: Passed but recent
    page('no-status-old', undefined, isoDaysAgo(40)), // stale: no status, older than 30d
    page('no-status-recent', undefined, isoDaysAgo(5)), // not stale: no status but recent
    page('applied-old', 'Applied', isoDaysAgo(100)), // never stale: neither rule applies
    page('passed-no-date', 'Passed', undefined), // never stale: no Date Found to compare
  ];
}

function stubWithPages(
  pages: unknown[],
  onUpdate?: (args: { page_id: string; archived?: boolean }) => void,
): NotionSdkClientLike {
  return {
    databases: {
      query: async () => ({ results: pages, has_more: false, next_cursor: null }),
    },
    pages: {
      create: async () => ({ id: 'x' }),
      update: async (args) => {
        onUpdate?.(args);
        return { id: args.page_id };
      },
    },
  };
}

test('archiveStale: dry-run (default posture) returns the would-archive count and performs zero writes', async () => {
  const updateCalls: unknown[] = [];
  const api = new NotionApi({
    client: stubWithPages(fixturePages(), (args) => updateCalls.push(args)),
  });

  const count = await archiveStale(api, 'db1', POLICY, true, fakeCtx());

  assert.equal(count, 2, 'passed-old + no-status-old are the only two stale rows');
  assert.equal(updateCalls.length, 0, 'dry-run must perform zero writes');
});

test('archiveStale: apply mode archives exactly the stale rows by flipping `archived: true` (never a delete)', async () => {
  const updateCalls: { page_id: string; archived?: boolean }[] = [];
  const api = new NotionApi({
    client: stubWithPages(fixturePages(), (args) => updateCalls.push(args)),
  });

  const count = await archiveStale(api, 'db1', POLICY, false, fakeCtx());

  assert.equal(count, 2);
  assert.deepEqual(updateCalls.map((c) => c.page_id).sort(), [
    'no-status-old',
    'passed-old',
  ]);
  for (const call of updateCalls) {
    assert.deepEqual(Object.keys(call).sort(), ['archived', 'page_id']);
    assert.equal(call.archived, true);
  }
});

test('archiveStale: regression — the write call is exactly `{ page_id, archived: true }`, no `properties` key at all (v0 cleanup.js parity: `notion.pages.update({ page_id, archived: true })`, never a Status property change)', async () => {
  const updateCalls: Record<string, unknown>[] = [];
  const pages = [page('passed-old', 'Passed', isoDaysAgo(10))]; // the one stale row
  const api = new NotionApi({
    client: stubWithPages(pages, (args) => updateCalls.push(args)),
  });

  const count = await archiveStale(api, 'db1', POLICY, false, fakeCtx());

  assert.equal(count, 1);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0], { page_id: 'passed-old', archived: true });
});

test('archiveStale: a page missing Date Found is never archived under either rule', async () => {
  const api = new NotionApi({ client: stubWithPages(fixturePages()) });
  const count = await archiveStale(api, 'db1', POLICY, true, fakeCtx());
  // passed-no-date is Passed but has no date — must not count toward the 2.
  assert.equal(count, 2);
});

test('archiveStale: one page failing after exhausted retries (SoftError) is recorded and the batch continues', async () => {
  let updateCalls = 0;
  const client: NotionSdkClientLike = {
    databases: {
      query: async () => ({
        results: fixturePages(),
        has_more: false,
        next_cursor: null,
      }),
    },
    pages: {
      create: async () => ({ id: 'x' }),
      update: async (args) => {
        updateCalls++;
        if (args.page_id === 'passed-old') {
          const err = new Error('HTTP 429') as Error & { status: number };
          err.status = 429;
          throw err;
        }
        return { id: args.page_id };
      },
    },
  };
  const api = new NotionApi({ client, maxAttempts: 1 });

  const warnings: unknown[] = [];
  const ctx = fakeCtx({
    logger: { ...noopLogger, warn: (msg, data) => warnings.push({ msg, data }) },
  });

  const count = await archiveStale(api, 'db1', POLICY, false, ctx);

  assert.equal(
    count,
    1,
    'only the successfully-archived page counts; the failed one is a recorded casualty',
  );
  assert.equal(warnings.length, 1);
  assert.equal(
    updateCalls,
    2,
    'both stale pages were attempted despite the first failing',
  );
});

test('archiveStale: a non-retryable error (e.g. 400) propagates and fails the whole call', async () => {
  const client: NotionSdkClientLike = {
    databases: {
      query: async () => ({
        results: fixturePages(),
        has_more: false,
        next_cursor: null,
      }),
    },
    pages: {
      create: async () => ({ id: 'x' }),
      update: async () => {
        const err = new Error('bad request') as Error & { status: number };
        err.status = 400;
        throw err;
      },
    },
  };
  const api = new NotionApi({ client });

  await assert.rejects(
    () => archiveStale(api, 'db1', POLICY, false, fakeCtx()),
    /bad request/,
  );
});

test('archiveStale: no rows to archive returns 0 and performs zero writes', async () => {
  const updateCalls: unknown[] = [];
  const noneStale = [
    page('recent-passed', 'Passed', isoDaysAgo(1)),
    page('recent-no-status', undefined, isoDaysAgo(1)),
  ];
  const api = new NotionApi({
    client: stubWithPages(noneStale, (args) => updateCalls.push(args)),
  });

  const count = await archiveStale(api, 'db1', POLICY, false, fakeCtx());
  assert.equal(count, 0);
  assert.equal(updateCalls.length, 0);
});
