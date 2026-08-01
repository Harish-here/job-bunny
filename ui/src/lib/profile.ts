import { type Readable, writable } from 'svelte/store';
import type { BoardProfile } from './api/types';

const STORAGE_KEY = 'jobbunny.profile';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export interface ProfileStore {
  current: Readable<string | null>;
  init(profiles: BoardProfile[]): void;
  choose(name: string): void;
}

export function createProfileStore(storage: StorageLike): ProfileStore {
  const current = writable<string | null>(null);
  return {
    current: { subscribe: current.subscribe },
    init(profiles) {
      const stored = storage.getItem(STORAGE_KEY);
      const names = profiles.map((p) => p.name);
      const pick =
        stored !== null && names.includes(stored)
          ? stored
          : (profiles.find((p) => p.hasDb)?.name ?? names[0] ?? null);
      current.set(pick);
    },
    choose(name) {
      storage.setItem(STORAGE_KEY, name);
      current.set(name);
    },
  };
}
