import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SearchUrlRow } from './searchUrls.model';
import { useSearchUrlRowEditing } from './useSearchUrlRowEditing';

function row(overrides: Partial<SearchUrlRow> = {}): SearchUrlRow {
  return { page: '', label: '', url: '', touched: false, ...overrides };
}

describe('useSearchUrlRowEditing', () => {
  it('B7: a pasted refused link does not mark the row touched (no error until blur)', () => {
    const updateRow = vi.fn();
    const { result } = renderHook(() => useSearchUrlRowEditing([row()], updateRow));

    result.current.onChangeUrl(0, 'https://www.zafin.com/careers', true);

    expect(updateRow).toHaveBeenCalledWith(0, { url: 'https://www.zafin.com/careers' });
    expect(updateRow).not.toHaveBeenCalledWith(
      0,
      expect.objectContaining({ touched: true }),
    );
  });

  it('B7: the same refused link marks the row touched on blur', () => {
    const updateRow = vi.fn();
    const refusedRow = [row({ url: 'https://www.zafin.com/careers' })];
    const { result } = renderHook(() => useSearchUrlRowEditing(refusedRow, updateRow));

    result.current.onBlurUrl(0);

    expect(updateRow).toHaveBeenCalledWith(0, {
      url: 'https://www.zafin.com/careers',
      touched: true,
    });
  });

  it('a pasted recognised link rewrites and marks touched immediately, same as blur', () => {
    const updateRow = vi.fn();
    const { result } = renderHook(() => useSearchUrlRowEditing([row()], updateRow));

    result.current.onChangeUrl(
      0,
      'https://www.linkedin.com/jobs/search/?keywords=sre&currentJobId=1',
      true,
    );

    expect(updateRow).toHaveBeenCalledWith(0, {
      url: 'https://www.linkedin.com/jobs/search/?keywords=sre',
      page: 'linkedin__jobs-search',
      touched: true,
    });
  });

  it('B8: recentlyCleaned is keyed by row index, so a dirty duplicate never bleeds onto an earlier row sharing its cleaned url', () => {
    const updateRow = vi.fn();
    const rows = [
      row({
        page: 'linkedin__jobs-search',
        url: 'https://www.linkedin.com/jobs/search/?keywords=sre',
      }),
      row({ url: 'https://www.linkedin.com/jobs/search/?keywords=sre&currentJobId=9' }),
    ];
    const { result } = renderHook(() => useSearchUrlRowEditing(rows, updateRow));

    // Row 1 (index 1) is the one that actually gets cleaned.
    result.current.onBlurUrl(1);

    expect(
      result.current.getRecentlyCleaned(
        1,
        'linkedin__jobs-search',
        'https://www.linkedin.com/jobs/search/?keywords=sre',
      ),
    ).toEqual(['currentJobId']);
    // Row 0 (the original, never rewritten) must NOT see an entry, even
    // though its url is byte-identical to row 1's cleaned url.
    expect(
      result.current.getRecentlyCleaned(
        0,
        'linkedin__jobs-search',
        'https://www.linkedin.com/jobs/search/?keywords=sre',
      ),
    ).toBeUndefined();
  });

  it('clearRecentlyCleaned empties the map', () => {
    const updateRow = vi.fn();
    const rows = [
      row({ url: 'https://www.linkedin.com/jobs/search/?keywords=sre&currentJobId=1' }),
    ];
    const { result } = renderHook(() => useSearchUrlRowEditing(rows, updateRow));

    result.current.onBlurUrl(0);
    expect(
      result.current.getRecentlyCleaned(
        0,
        'linkedin__jobs-search',
        'https://www.linkedin.com/jobs/search/?keywords=sre',
      ),
    ).toEqual(['currentJobId']);

    result.current.clearRecentlyCleaned();
    expect(
      result.current.getRecentlyCleaned(
        0,
        'linkedin__jobs-search',
        'https://www.linkedin.com/jobs/search/?keywords=sre',
      ),
    ).toBeUndefined();
  });

  it('onChangeUrl without isPaste just updates the raw url, never classifying', () => {
    const updateRow = vi.fn();
    const { result } = renderHook(() => useSearchUrlRowEditing([row()], updateRow));

    result.current.onChangeUrl(0, 'https://www.linkedin.com/jobs/search/?a=1');

    expect(updateRow).toHaveBeenCalledWith(0, {
      url: 'https://www.linkedin.com/jobs/search/?a=1',
    });
  });

  it('onBlurUrl on a missing row index is a no-op', () => {
    const updateRow = vi.fn();
    const { result } = renderHook(() => useSearchUrlRowEditing([], updateRow));

    result.current.onBlurUrl(0);

    expect(updateRow).not.toHaveBeenCalled();
  });
});
