import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { createRouter, parseHash } from './router';

describe('parseHash', () => {
  it.each([
    ['', 'board'],
    ['#', 'board'],
    ['#/', 'board'],
    ['#/board', 'board'],
    ['#/analytics', 'analytics'],
    ['#/onboarding', 'onboarding'],
    ['#/bogus', 'board'],
    ['#/board/extra/segments', 'board'],
  ])('maps %j to %s', (hash, expected) => {
    expect(parseHash(hash)).toBe(expected);
  });
});

function fakeWindow(initialHash: string) {
  const listeners: Array<() => void> = [];
  return {
    location: { hash: initialHash },
    addEventListener(_type: 'hashchange', listener: () => void) {
      listeners.push(listener);
    },
    fireHashChange() {
      for (const l of listeners) l();
    },
  };
}

describe('createRouter', () => {
  it('initializes from the current hash', () => {
    const win = fakeWindow('#/analytics');
    expect(get(createRouter(win).route)).toBe('analytics');
  });

  it('updates the store on hashchange', () => {
    const win = fakeWindow('');
    const router = createRouter(win);
    win.location.hash = '#/onboarding';
    win.fireHashChange();
    expect(get(router.route)).toBe('onboarding');
  });

  it('navigate writes the hash (real browsers then fire hashchange)', () => {
    const win = fakeWindow('');
    createRouter(win).navigate('analytics');
    expect(win.location.hash).toBe('#/analytics');
  });
});
