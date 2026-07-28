import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseSearchUrls } from './search_urls.ts';
import { REPO_ROOT } from './testkit/index.ts';

// ---------- parseSearchUrls ----------

test('parseSearchUrls parses the rajni search_urls.md fixture into page groups with their urls', async () => {
  const md = await readFile(`${REPO_ROOT}profiles/rajni/search_urls.md`, 'utf8');
  const groups = parseSearchUrls(md);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.page, 'linkedin__jobs-search');
  assert.deepEqual(groups[0]?.urls, [
    'https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400&sortBy=R',
    'https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer&f_TPR=r86400&sortBy=R',
  ]);
});

test('parseSearchUrls drops a page heading with zero urls beneath it', () => {
  const md = [
    '## linkedin',
    '### empty-page',
    '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/empty-page.md -->',
    '',
    '### linkedin__jobs-search',
    '  • Some Search - https://www.linkedin.com/jobs/search/?keywords=X',
  ].join('\n');

  const groups = parseSearchUrls(md);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.page, 'linkedin__jobs-search');
  assert.deepEqual(groups[0]?.urls, ['https://www.linkedin.com/jobs/search/?keywords=X']);
});
