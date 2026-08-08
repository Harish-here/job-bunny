import { useSyncExternalStore } from 'react';

export const ROUTES = [
  'triage',
  'tracker',
  'runs',
  'analytics',
  'setup',
  'onboarding',
  'settings',
] as const;
export type RouteName = (typeof ROUTES)[number];
export type SettingsSection =
  | 'profile'
  | 'schedule'
  | 'filters'
  | 'resume'
  | 'search-urls'
  | 'danger';
const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'profile',
  'schedule',
  'filters',
  'resume',
  'search-urls',
  'danger',
];
export type Route =
  | { name: RouteName }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'job'; id: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'job' && parts[1])
    return { name: 'job', id: decodeURIComponent(parts[1]) };
  const name = parts[0] ?? '';
  if (name === 'settings' && parts[1] !== undefined) {
    const section = parts[1];
    if ((SETTINGS_SECTIONS as readonly string[]).includes(section)) {
      return { name: 'settings', section: section as SettingsSection };
    }
    return { name: 'settings' };
  }
  return (ROUTES as readonly string[]).includes(name)
    ? { name: name as RouteName }
    : { name: 'triage' };
}

export function routeHash(route: Route): string {
  if (route.name === 'job') return `#/job/${encodeURIComponent(route.id)}`;
  if (route.name === 'settings' && 'section' in route)
    return `#/settings/${route.section}`;
  return `#/${route.name}`;
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
