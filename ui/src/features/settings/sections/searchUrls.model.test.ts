import { describe, expect, it } from 'vitest';
import {
  isPageCovered,
  parseSearchUrlRows,
  serializeSearchUrlRows,
} from './searchUrls.model';

const RAJNI_SHAPE =
  [
    '# Search URLs',
    '',
    'Hierarchical: Channel → page → labeled URLs. One page-type = one inventory ' +
      'in `src/adapters/lanes/linkedin/page_inventory/<page>.md`; many URLs may live ' +
      'beneath it.',
    'Add URLs with `/add-url` (strips ephemeral params). Format: `  • <label> - <url>`',
    '',
    '## linkedin',
    '### linkedin__jobs-search',
    '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.md -->',
    '',
    '  • Staff Frontend Engineer - ' +
      'https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400',
    '  • Lead Frontend Engineer - ' +
      'https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer&f_TPR=r86400',
  ].join('\n') + '\n';

describe('parseSearchUrlRows', () => {
  it('extracts label/url rows under their ### page, all touched', () => {
    const rows = parseSearchUrlRows(RAJNI_SHAPE);
    expect(rows).toEqual([
      {
        page: 'linkedin__jobs-search',
        label: 'Staff Frontend Engineer',
        url: 'https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400',
        touched: true,
      },
      {
        page: 'linkedin__jobs-search',
        label: 'Lead Frontend Engineer',
        url: 'https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer&f_TPR=r86400',
        touched: true,
      },
    ]);
    expect(rows.every((row) => row.touched)).toBe(true);
  });

  it('parses a bullet using * and one using -', () => {
    const text = '### s\n* A - https://a.example\n- B - https://b.example\n';
    expect(parseSearchUrlRows(text)).toEqual([
      { page: 's', label: 'A', url: 'https://a.example', touched: true },
      { page: 's', label: 'B', url: 'https://b.example', touched: true },
    ]);
  });

  it('ignores a line with no " - " separator', () => {
    const text = '### s\n  • just a label with no separator\n';
    expect(parseSearchUrlRows(text)).toEqual([]);
  });

  it('drops a group with zero URLs, and returns [] for empty text', () => {
    const text = '### empty-group\n### s\n  • A - https://a.example\n';
    expect(parseSearchUrlRows(text)).toEqual([
      { page: 's', label: 'A', url: 'https://a.example', touched: true },
    ]);
    expect(parseSearchUrlRows('')).toEqual([]);
  });
});

describe('serializeSearchUrlRows', () => {
  it('round-trips entries over the real rajni document shape', () => {
    const rows = parseSearchUrlRows(RAJNI_SHAPE);
    const reparsed = parseSearchUrlRows(serializeSearchUrlRows(rows));
    expect(reparsed).toEqual(rows);
  });

  it('emits the .json inventory extension regardless of the source doc', () => {
    const text = serializeSearchUrlRows([
      {
        page: 'linkedin__jobs-search',
        label: 'A',
        url: 'https://a.example',
        touched: true,
      },
    ]);
    expect(text).toContain(
      '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json -->',
    );
    expect(text).not.toContain('.md -->');
  });

  // N5 regression: a row with a label but an empty url serializes to a
  // bullet line with no URL after the trailing " - ", which the shared
  // bullet-line grammar's regex does not match on either side — so the row
  // is silently absent from what either side re-parses as a "row."
  it('drops a label-only row (empty url) on round-trip, keeping the rest', () => {
    const rows = [
      {
        page: 'linkedin__jobs-search',
        label: 'Foo',
        url: '',
        touched: true,
      },
      {
        page: 'linkedin__jobs-search',
        label: 'Bar',
        url: 'https://b.example',
        touched: true,
      },
    ];
    const text = serializeSearchUrlRows(rows);
    const reparsed = parseSearchUrlRows(text);
    expect(reparsed.some((row) => row.label === 'Foo')).toBe(false);
    expect(reparsed).toEqual([
      {
        page: 'linkedin__jobs-search',
        label: 'Bar',
        url: 'https://b.example',
        touched: true,
      },
    ]);
  });
});

describe('isPageCovered', () => {
  it('covers the two known LinkedIn job-search page types', () => {
    expect(isPageCovered('linkedin__jobs-search')).toBe(true);
    expect(isPageCovered('linkedin__jobs-search-results')).toBe(true);
  });

  it('flags any other page as uncovered', () => {
    expect(isPageCovered('linkedin__some-new-page')).toBe(false);
  });
});
