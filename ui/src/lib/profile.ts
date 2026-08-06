import { useCallback, useSyncExternalStore } from 'react';
import type { BoardProfile } from './api/types';

const STORAGE_KEY = 'jobbunny.profile';

export function pickProfile(
  stored: string | null,
  profiles: BoardProfile[],
): string | null {
  const names = profiles.map((p) => p.name);
  if (stored !== null && names.includes(stored)) return stored;
  return profiles.find((p) => p.connector === 'sqlite')?.name ?? names[0] ?? null;
}

let listeners: (() => void)[] = [];
function emit() {
  for (const l of listeners) l();
}

export function useStoredProfile(): [string | null, (name: string) => void] {
  const stored = useSyncExternalStore(
    (cb) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
    () => localStorage.getItem(STORAGE_KEY),
  );
  const choose = useCallback((name: string) => {
    localStorage.setItem(STORAGE_KEY, name);
    emit();
  }, []);
  return [stored, choose];
}
