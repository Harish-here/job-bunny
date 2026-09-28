import { describe, expect, it } from 'vitest';
import type { SearchUrlRow } from './searchUrls.model';
import { LABEL_MESSAGE, validateSearchUrlRows } from './searchUrlsValidate';

function row(overrides: Partial<SearchUrlRow> = {}): SearchUrlRow {
  return { page: '', label: '', url: '', touched: true, ...overrides };
}

describe('validateSearchUrlRows', () => {
  it('returns no error for a row with an empty URL', () => {
    expect(validateSearchUrlRows([row()])).toEqual({});
  });

  it('flags a non-URL string with the protocol message', () => {
    const errors = validateSearchUrlRows([row({ url: 'not a url' })]);
    expect(errors['where-jobs-search-urls.0']).toBe(
      'Enter a LinkedIn URL starting with https://',
    );
  });

  it('flags a non-https URL with the protocol message', () => {
    const errors = validateSearchUrlRows([
      row({ url: 'http://www.linkedin.com/jobs/search/?keywords=sre' }),
    ]);
    expect(errors['where-jobs-search-urls.0']).toBe(
      'Enter a LinkedIn URL starting with https://',
    );
  });

  it('flags an unrecognized host with the label-prefixed refusal message', () => {
    const errors = validateSearchUrlRows([
      row({ url: 'https://www.zafin.com/careers', label: 'Zafin' }),
    ]);
    expect(errors['where-jobs-search-urls.0']).toBe(
      'Zafin — not a LinkedIn jobs search link',
    );
  });

  it('flags a recognized link with an empty label', () => {
    const errors = validateSearchUrlRows([
      row({ url: 'https://www.linkedin.com/jobs/search/?keywords=sre', label: '' }),
    ]);
    expect(errors['where-jobs-search-urls.0']).toBe(LABEL_MESSAGE);
  });

  it('returns no error for a recognized, labeled link', () => {
    const errors = validateSearchUrlRows([
      row({ url: 'https://www.linkedin.com/jobs/search/?keywords=sre', label: 'SRE' }),
    ]);
    expect(errors).toEqual({});
  });

  it('keys errors by row index across multiple rows', () => {
    const errors = validateSearchUrlRows([
      row({ url: 'https://www.linkedin.com/jobs/search/?keywords=sre', label: 'SRE' }),
      row({ url: 'https://www.zafin.com/careers', label: 'Zafin' }),
    ]);
    expect(Object.keys(errors)).toEqual(['where-jobs-search-urls.1']);
  });
});
