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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SqliteRunStore } from '../../adapters/db/sqlite/runs/index.ts';
import type { RunRecord } from '../../core/schedule/index.ts';
import { parseTimeDirSlot } from '../../core/schedule/index.ts';
import type { RunStore } from '../../ports/index.ts';
import { resolveSqlitePath } from './builders.ts';

export interface DaemonWireOverrides {
  /** repo root; default `process.cwd()` — same resolution as
   * `compose.ts`/`wireBoard` in `builders.ts`/`board.ts`. */
  root?: string;
  /** test-only seam: overrides how a run-history reader is constructed for
   * a resolved db path that is already known to exist. Default builds a
   * real `SqliteRunStore`. Tests use this to inject a store that behaves
   * as though a prior open/query failed, WITHOUT touching the real
   * filesystem, to prove a failure on one call never carries into the
   * next (see `readRunHistory`'s own doc comment). */
  makeRunStore?: (dbPath: string) => Pick<RunStore, 'listRunTimeDirs' | 'close'>;
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

/** Builds the daemon's `DaemonDeps.readRunHistory` function: for each named
 * profile, checks whether that profile's own `jobbunny.db` file EXISTS
 * first — a profile scheduled but never actually run yet must not have its
 * db file created (and migrated) as a side effect of a daemon tick merely
 * checking its history, so a missing file contributes no records without
 * touching the filesystem any further (mirrors `adapters/db/sqlite/
 * check.ts`'s doctor-check posture: a missing db is a normal, unopened
 * state, never itself a reason to create one).
 *
 * When the file DOES exist, this opens a FRESH `SqliteRunStore` for THIS
 * call only — never memoized across calls/ticks — reads
 * `listRunTimeDirs(date)`, converting each `time_dir` to a `RunRecord` via
 * `parseTimeDirSlot`, then closes it. Deliberately not memoized: opening a
 * lazy sqlite store costs milliseconds and ticks are infrequent, while
 * `SqliteRunStore`'s own fail-soft posture degrades a single instance to a
 * PERMANENT no-op after its first open/query failure — in a long-lived
 * daemon process, reusing the same instance across every future tick would
 * let one transient failure blind owed-slot detection for that profile
 * forever. A fresh instance per call means a failure on one tick can never
 * carry into the next. */
export function wireDaemonRunHistory(
  overrides: DaemonWireOverrides = {},
): (profiles: readonly string[], date: string) => RunRecord[] {
  const root = overrides.root ?? process.cwd();
  const makeRunStore =
    overrides.makeRunStore ?? ((dbPath: string) => new SqliteRunStore(dbPath));

  return (profiles, date) => {
    const records: RunRecord[] = [];
    for (const profile of profiles) {
      const dbPath = resolveProfileDbPath(root, profile);
      if (!existsSync(dbPath)) continue; // never run — do not create it.
      const store = makeRunStore(dbPath);
      try {
        for (const timeDir of store.listRunTimeDirs(date)) {
          const startedAt = parseTimeDirSlot(timeDir);
          if (startedAt === undefined) continue;
          records.push({ profile, date, startedAt });
        }
      } finally {
        store.close();
      }
    }
    return records;
  };
}
