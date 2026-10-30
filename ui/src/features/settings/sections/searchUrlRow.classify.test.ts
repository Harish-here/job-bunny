import { describe, expect, it } from 'vitest';
import {
  buildValidationSummaryRefusalMessage,
  classifyRowsForDisplay,
  FIELD_ERROR_COPY,
  PROTOCOL_MESSAGE,
} from './searchUrlRow.classify';
import type { SearchUrlRow } from './searchUrls.model';

function row(overrides: Partial<SearchUrlRow>): SearchUrlRow {
  return {
    page: 'linkedin__jobs-search',
    label: 'Label',
    url: 'https://www.linkedin.com/jobs/search/',
    touched: true,
    ...overrides,
  };
}

describe('classifyRowsForDisplay', () => {
  it('marks an untouched row with text as unclassified', () => {
    const [display] = classifyRowsForDisplay([
      row({ touched: false, url: 'https://www.linkedin.com/jobs/search/' }),
    ]);
    expect(display).toEqual({ kind: 'unclassified' });
  });

  it('marks a touched row with a blank url as unclassified', () => {
    const [display] = classifyRowsForDisplay([row({ touched: true, url: '   ' })]);
    expect(display).toEqual({ kind: 'unclassified' });
  });

  it('refuses a non-URL string with PROTOCOL_MESSAGE, not FIELD_ERROR_COPY', () => {
    const [display] = classifyRowsForDisplay([row({ url: 'not a url' })]);
    expect(display).toEqual({ kind: 'refused', message: PROTOCOL_MESSAGE });
    expect((display as { message: string }).message).not.toEqual(FIELD_ERROR_COPY);
  });

  it('refuses an http:// (non-https) url with PROTOCOL_MESSAGE', () => {
    const [display] = classifyRowsForDisplay([
      row({ url: 'http://www.linkedin.com/jobs/search/' }),
    ]);
    expect(display).toEqual({ kind: 'refused', message: PROTOCOL_MESSAGE });
  });

  it('refuses a recognized-protocol but unrecognized link with byte-identical FIELD_ERROR_COPY', () => {
    const [display] = classifyRowsForDisplay([row({ url: 'https://example.com/foo' })]);
    expect(display?.kind).toEqual('refused');
    expect((display as { message: string }).message).toEqual(FIELD_ERROR_COPY);
  });

  it('classifies clean: page already matches classification, no removed params', () => {
    const [display] = classifyRowsForDisplay([
      row({
        page: 'linkedin__jobs-search',
        label: 'Backend roles',
        url: 'https://www.linkedin.com/jobs/search/',
      }),
    ]);
    expect(display).toEqual({
      kind: 'clean',
      page: 'linkedin__jobs-search',
      label: 'Backend roles',
    });
  });

  it('classifies cleaned: ephemeral params are stripped', () => {
    const [display] = classifyRowsForDisplay([
      row({
        page: 'linkedin__jobs-search',
        label: 'Backend roles',
        url: 'https://www.linkedin.com/jobs/search/?currentJobId=123',
      }),
    ]);
    expect(display).toEqual({
      kind: 'cleaned',
      page: 'linkedin__jobs-search',
      label: 'Backend roles',
      removedParams: ['currentJobId'],
    });
  });

  it('classifies misfiled: stored page does not match the classified page', () => {
    const [display] = classifyRowsForDisplay([
      row({
        page: 'linkedin__jobs-search-results',
        label: 'Wrong bucket',
        url: 'https://www.linkedin.com/jobs/search/',
      }),
    ]);
    expect(display).toEqual({
      kind: 'misfiled',
      page: 'linkedin__jobs-search',
      label: 'Wrong bucket',
      storedPage: 'linkedin__jobs-search-results',
    });
  });

  it('classifies a duplicate: two rows cleaning to the same url — first is clean/cleaned, second is duplicate', () => {
    const rows: SearchUrlRow[] = [
      row({
        page: 'linkedin__jobs-search',
        label: 'First',
        url: 'https://www.linkedin.com/jobs/search/?currentJobId=1',
      }),
      row({
        page: 'linkedin__jobs-search',
        label: 'Second',
        url: 'https://www.linkedin.com/jobs/search/',
      }),
    ];
    const [firstDisplay, secondDisplay] = classifyRowsForDisplay(rows);
    expect(firstDisplay).toEqual({
      kind: 'cleaned',
      page: 'linkedin__jobs-search',
      label: 'First',
      removedParams: ['currentJobId'],
    });
    expect(secondDisplay).toEqual({
      kind: 'duplicate',
      page: 'linkedin__jobs-search',
      label: 'Second',
      mergesIntoLabel: 'First',
    });
  });

  it('lets duplicate precedence beat misfiled: a duplicate row is never reported as misfiled too', () => {
    const rows: SearchUrlRow[] = [
      row({
        page: 'linkedin__jobs-search',
        label: 'First',
        url: 'https://www.linkedin.com/jobs/search/',
      }),
      row({
        page: 'linkedin__jobs-search-results',
        label: 'Second',
        url: 'https://www.linkedin.com/jobs/search/',
      }),
    ];
    const [, secondDisplay] = classifyRowsForDisplay(rows);
    expect(secondDisplay).toEqual({
      kind: 'duplicate',
      page: 'linkedin__jobs-search',
      label: 'Second',
      mergesIntoLabel: 'First',
    });
  });
});

describe('buildValidationSummaryRefusalMessage', () => {
  it('uses the given label', () => {
    expect(buildValidationSummaryRefusalMessage('Zafin')).toEqual(
      'Zafin — not a LinkedIn jobs search link',
    );
  });

  it('falls back to "This link" for an empty label', () => {
    expect(buildValidationSummaryRefusalMessage('')).toEqual(
      'This link — not a LinkedIn jobs search link',
    );
  });
});
