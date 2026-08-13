/**
 * cli/wire/daemon_deferred.ts — `wireDaemonDeferredSlots` (step 1.10, D3b),
 * split out of `./daemon.ts` purely to keep that file under the 400-line
 * cap; a non-behavioral split, exactly like `./daemon_types.ts`. Sibling to
 * `compose.ts`/`builders.ts`/`board.ts`/`daemon.ts` in the
 * `only-wire-imports-adapters` carve-out (`.dependency-cruiser.cjs`), since
 * (unlike `daemon_types.ts`) it constructs a real `SqliteDeferredSlotStore`
 * per call. Re-exported from `./daemon.ts` for every existing import site.
 */
import { existsSync } from 'node:fs';
import { SqliteDeferredSlotStore } from '../../adapters/db/sqlite/deferred/index.ts';
import type { DeferredSlotRow } from '../../ports/deferred_slots.ts';
import { resolveHome } from '../home/index.ts';
import { canonicalDbPath } from './builders.ts';
import type { DaemonWireOverrides } from './daemon_types.ts';

/** Opens a FRESH `SqliteDeferredSlotStore` per call, never memoized (same
 * discipline as every `wireDaemon*` in `./daemon.ts`). The store (task 4)
 * is already fail-soft, so no extra try/catch is needed. Field names on
 * `wireDaemonDeferredSlots`'s return value are spread directly into
 * `DaemonDeps` and must stay exact (steps 1.11/1.11a reference them). */
function withStore<T>(
  root: string,
  profile: string,
  fn: (s: SqliteDeferredSlotStore) => T,
): T {
  const s = new SqliteDeferredSlotStore(canonicalDbPath(root, profile));
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

/** Reads via a fresh store, but ONLY if the profile's db already exists — a
 * never-run profile must not have its db created (and migrated) as a side
 * effect of a mere read, mirroring the existsSync guard on
 * `wireDaemonRunHistory`/`wireDaemonSchemaGuard`/`wireDaemonIntents.
 * readIntents` in `./daemon.ts`. `whenMissing` is returned as-is when the
 * file is absent. */
function readIfExists<T>(
  root: string,
  profile: string,
  whenMissing: T,
  fn: (s: SqliteDeferredSlotStore) => T,
): T {
  if (!existsSync(canonicalDbPath(root, profile))) return whenMissing;
  return withStore(root, profile, fn);
}

export function wireDaemonDeferredSlots(overrides: DaemonWireOverrides = {}): {
  recordDeferral: (
    profile: string,
    entry: Omit<DeferredSlotRow, 'decidedAt' | 'notifiedAt'> & { decidedAt: string },
  ) => void;
  listForDate: (profile: string, runDate: string) => DeferredSlotRow[];
  listUnnotifiedDatesBefore: (profile: string, beforeDate: string) => string[];
  markNotified: (profile: string, runDate: string, notifiedAt: string) => void;
} {
  const root = overrides.root ?? resolveHome();
  return {
    recordDeferral: (profile, entry) =>
      withStore(root, profile, (store) => store.recordIfAbsent(entry)),
    listForDate: (profile, runDate) =>
      readIfExists(root, profile, [], (s) => s.listForDate(runDate)),
    listUnnotifiedDatesBefore: (profile, beforeDate) =>
      readIfExists(root, profile, [], (s) => s.listUnnotifiedDatesBefore(beforeDate)),
    markNotified: (profile, runDate, notifiedAt) =>
      readIfExists(root, profile, undefined, (s) => s.markNotified(runDate, notifiedAt)),
  };
}
