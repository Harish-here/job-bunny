/**
 * cli/wire/daemon.ts — the scheduling daemon's own composition point:
 * sibling to `compose.ts`/`builders.ts`/`board.ts` in the
 * `only-wire-imports-adapters` carve-out (`.dependency-cruiser.cjs`), the
 * ONE place `ops/daemon/daemon.ts`'s `DaemonDeps.readRunHistory` function
 * is actually built from a real `SqliteRunStore` per profile.
 *
 * Why this exists: the daemon's owed-slot decision needs DURABLE evidence
 * of which scheduled slots a profile has already served — real rows in
 * that profile's own `jobbunny.db` `runs` table, read via
 * `RunStoreReader.listRunTimeDirs` (`ports/run_store.ts`). `ops/daemon`
 * may not import `src/adapters/**` itself, so it receives this as a plain
 * function; `wireDaemonRunHistory` is that function's one real build site.
 *
 * Tolerant profile.json read mirrors `wireBoard`'s own posture
 * (`board.ts`): a missing/unreadable/malformed `profile.json`, or one
 * whose `settings.sqlite` slice doesn't parse, degrades to the profile's
 * DEFAULT `jobbunny.db` path rather than throwing — the daemon's schedule
 * scan (`scanProfileSchedules`) already tolerates the same profile the
 * same way, and a broken profile must never take down a tick.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SqliteRunStore } from '../../adapters/db/sqlite/runs/index.ts';
import type { RunRecord } from '../../core/schedule/index.ts';
import { parseTimeDirSlot } from '../../core/schedule/index.ts';
import { resolveSqlitePath } from './builders.ts';

export interface DaemonWireOverrides {
  /** repo root; default `process.cwd()` — same resolution as
   * `compose.ts`/`wireBoard` in `builders.ts`/`board.ts`. */
  root?: string;
}

/** Resolves `<root>/profiles/<profile>/data/jobbunny.db`, honoring a
 * `settings.sqlite.path` override in that profile's `profile.json` — the
 * SAME default+override resolution `wireBoard`'s `resolveDbPath` and
 * `wire()`'s run store both use, re-read here (rather than shared) because
 * this module owns no `ProfileInfo`-shaped cache and re-reading a tiny
 * JSON file every tick is cheap. */
function resolveProfileDbPath(root: string, profile: string): string {
  const defaultPath = path.join(root, 'profiles', profile, 'data', 'jobbunny.db');
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(path.join(root, 'profiles', profile, 'profile.json'), 'utf8'),
    );
  } catch {
    return defaultPath; // missing/unreadable/malformed — tolerant, same posture as wireBoard.
  }
  const settings =
    parsed && typeof parsed === 'object'
      ? (parsed as { settings?: unknown }).settings
      : undefined;
  const sqliteSlice =
    settings && typeof settings === 'object'
      ? (settings as { sqlite?: unknown }).sqlite
      : undefined;
  return resolveSqlitePath(sqliteSlice, defaultPath);
}

/** Builds the daemon's `DaemonDeps.readRunHistory` function: for each
 * named profile, opens (and memoizes, for the life of the daemon process)
 * a `SqliteRunStore` over that profile's own `jobbunny.db` and reads
 * `listRunTimeDirs(date)`, converting each `time_dir` to a `RunRecord`
 * via `parseTimeDirSlot`. `SqliteRunStore` is itself fail-soft (an open
 * failure degrades it to a permanent no-op, never throws) — a profile
 * whose db doesn't exist yet (never run) or can't be opened simply
 * contributes no records, exactly like `scanProfileSchedules` tolerating
 * a broken `profile.json`. */
export function wireDaemonRunHistory(
  overrides: DaemonWireOverrides = {},
): (profiles: readonly string[], date: string) => RunRecord[] {
  const root = overrides.root ?? process.cwd();
  const stores = new Map<string, SqliteRunStore>();

  function storeFor(profile: string): SqliteRunStore {
    const existing = stores.get(profile);
    if (existing) return existing;
    const store = new SqliteRunStore(resolveProfileDbPath(root, profile));
    stores.set(profile, store);
    return store;
  }

  return (profiles, date) => {
    const records: RunRecord[] = [];
    for (const profile of profiles) {
      for (const timeDir of storeFor(profile).listRunTimeDirs(date)) {
        const startedAt = parseTimeDirSlot(timeDir);
        if (startedAt === undefined) continue;
        records.push({ profile, date, startedAt });
      }
    }
    return records;
  };
}
