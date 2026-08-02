import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardProfile } from './api/types';
import { pickProfile, useStoredProfile } from './profile';

const STORAGE_KEY = 'jobbunny.profile';

function p(name: string, hasDb: boolean): BoardProfile {
  return { name, connector: 'sqlite', hasDb };
}

afterEach(() => {
  localStorage.clear();
});

describe('pickProfile', () => {
  it('prefers the stored name when it still exists', () => {
    expect(pickProfile('beta', [p('alpha', true), p('beta', false)])).toBe('beta');
  });

  it('falls back to the first profile with a local db', () => {
    expect(pickProfile('gone', [p('nodb', false), p('withdb', true)])).toBe('withdb');
  });

  it('falls back to the first profile when none has a db', () => {
    expect(pickProfile(null, [p('one', false), p('two', false)])).toBe('one');
  });

  it('yields null when there are no profiles', () => {
    expect(pickProfile(null, [])).toBeNull();
  });
});

describe('useStoredProfile', () => {
  it('reads the current stored value and null when unset', () => {
    const { result } = renderHook(() => useStoredProfile());
    expect(result.current[0]).toBeNull();
  });

  it('choose persists to localStorage and updates the hook value', () => {
    const { result } = renderHook(() => useStoredProfile());
    act(() => {
      result.current[1]('b');
    });
    expect(result.current[0]).toBe('b');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('b');
  });
});
