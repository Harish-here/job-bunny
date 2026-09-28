/**
 * search_urls_save.test.ts — TDD for `saveSearchUrlsDoc`, the shared
 * validate + normalize + write orchestration used by both the CLI (task 4)
 * and the board (task 7). Fake `ConfigStore` is a plain object literal with
 * a spy on `writeText`, same pattern as `routes.test.ts`'s `fakeSource`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigStore } from '../../../ports/config_store.ts';
import { saveSearchUrlsDoc } from './search_urls_save.ts';

const HEADER =
  '# Search URLs\n\n' +
  'Hierarchical: Channel → page → labeled URLs.\n' +
  'Add URLs with `/add-url` (strips ephemeral params). Format: `  • <label> - <url>`';

function doc(page: string, body: string): string {
  return (
    `${HEADER}\n\n## linkedin\n### ${page}\n` +
    `<!-- inventory: src/adapters/lanes/linkedin/page_inventory/${page}.json -->\n\n` +
    body
  );
}

function fakeStore(): ConfigStore & {
  writeCalls: Array<{ key: string; rawText: string }>;
} {
  const writeCalls: Array<{ key: string; rawText: string }> = [];
  return {
    writeCalls,
    async readText() {
      return undefined;
    },
    async writeText(key, rawText) {
      writeCalls.push({ key, rawText });
    },
    close() {},
  };
}

test('misfiled+dirty input rebuilds text, reports counts, and writes once', async () => {
  const input = doc(
    'linkedin__jobs-search-results',
    '  • Data roles - https://www.linkedin.com/jobs/search/?keywords=data&currentJobId=123\n',
  );
  const store = fakeStore();

  const result = await saveSearchUrlsDoc(store, input);

  assert.equal(result.report.refiled, 1);
  assert.equal(result.report.cleaned, 1);
  assert.equal(result.report.merged, 0);
  assert.equal(result.report.total, 1);
  assert.equal(result.report.changes.length, 2);
  assert.equal(result.text, result.text); // rebuilt doc is returned
  assert.ok(result.text.includes('https://www.linkedin.com/jobs/search/?keywords=data'));
  assert.ok(!result.text.includes('currentJobId'));

  assert.equal(store.writeCalls.length, 1);
  assert.equal(store.writeCalls[0]?.key, 'search_urls.md');
  assert.equal(store.writeCalls[0]?.rawText, result.text);
});

test('unrecognized link throws and writeText is never called', async () => {
  const input = doc(
    'linkedin__jobs-search',
    '  • Bad - https://example.com/not-linkedin\n',
  );
  const store = fakeStore();

  await assert.rejects(
    () => saveSearchUrlsDoc(store, input),
    (err: unknown) => err instanceof Error && err.message.startsWith('refused: '),
  );
  assert.equal(store.writeCalls.length, 0);
});

test(
  "N2 regression: empty raw text throws validateConfigDoc's empty-doc message " +
    'and writeText is never called — the raw-text check runs before normalize',
  async () => {
    const store = fakeStore();

    await assert.rejects(
      () => saveSearchUrlsDoc(store, ''),
      (err: unknown) =>
        err instanceof Error && err.message === 'search_urls.md must not be empty',
    );
    assert.equal(store.writeCalls.length, 0);
  },
);
