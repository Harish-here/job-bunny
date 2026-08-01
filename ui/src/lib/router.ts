import { type Readable, writable } from 'svelte/store';

export const ROUTES = ['board', 'analytics', 'onboarding'] as const;
export type RouteName = (typeof ROUTES)[number];

export function parseHash(hash: string): RouteName {
  const name = hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  return (ROUTES as readonly string[]).includes(name) ? (name as RouteName) : 'board';
}

interface RouterWindow {
  location: { hash: string };
  addEventListener(type: 'hashchange', listener: () => void): void;
}

export interface Router {
  route: Readable<RouteName>;
  navigate(to: RouteName): void;
}

export function createRouter(win: RouterWindow): Router {
  const store = writable<RouteName>(parseHash(win.location.hash));
  win.addEventListener('hashchange', () => store.set(parseHash(win.location.hash)));
  return {
    route: { subscribe: store.subscribe },
    navigate(to) {
      win.location.hash = `#/${to}`;
    },
  };
}
