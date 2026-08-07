import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'jobbunny.sidebar';

// Set whenever `setItem` throws (storage blocked or full) so this session's
// state still tracks the latest `setCollapsed` call even though it can't
// persist. `readCollapsed` — the `useSyncExternalStore` snapshot — checks
// this before falling back to localStorage, otherwise a re-read after a
// failed write would just reproduce the stale/default value and the UI
// wouldn't move.
let override: boolean | null = null;

function readCollapsed(): boolean {
  if (override !== null) return override;
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
      override = null;
    } catch {
      // Storage blocked or full — keep tracking the requested value in
      // memory for this session; it just won't survive a reload.
      override = value;
    }
    emit();
  }, []);
  return [collapsed, setCollapsed];
}
