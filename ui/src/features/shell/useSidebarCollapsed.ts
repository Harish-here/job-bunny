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
 * Test-only seam: clears the in-memory `override` set when a prior test's
 * `localStorage.setItem` mock threw. Without this, `override` leaks across
 * cases in the same module instance — unreachable from outside since it's
 * module-private state with no other write path. Runtime behavior (the
 * override's own set/clear lifecycle in `setCollapsed`) is unchanged.
 */
export function resetSidebarCollapsedForTests(): void {
  override = null;
  emit();
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
