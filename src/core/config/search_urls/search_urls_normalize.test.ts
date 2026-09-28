import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSearchUrlsSaveReport,
  formatSearchUrlChangeLine,
  normalizeSearchUrlsDoc,
  resolveSearchUrlLabels,
} from './index.ts';
import { parseRows } from './search_urls_normalize.ts';

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

test('(a) canonical two-space-indented input is parsed', () => {
  const input = doc(
    'linkedin__jobs-search',
    '  • Engineer roles - https://www.linkedin.com/jobs/search/?keywords=engineer\n',
  );
  const result = normalizeSearchUrlsDoc(input);
  assert.equal(result.total, 1);
  assert.deepEqual(result.changes, []);
});

test('(b) misfiled + dirty link produces refiled + cleaned changes, correct headings', () => {
  const input = doc(
    'linkedin__jobs-search-results',
    '  • Data roles - https://www.linkedin.com/jobs/search/?keywords=data&currentJobId=123\n',
  );
  const result = normalizeSearchUrlsDoc(input);

  const refiled = result.changes.find((c) => c.kind === 'refiled');
  const cleaned = result.changes.find((c) => c.kind === 'cleaned');
  assert.equal(result.changes.length, 2);
  assert.ok(refiled);
  assert.equal(refiled.label, 'Data roles');
  assert.ok(refiled.detail.includes('Search results'));
  assert.ok(refiled.detail.includes('Jobs search'));
  assert.ok(cleaned);
  assert.equal(cleaned.detail, 'currentJobId');

  const rows = parseRows(result.text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.originalPage, 'linkedin__jobs-search');
  assert.equal(rows[0]?.url, 'https://www.linkedin.com/jobs/search/?keywords=data');
});

test(
  '(c) two links identical after cleaning merge to one change; ' +
    'formatSearchUrlChangeLine says "merged" exactly once',
  () => {
    const input = doc(
      'linkedin__jobs-search',
      '  • Primary search - https://www.linkedin.com/jobs/search/?keywords=data&currentJobId=123\n' +
        '  • Duplicate search - https://www.linkedin.com/jobs/search/?keywords=data\n',
    );
    const result = normalizeSearchUrlsDoc(input);
    assert.equal(result.total, 1);

    const merged = result.changes.filter((c) => c.kind === 'merged');
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.label, 'Duplicate search');
    assert.equal(merged[0]?.detail, 'Primary search');

    const line = formatSearchUrlChangeLine(merged[0]!);
    assert.equal(line, 'merged Duplicate search into Primary search');
    assert.equal(line.split('merged').length - 1, 1);
  },
);

test(
  'B1: a dirty %20-encoded copy and an already-clean %20-encoded copy of the same ' +
    'search normalize to the same URL and merge (R10)',
  () => {
    const input = doc(
      'linkedin__jobs-search',
      '  • Dirty copy - https://www.linkedin.com/jobs/search/?keywords=data%20scientist&currentJobId=123\n' +
        '  • Clean copy - https://www.linkedin.com/jobs/search/?keywords=data%20scientist\n',
    );
    const result = normalizeSearchUrlsDoc(input);
    assert.equal(result.total, 1);

    const merged = result.changes.filter((c) => c.kind === 'merged');
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.label, 'Clean copy');
    assert.equal(merged[0]?.detail, 'Dirty copy');
    assert.ok(
      result.text.includes(
        'https://www.linkedin.com/jobs/search/?keywords=data%20scientist\n',
      ),
    );
  },
);

test('(d) unrecognized (but URL-shaped) link throws, message starts "refused: "', () => {
  const input = doc(
    'linkedin__jobs-search',
    '  • Bad - https://example.com/not-linkedin\n',
  );
  assert.throws(
    () => normalizeSearchUrlsDoc(input),
    (err: unknown) => err instanceof Error && err.message.startsWith('refused: '),
  );
});

test('(e) scheme-less bullet is captured as a row and throws via classifier "refused:"', () => {
  const input = doc(
    'linkedin__jobs-search',
    '  • No scheme - www.linkedin.com/jobs/search\n',
  );
  const rows = parseRows(input);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.url, 'www.linkedin.com/jobs/search');
  assert.throws(
    () => normalizeSearchUrlsDoc(input),
    (err: unknown) => err instanceof Error && err.message.startsWith('refused: '),
  );
});

test('(f) header-only doc (zero bullet lines) returns empty result without throwing', () => {
  const input = `${HEADER}\n\n## linkedin`;
  const result = normalizeSearchUrlsDoc(input);
  assert.deepEqual(result.changes, []);
  assert.equal(result.total, 0);
});

test('(g) doc whose only bullet line is the trivially-blank placeholder does not throw', () => {
  const input = doc('linkedin__jobs-search', '  •  - \n');
  const result = normalizeSearchUrlsDoc(input);
  assert.deepEqual(result.changes, []);
  assert.equal(result.total, 0);
});

test(
  '(h) a genuinely malformed bullet-shaped line mixed with valid rows throws the ' +
    'parse-gap error',
  () => {
    const input = doc(
      'linkedin__jobs-search',
      '  • Good row - https://www.linkedin.com/jobs/search/?keywords=x\n' +
        '  • Totally malformed line without separator\n',
    );
    assert.throws(
      () => normalizeSearchUrlsDoc(input),
      /bullet-shaped line that failed to parse/,
    );
  },
);

test('(i) an already-well-formed doc round-trips byte-identical, changes: []', () => {
  const dirty = doc(
    'linkedin__jobs-search',
    '  • Engineer roles - https://www.linkedin.com/jobs/search/?keywords=engineer&currentJobId=1\n',
  );
  const first = normalizeSearchUrlsDoc(dirty);
  const second = normalizeSearchUrlsDoc(first.text);
  assert.equal(second.text, first.text);
  assert.deepEqual(second.changes, []);
});

test('(j) a real, non-empty label with an empty URL is skipped, absent from total', () => {
  const input = doc('linkedin__jobs-search', '  • Some Label - \n');
  const result = normalizeSearchUrlsDoc(input);
  assert.deepEqual(result.changes, []);
  assert.equal(result.total, 0);
});

test('formatSearchUrlChangeLine reproduces all three literal templates', () => {
  assert.equal(
    formatSearchUrlChangeLine({ kind: 'refiled', label: 'A', detail: 'X → Y' }),
    're-filed A: X → Y',
  );
  assert.equal(
    formatSearchUrlChangeLine({ kind: 'cleaned', label: 'A', detail: 'currentJobId' }),
    'cleaned A: removed currentJobId',
  );
  assert.equal(
    formatSearchUrlChangeLine({ kind: 'merged', label: 'A', detail: 'B' }),
    'merged A into B',
  );
});

test('buildSearchUrlsSaveReport counts changes by kind', () => {
  const input = doc(
    'linkedin__jobs-search-results',
    '  • Primary - https://www.linkedin.com/jobs/search/?keywords=data&currentJobId=1\n' +
      '  • Duplicate - https://www.linkedin.com/jobs/search/?keywords=data\n',
  );
  const result = normalizeSearchUrlsDoc(input);
  const report = buildSearchUrlsSaveReport(result);
  assert.equal(report.total, result.total);
  assert.equal(report.refiled, result.changes.filter((c) => c.kind === 'refiled').length);
  assert.equal(report.cleaned, result.changes.filter((c) => c.kind === 'cleaned').length);
  assert.equal(report.merged, result.changes.filter((c) => c.kind === 'merged').length);
  assert.deepEqual(report.changes, result.changes);
});

test('resolveSearchUrlLabels keys by cleaned URL, first occurrence wins, never throws', () => {
  const input = doc(
    'linkedin__jobs-search',
    '  • First label - https://www.linkedin.com/jobs/search/?keywords=data&currentJobId=1\n' +
      '  • Second label - https://www.linkedin.com/jobs/search/?keywords=data\n' +
      '  • Not linkedin - https://example.com/foo\n',
  );
  const labels = resolveSearchUrlLabels(input);
  assert.equal(
    labels.get('https://www.linkedin.com/jobs/search/?keywords=data'),
    'First label',
  );
  assert.equal(labels.size, 1);
});
