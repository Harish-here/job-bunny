import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSidebarCollapsed } from './useSidebarCollapsed';

const STORAGE_KEY = 'jobbunny.sidebar';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('useSidebarCollapsed', () => {
  it('defaults to expanded with empty storage', () => {
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current[0]).toBe(false);
  });

  it('reads "collapsed" from storage', () => {
    localStorage.setItem(STORAGE_KEY, 'collapsed');
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current[0]).toBe(true);
  });

  it('writes "collapsed"/"expanded" on set', () => {
    const { result } = renderHook(() => useSidebarCollapsed());

    act(() => {
      result.current[1](true);
    });
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('collapsed');

    act(() => {
      result.current[1](false);
    });
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('expanded');
  });

  it('treats a garbage stored value as expanded', () => {
    localStorage.setItem(STORAGE_KEY, 'sideways');
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current[0]).toBe(false);
  });

  it('survives a localStorage.getItem that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current[0]).toBe(false);
  });
});
