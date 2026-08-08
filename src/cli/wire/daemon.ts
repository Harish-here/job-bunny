/**
 * cli/wire/daemon.ts — the scheduling daemon's own composition point:
 * sibling to `compose.ts`/`builders.ts`/`board.ts` in the
 * `only-wire-imports-adapters` carve-out (`.dependency-cruiser.cjs`), the
 * ONE place `ops/daemon/daemon.ts`'s `DaemonDeps.readRunHistory` function
 * is actually built from a real `SqliteRunStore` per profile; also builds
 * `ops/daemon/scan/scan.ts`'s injected `readProfileJson` (config→db Phase
 * 4, Task 5 — see `wireDaemonScheduleConfig` below).
 *
 * Why `readRunHistory` exists: the daemon's owed-slot decision needs
 * DURABLE evidence of which scheduled slots a profile has already served
 * — real rows in that profile's own `jobbunny.db` `runs` table, read via
 * `RunStoreReader.listRunTimeDirs` (`ports/run_store.ts`). `ops/daemon`
 * may not import `src/adapters/**` itself, so it receives this as a plain
 * function; `wireDaemonRunHistory` is that function's one real build site.
 *
 * Resolving a profile's db path (config→db Phase 4) needs no file read at
 * all now that `settings.sqlite.path` is retired — `readRunHistory` calls
 * `canonicalDbPath` directly at its one use site; the old
 * `resolveProfileDbPath` (a `readFileSync`+`JSON.parse`+settings-walk) is
 * dead and removed (`daemon.test.ts` never named it directly).
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SqliteRunIntentStore } from '../../adapters/db/sqlite/intents/index.ts';
import { SqliteRunStore } from '../../adapters/db/sqlite/runs/index.ts';
import type { RunRecord } from '../../core/schedule/index.ts';
import { parseTimeDirSlot } from '../../core/schedule/index.ts';
import type { RunStore } from '../../ports/index.ts';
import type { PendingIntent } from '../../ports/run_intents.ts';
import { resolveHome } from '../home/index.ts';
import { canonicalDbPath, wireConfigStore } from './builders.ts';

export interface DaemonWireOverrides {
  /** the data home; default `resolveHome()` — same resolution as
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
  const root = overrides.root ?? resolveHome();
  const makeRunStore =
    overrides.makeRunStore ?? ((dbPath: string) => new SqliteRunStore(dbPath));

  return (profiles, date) => {
    const records: RunRecord[] = [];
    for (const profile of profiles) {
      const dbPath = canonicalDbPath(root, profile);
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

/** Builds the injected profile.json reader `scanProfileSchedules` needs
 * (config→db Phase 4) — same discipline as `wireDaemonRunHistory`: a
 * FRESH, readonly `ConfigStore` per call, never memoized (a transient
 * failure on one profile/tick must never blind future ticks), closed
 * before returning. `undefined` covers every "nothing to schedule"
 * case `scanProfileSchedules` already treated as skip-worthy (missing
 * DB + no legacy file — see `SqliteConfigStore`'s readonly lift mode).
 * `_profilesDir` is kept for signature symmetry with `ScanDeps`'s other
 * fields even though `wireConfigStore` derives its own path from
 * `root`+`name` — `scanProfileSchedules` is always called with
 * `profilesDir = path.join(root, 'profiles')` at its one call site
 * (`ops/daemon/daemon.ts`), so the two never diverge in practice.
 *
 * The WHOLE probe (store construction + `readText`) is wrapped in a
 * try/catch that degrades ANY failure to `undefined` — mirroring
 * `board.ts`'s `readProfileInfo` posture exactly, for the identical reason:
 * `SqliteConfigStore`'s readonly-lift path THROWS (not resolves-undefined)
 * on a malformed legacy `profile.json` when no db file exists yet (a
 * routine, realistic state — e.g. right after scaffolding, before first
 * run). Left uncaught, that throw would propagate through
 * `scanProfileSchedules`'s `await deps.readProfileJson(...)` and reject the
 * WHOLE scan — not just skip the one bad profile — silently blinding every
 * OTHER profile's schedule for every tick until the one broken
 * `profile.json` is fixed. `ops/daemon/daemon.ts`'s `tick()` catching it at
 * the top level only keeps the daemon PROCESS alive; it does not restore
 * per-profile fail-soft behavior for that tick. */
export function wireDaemonScheduleConfig(
  overrides: DaemonWireOverrides = {},
): (profilesDir: string, name: string) => Promise<string | undefined> {
  const root = overrides.root ?? resolveHome();
  return async (_profilesDir, name) => {
    const store = wireConfigStore(name, { root, liftMode: 'readonly' });
    try {
      return await store.readText('profile.json');
    } catch {
      // Any failure of the whole probe (missing db + missing legacy file,
      // a corrupt db, malformed JSON) is skip-worthy, never fatal — see
      // this function's own doc comment.
      return undefined;
    } finally {
      store.close();
    }
  };
}

/** Builds the daemon's three board-queued-intent seams (2026-08-07 addition
 * — `DaemonDeps.readIntents`/`claimIntent`/`attachIntentRun`, `ops/daemon/
 * daemon.ts`'s intent pass). Every store is opened fresh per call and
 * closed in a `finally`, matching `wireDaemonRunHistory`/
 * `wireDaemonScheduleConfig` above and for the identical reason: a
 * long-lived daemon must never let one transient failure blind a profile
 * forever. Never memoized. */
export function wireDaemonIntents(overrides: DaemonWireOverrides = {}): {
  readIntents: (now: Date) => PendingIntent[];
  claimIntent: (profile: string, intentId: number) => boolean;
  attachIntentRun: (profile: string, intentId: number, since: string) => void;
} {
  const root = overrides.root ?? resolveHome();

  return {
    readIntents(now: Date): PendingIntent[] {
      const profilesDir = path.join(root, 'profiles');
      let names: string[];
      try {
        names = readdirSync(profilesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }

      const results: PendingIntent[] = [];
      for (const name of names) {
        const dbPath = canonicalDbPath(root, name);
        // A profile that has never run has no intents and must NOT have
        // its db created (and migrated) as a side effect of a tick merely
        // checking for intents.
        if (!existsSync(dbPath)) continue;
        try {
          const store = new SqliteRunIntentStore(dbPath);
          try {
            for (const intent of store.listClaimable(now.toISOString())) {
              results.push({
                profile: name,
                intentId: intent.id,
                requestedAt: intent.requestedAt,
              });
            }
          } finally {
            store.close();
          }
        } catch {
          // One unreadable profile must never blind the others — no log,
          // no record contributed.
        }
      }

      return results.sort((a, b) => {
        const requestedCmp = a.requestedAt.localeCompare(b.requestedAt);
        return requestedCmp !== 0 ? requestedCmp : a.profile.localeCompare(b.profile);
      });
    },

    claimIntent(profile: string, intentId: number): boolean {
      const store = new SqliteRunIntentStore(canonicalDbPath(root, profile));
      try {
        return store.claim(intentId);
      } catch {
        return false;
      } finally {
        store.close();
      }
    },

    attachIntentRun(profile: string, intentId: number, since: string): void {
      try {
        const runStore = new SqliteRunStore(canonicalDbPath(root, profile));
        let runId: number | undefined;
        try {
          const runs = runStore.listRuns({ limit: 20 });
          runId = runs.find((run) => run.startedAt >= since)?.id;
        } finally {
          runStore.close();
        }
        if (runId === undefined) return;

        const intentStore = new SqliteRunIntentStore(canonicalDbPath(root, profile));
        try {
          intentStore.attachRun(intentId, runId);
        } finally {
          intentStore.close();
        }
      } catch {
        // Swallowed — see this function's own doc comment.
      }
    },
  };
}
