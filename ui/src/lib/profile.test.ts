import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardProfile } from './api/types';
import { pickProfile, useStoredProfile } from './profile';

const STORAGE_KEY = 'jobbunny.profile';

function p(name: string, connector: string, hasDb = true): BoardProfile {
  return { name, connector, hasDb };
}

afterEach(() => {
  localStorage.clear();
});

describe('pickProfile', () => {
  it('prefers the stored name when it still exists', () => {
    expect(pickProfile('beta', [p('alpha', 'sqlite'), p('beta', 'notion', false)])).toBe(
      'beta',
    );
  });

  it('falls back to the first sqlite-connector profile, not the first with a local db (every profile gets a jobbunny.db once it has run)', () => {
    expect(
      pickProfile('gone', [p('notion-first', 'notion'), p('sqlite-second', 'sqlite')]),
    ).toBe('sqlite-second');
  });

  it('falls back to the first profile when none is sqlite', () => {
    expect(pickProfile(null, [p('one', 'notion'), p('two', 'notion')])).toBe('one');
  });

  it('falls back to the first profile when connector is unknown ("")', () => {
    expect(pickProfile(null, [p('one', ''), p('two', 'notion')])).toBe('one');
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
