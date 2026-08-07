import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'jobbunny.sidebar';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

let listeners: (() => void)[] = [];
function emit() {
  for (const l of listeners) l();
}

/**
 * Persists the sidebar's collapsed/expanded state to localStorage under
 * `jobbunny.sidebar` ('collapsed' | 'expanded'). Mirrors the
 * `useStoredProfile` pattern in `lib/profile.ts` — a module-level listener
 * list plus `useSyncExternalStore` — but wraps every localStorage access in
 * try/catch: a blocked or full store (private browsing, quota) must degrade
 * to the expanded default, never crash the shell.
 */
export function useSidebarCollapsed(): [boolean, (value: boolean) => void] {
  const collapsed = useSyncExternalStore((cb) => {
    listeners.push(cb);
    return () => {
      listeners = listeners.filter((l) => l !== cb);
    };
  }, readCollapsed);
  const setCollapsed = useCallback((value: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, value ? 'collapsed' : 'expanded');
    } catch {
      // Storage blocked or full — the in-memory listeners still fire below,
      // so the UI updates for this session even though it won't persist.
    }
    emit();
  }, []);
  return [collapsed, setCollapsed];
}
