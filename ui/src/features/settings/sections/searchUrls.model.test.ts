import { describe, expect, it } from 'vitest';
import {
  isSlugCovered,
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
  it('extracts label/url rows under their ### slug', () => {
    const rows = parseSearchUrlRows(RAJNI_SHAPE);
    expect(rows).toEqual([
      {
        slug: 'linkedin__jobs-search',
        label: 'Staff Frontend Engineer',
        url: 'https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400',
      },
      {
        slug: 'linkedin__jobs-search',
        label: 'Lead Frontend Engineer',
        url: 'https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer&f_TPR=r86400',
      },
    ]);
  });

  it('parses a bullet using * and one using -', () => {
    const text = '### s\n* A - https://a.example\n- B - https://b.example\n';
    expect(parseSearchUrlRows(text)).toEqual([
      { slug: 's', label: 'A', url: 'https://a.example' },
      { slug: 's', label: 'B', url: 'https://b.example' },
    ]);
  });

  it('ignores a line with no " - " separator', () => {
    const text = '### s\n  • just a label with no separator\n';
    expect(parseSearchUrlRows(text)).toEqual([]);
  });

  it('drops a group with zero URLs, and returns [] for empty text', () => {
    const text = '### empty-group\n### s\n  • A - https://a.example\n';
    expect(parseSearchUrlRows(text)).toEqual([
      { slug: 's', label: 'A', url: 'https://a.example' },
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
      { slug: 'linkedin__jobs-search', label: 'A', url: 'https://a.example' },
    ]);
    expect(text).toContain(
      '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json -->',
    );
    expect(text).not.toContain('.md -->');
  });
});

describe('isSlugCovered', () => {
  it('covers the two known LinkedIn job-search page types', () => {
    expect(isSlugCovered('linkedin__jobs-search')).toBe(true);
    expect(isSlugCovered('linkedin__jobs-search-results')).toBe(true);
  });

  it('flags any other slug as uncovered', () => {
    expect(isSlugCovered('linkedin__some-new-page')).toBe(false);
  });
});
