/**
 * run_link_soft_errors.test.ts (blueprint-be.md Step 14, R11) — TDD for
 * `resolveLinkSoftErrors`: read-back + staleness-guard + label-resolution
 * for farm's side-written `link_soft_errors.json` doc. `stateStore` is a
 * fake (mirrors `reconcile.test.ts`'s `fakeStateStore`); `search_urls.md`
 * label resolution goes through a REAL `wireConfigStore` against a temp
 * root (mirrors `profile.test.ts`'s `withTmpRoot`) — readonly lift mode
 * with no db file present reads the legacy file directly
 * (`SqliteConfigStore`'s documented readonly-no-db path), so no sqlite
 * setup is needed here.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunResult } from '../../ops/observability/index.ts';
import type { Logger } from '../../ports/context.ts';
import type { StateStore } from '../../ports/state_store.ts';
import { resolveLinkSoftErrors } from './run_link_soft_errors.ts';

const RUN_STARTED_AT = '2026-09-28T10:00:00.000Z';

function passedResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    profile: 'acme',
    date: '2026-09-28',
    time: '10-00',
    outcome: 'passed',
    stages: [],
    ...overrides,
  };
}

const SEARCH_URLS_HEADER =
  '# Search URLs\n\n' +
  'Hierarchical: Channel → page → labeled URLs.\n' +
  'Add URLs with `/add-url` (strips ephemeral params). Format: `  • <label> - <url>`';

function searchUrlsDoc(rows: Array<{ label: string; url: string }>): string {
  const body = rows.map((r) => `  • ${r.label} - ${r.url}`).join('\n');
  return (
    `${SEARCH_URLS_HEADER}\n\n## linkedin\n### linkedin__jobs-search\n` +
    '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json -->\n\n' +
    `${body}\n`
  );
}

/** Fake `StateStore` whose `readDoc` either returns a fixed doc, or throws
 * when `throwOnRead` is set — mirrors `reconcile.test.ts`'s
 * `fakeStateStore` shape, plus a read-count so the "failed result never
 * even reads" case can assert the short-circuit. */
function fakeStateStore(opts: {
  doc?: unknown;
  throwOnRead?: boolean;
}): StateStore & { readCount: number } {
  const state = { readCount: 0 };
  return {
    get readCount() {
      return state.readCount;
    },
    async readDoc<T>(_key: string, schema: { parse(v: unknown): T }) {
      state.readCount += 1;
      if (opts.throwOnRead) throw new Error('boom: db unavailable');
      if (opts.doc === undefined) return undefined;
      return schema.parse(opts.doc);
    },
    async writeDoc() {},
    close() {},
  };
}

function fakeLogger(): Logger & { warnCalls: Array<[string, unknown]> } {
  const warnCalls: Array<[string, unknown]> = [];
  return {
    warnCalls,
    debug() {},
    info() {},
    warn(msg, data) {
      warnCalls.push([msg, data]);
    },
    error() {},
  };
}

async function withTmpRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'jobbunny-link-soft-errors-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
}

test('resolveLinkSoftErrors: fresh doc + matching search_urls.md → 2 labeled entries', async () => {
  await withTmpRoot(async (root) => {
    const urlA = 'https://www.linkedin.com/jobs/search/?keywords=backend';
    const urlB = 'https://www.linkedin.com/jobs/search/?keywords=frontend';
    await mkdir(path.join(root, 'profiles', 'acme'), { recursive: true });
    await writeFile(
      path.join(root, 'profiles', 'acme', 'search_urls.md'),
      searchUrlsDoc([
        { label: 'Backend roles', url: urlA },
        { label: 'Frontend roles', url: urlB },
      ]),
      'utf8',
    );

    const stateStore = fakeStateStore({
      doc: {
        writtenAt: '2026-09-28T10:05:00.000Z', // after runStartedAtIso — fresh
        links: [
          { url: urlA, reason: 'timeout' },
          { url: urlB, reason: 'blocked' },
        ],
      },
    });
    const logger = fakeLogger();

    const result = await resolveLinkSoftErrors(passedResult(), {
      stateStore,
      profile: 'acme',
      root,
      runStartedAtIso: RUN_STARTED_AT,
      logger,
    });

    assert.deepEqual(result.linkSoftErrors, [
      { url: urlA, reason: 'timeout', label: 'Backend roles' },
      { url: urlB, reason: 'blocked', label: 'Frontend roles' },
    ]);
    assert.equal(logger.warnCalls.length, 0);
  });
});

test('resolveLinkSoftErrors: a STALE doc (writtenAt < runStartedAtIso) passes the result through unchanged', async () => {
  await withTmpRoot(async (root) => {
    const input = passedResult();
    const stateStore = fakeStateStore({
      doc: {
        writtenAt: '2026-09-28T09:00:00.000Z', // BEFORE runStartedAtIso — stale
        links: [
          { url: 'https://www.linkedin.com/jobs/search/?keywords=x', reason: 'timeout' },
        ],
      },
    });
    const logger = fakeLogger();

    const result = await resolveLinkSoftErrors(input, {
      stateStore,
      profile: 'acme',
      root,
      runStartedAtIso: RUN_STARTED_AT,
      logger,
    });

    assert.equal(result, input);
    assert.equal(result.linkSoftErrors, undefined);
    assert.equal(logger.warnCalls.length, 0);
  });
});

test('resolveLinkSoftErrors: stateStore.readDoc throwing passes the result through unchanged, warns once', async () => {
  await withTmpRoot(async (root) => {
    const input = passedResult();
    const stateStore = fakeStateStore({ throwOnRead: true });
    const logger = fakeLogger();

    const result = await resolveLinkSoftErrors(input, {
      stateStore,
      profile: 'acme',
      root,
      runStartedAtIso: RUN_STARTED_AT,
      logger,
    });

    assert.equal(result, input);
    assert.equal(logger.warnCalls.length, 1);
    assert.equal(logger.warnCalls[0]?.[0].includes('link-soft-error'), true);
  });
});

test('resolveLinkSoftErrors: a FAILED result is passed through untouched without attempting the read', async () => {
  await withTmpRoot(async (root) => {
    const input = passedResult({ outcome: 'failed', failedStage: 'source' });
    const stateStore = fakeStateStore({ doc: { writtenAt: RUN_STARTED_AT, links: [] } });
    const logger = fakeLogger();

    const result = await resolveLinkSoftErrors(input, {
      stateStore,
      profile: 'acme',
      root,
      runStartedAtIso: RUN_STARTED_AT,
      logger,
    });

    assert.equal(result, input);
    assert.equal(stateStore.readCount, 0);
    assert.equal(logger.warnCalls.length, 0);
  });
});
