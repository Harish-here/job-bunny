import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchUrlRow } from './SearchUrlRow';
import { FIELD_ERROR_COPY, type RowDisplay } from './searchUrlRow.classify';
import type { SearchUrlRow as SearchUrlRowModel } from './searchUrls.model';

function makeRow(overrides: Partial<SearchUrlRowModel> = {}): SearchUrlRowModel {
  return {
    page: 'linkedin__jobs-search',
    label: 'Comcast SRE',
    url: 'https://www.linkedin.com/jobs/search/?keywords=sre&location=Remote',
    touched: true,
    ...overrides,
  };
}

function renderRow(
  row: SearchUrlRowModel,
  display: RowDisplay,
  index = 0,
  overrides = {},
) {
  const props = {
    row,
    display,
    index,
    onChangeUrl: vi.fn(),
    onChangeLabel: vi.fn(),
    onBlurUrl: vi.fn(),
    onRemove: vi.fn(),
    onRemoveNow: vi.fn(),
    ...overrides,
  };
  const utils = render(<SearchUrlRow {...props} />);
  return { ...utils, props };
}

function badge(index: number) {
  return document.querySelector(`[data-qa="search-url-page-type-badge-${index}"]`);
}

function note(index: number) {
  return document.querySelector(`[data-qa="search-url-row-note-${index}"]`);
}

function error(index: number) {
  return document.querySelector(`[data-qa="search-url-error-${index}"]`);
}

describe('SearchUrlRow', () => {
  it('unclassified: no badge, no note, no error', () => {
    renderRow(makeRow({ label: '', url: '', touched: false }), { kind: 'unclassified' });
    expect(badge(0)).toBeNull();
    expect(note(0)).toBeNull();
    expect(error(0)).toBeNull();
  });

  it('clean: badge only, no note, no error', () => {
    renderRow(makeRow(), {
      kind: 'clean',
      page: 'linkedin__jobs-search',
      label: 'Comcast SRE',
    });
    expect(badge(0)?.textContent).toBe('Jobs search');
    expect(badge(0)?.getAttribute('title')).toBe(
      'Page type: Jobs search (linkedin__jobs-search)',
    );
    expect(badge(0)?.getAttribute('aria-label')).toBe(
      'Page type: Jobs search (linkedin__jobs-search)',
    );
    expect(note(0)).toBeNull();
    expect(error(0)).toBeNull();
  });

  it('cleaned: badge + muted cleaned-note, no error', () => {
    renderRow(
      makeRow({ page: 'linkedin__jobs-search-results', label: 'Zafin Platform' }),
      {
        kind: 'cleaned',
        page: 'linkedin__jobs-search-results',
        label: 'Zafin Platform',
        removedParams: ['currentJobId', 'origin', 'referralSearchId'],
      },
    );
    expect(badge(0)?.textContent).toBe('Search results');
    expect(note(0)?.textContent).toBe(
      'Cleaned — removed currentJobId, origin, referralSearchId',
    );
    expect(note(0)?.className).toContain('text-muted-foreground');
    expect(error(0)).toBeNull();
  });

  it('misfiled: badge + attention misfiled-note, no error', () => {
    renderRow(makeRow({ page: 'linkedin__jobs-search', label: 'Acme DevOps' }), {
      kind: 'misfiled',
      page: 'linkedin__jobs-search-results',
      label: 'Acme DevOps',
      storedPage: 'linkedin__jobs-search',
    });
    expect(badge(0)?.textContent).toBe('Search results');
    expect(note(0)?.textContent).toBe(
      'Saved as Jobs search — will be re-filed as Search results.',
    );
    expect(note(0)?.className).toContain('text-attention-strong');
    expect(error(0)).toBeNull();
  });

  it('duplicate: badge + attention duplicate-note + Remove now link, no error', () => {
    renderRow(makeRow({ label: 'SRE Remote' }), {
      kind: 'duplicate',
      page: 'linkedin__jobs-search',
      label: 'SRE Remote',
      mergesIntoLabel: 'Comcast SRE',
    });
    expect(badge(0)?.textContent).toBe('Jobs search');
    expect(note(0)?.textContent).toBe(
      'Same search as "Comcast SRE" after cleaning — merged on save.',
    );
    expect(note(0)?.className).toContain('text-attention-strong');
    expect(
      document.querySelector('[data-qa="search-url-duplicate-remove"]')?.textContent,
    ).toBe('Remove now');
    expect(error(0)).toBeNull();
  });

  it('refused: FieldError alone, byte-identical to ux-notes C4 copy, no badge', () => {
    renderRow(makeRow({ url: 'https://www.zafin.com/careers', label: 'Zafin' }), {
      kind: 'refused',
      message: FIELD_ERROR_COPY,
    });
    expect(badge(0)).toBeNull();
    expect(note(0)).toBeNull();
    expect(error(0)?.textContent).toBe(
      "This isn't a LinkedIn jobs search link. Paste one from linkedin.com/jobs/search, " +
        '/jobs/search-results or /jobs/collections.',
    );
    const input = document.querySelector('[data-qa="search-url-input-0"]');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-describedby')).toContain(
      'where-jobs-search-urls.0-error',
    );
  });

  it('onBlurUrl fires on blur, not on every keystroke', () => {
    const { props } = renderRow(makeRow(), {
      kind: 'clean',
      page: 'linkedin__jobs-search',
      label: 'Comcast SRE',
    });
    const input = document.querySelector(
      '[data-qa="search-url-input-0"]',
    ) as HTMLInputElement;

    fireEvent.change(input, {
      target: { value: 'https://www.linkedin.com/jobs/search/?x=1' },
    });
    expect(props.onChangeUrl).toHaveBeenCalledWith(
      'https://www.linkedin.com/jobs/search/?x=1',
    );
    expect(props.onBlurUrl).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(props.onBlurUrl).toHaveBeenCalledTimes(1);
  });

  it('onRemoveNow fires on the duplicate row link click', () => {
    const { props } = renderRow(makeRow({ label: 'SRE Remote' }), {
      kind: 'duplicate',
      page: 'linkedin__jobs-search',
      label: 'SRE Remote',
      mergesIntoLabel: 'Comcast SRE',
    });
    const link = document.querySelector(
      '[data-qa="search-url-duplicate-remove"]',
    ) as HTMLButtonElement;
    fireEvent.click(link);
    expect(props.onRemoveNow).toHaveBeenCalledTimes(1);
    expect(props.onRemove).not.toHaveBeenCalled();
  });
});
