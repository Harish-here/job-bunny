import { describe, expect, it } from 'vitest';
import { buildValidationSummaryRefusalMessage } from './searchUrlRow.classify';
import type { SearchUrlRow } from './searchUrls.model';
import {
  buildSearchUrlsSuccessMessage,
  mergeServerRefusal,
  reseedRowsFromText,
} from './searchUrlsSave';

describe('reseedRowsFromText', () => {
  it('groups rows correctly on a two-heading doc and marks every row touched', () => {
    const text = [
      '# Search URLs',
      '',
      '## linkedin',
      '### linkedin__jobs-search',
      '  • First - https://linkedin.com/jobs/search?a=1',
      '  • Second - https://linkedin.com/jobs/search?a=2',
      '### linkedin__jobs-search-results',
      '  • Third - https://linkedin.com/jobs/search-results?a=3',
      '',
    ].join('\n');

    const rows = reseedRowsFromText(text);

    expect(rows).toEqual([
      {
        page: 'linkedin__jobs-search',
        label: 'First',
        url: 'https://linkedin.com/jobs/search?a=1',
        touched: true,
      },
      {
        page: 'linkedin__jobs-search',
        label: 'Second',
        url: 'https://linkedin.com/jobs/search?a=2',
        touched: true,
      },
      {
        page: 'linkedin__jobs-search-results',
        label: 'Third',
        url: 'https://linkedin.com/jobs/search-results?a=3',
        touched: true,
      },
    ]);
    expect(rows.every((row) => row.touched === true)).toBe(true);
  });
});

describe('buildSearchUrlsSuccessMessage', () => {
  it('matches ux-notes §10 literal example: refiled 0, cleaned 1, merged 1', () => {
    const message = buildSearchUrlsSuccessMessage({
      total: 4,
      refiled: 0,
      cleaned: 1,
      merged: 1,
      changes: [],
    });
    expect(message).toBe('Saved 4 search links. Cleaned 1, merged 1 duplicate.');
  });

  it('returns just the base sentence when the report is all-zero', () => {
    const message = buildSearchUrlsSuccessMessage({
      total: 3,
      refiled: 0,
      cleaned: 0,
      merged: 0,
      changes: [],
    });
    expect(message).toBe('Saved 3 search links.');
  });

  it('capitalizes a first clause other than "cleaned" (regression)', () => {
    const message = buildSearchUrlsSuccessMessage({
      total: 2,
      refiled: 1,
      cleaned: 0,
      merged: 0,
      changes: [],
    });
    expect(message).toBe('Saved 2 search links. Re-filed 1.');
  });

  it('pluralizes "duplicate" only when merged > 1', () => {
    const message = buildSearchUrlsSuccessMessage({
      total: 5,
      refiled: 0,
      cleaned: 0,
      merged: 2,
      changes: [],
    });
    expect(message).toBe('Saved 5 search links. Merged 2 duplicates.');
  });

  it('uses singular "link" when total is 1', () => {
    const message = buildSearchUrlsSuccessMessage({
      total: 1,
      refiled: 0,
      cleaned: 0,
      merged: 0,
      changes: [],
    });
    expect(message).toBe('Saved 1 search link.');
  });
});

describe('mergeServerRefusal', () => {
  // First row's url ('https://xtra') shares the second row's url
  // ('https://x') as its own prefix, and is listed first — a
  // wrong-direction substring check would either false-match row 0 or
  // never match at all instead of correctly landing on row 1.
  const rows: SearchUrlRow[] = [
    { page: 'linkedin__jobs-search', label: 'Xtra', url: 'https://xtra', touched: true },
    { page: 'linkedin__jobs-search', label: 'Xample', url: 'https://x', touched: true },
  ];

  it('matches the row whose url === the refused url, not a prefix (regression)', () => {
    const result = mergeServerRefusal({}, rows, 'refused: https://x — not a...');
    expect(result).toEqual({
      'where-jobs-search-urls.1': buildValidationSummaryRefusalMessage('Xample'),
    });
    // Never the raw server string.
    expect(Object.values(result)).not.toContain('refused: https://x — not a...');
  });

  it('preserves existing client errors alongside the merged server refusal', () => {
    const result = mergeServerRefusal(
      { 'where-jobs-search-urls.0': 'some client error' },
      rows,
      'refused: https://x — not a...',
    );
    expect(result).toEqual({
      'where-jobs-search-urls.0': 'some client error',
      'where-jobs-search-urls.1': buildValidationSummaryRefusalMessage('Xample'),
    });
  });

  it('falls back to the search-urls.server key when no row matches', () => {
    const result = mergeServerRefusal({}, rows, 'refused: https://nowhere — not a...');
    expect(result).toEqual({
      'search-urls.server': buildValidationSummaryRefusalMessage(''),
    });
    expect(result['search-urls.server']).toBe(
      'This link — not a LinkedIn jobs search link',
    );
  });
});
