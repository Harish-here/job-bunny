import { useSyncExternalStore } from 'react';

export const ROUTES = [
  'triage',
  'tracker',
  'runs',
  'analytics',
  'onboarding',
  'settings',
] as const;
export type RouteName = (typeof ROUTES)[number];
export type Route = { name: RouteName } | { name: 'job'; id: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'job' && parts[1])
    return { name: 'job', id: decodeURIComponent(parts[1]) };
  const name = parts[0] ?? '';
  return (ROUTES as readonly string[]).includes(name)
    ? { name: name as RouteName }
    : { name: 'triage' };
}

export function routeHash(route: Route): string {
  return route.name === 'job'
    ? `#/job/${encodeURIComponent(route.id)}`
    : `#/${route.name}`;
}

export function navigate(route: Route): void {
  window.location.hash = routeHash(route);
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}
