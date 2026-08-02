import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import type { BoardProfile } from './api/types';
import { createProfileStore } from './profile';

function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

function p(name: string, hasDb: boolean): BoardProfile {
  return { name, connector: 'sqlite', hasDb };
}

describe('createProfileStore', () => {
  it('init prefers the stored name when it still exists', () => {
    const store = createProfileStore(memStorage({ 'jobbunny.profile': 'beta' }));
    store.init([p('alpha', true), p('beta', false)]);
    expect(get(store.current)).toBe('beta');
  });

  it('init falls back to the first profile with a local db', () => {
    const store = createProfileStore(memStorage({ 'jobbunny.profile': 'gone' }));
    store.init([p('nodb', false), p('withdb', true)]);
    expect(get(store.current)).toBe('withdb');
  });

  it('init falls back to the first profile when none has a db', () => {
    const store = createProfileStore(memStorage());
    store.init([p('one', false), p('two', false)]);
    expect(get(store.current)).toBe('one');
  });

  it('init with no profiles yields null', () => {
    const store = createProfileStore(memStorage());
    store.init([]);
    expect(get(store.current)).toBeNull();
  });

  it('choose persists and updates', () => {
    const storage = memStorage();
    const store = createProfileStore(storage);
    store.init([p('a', true), p('b', true)]);
    store.choose('b');
    expect(get(store.current)).toBe('b');
    expect(storage.dump()).toEqual({ 'jobbunny.profile': 'b' });
  });
});
