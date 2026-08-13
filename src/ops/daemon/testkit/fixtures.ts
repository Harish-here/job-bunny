/**
 * ops/daemon/testkit/fixtures.ts — shared test fixtures for `daemon.ts`'s
 * own suite. Split out of `daemon.test.ts` (Task 6, schema-drift-alert
 * wiring) once that file reached the 800-line test-file cap with zero
 * headroom for the new schema-drift/notify cases — same precedent as
 * `adapters/lanes/linkedin/testkit/`: a fixtures module (not itself a
 * `.test.ts` file, so it is capped at 400 lines like any other
 * implementation file) that several sibling `*.test.ts` files in the same
 * folder import, rather than each redefining or one file growing past its
 * cap. `daemon.test.ts` (the original tick-loop suite) and
 * `daemon_schema_drift.test.ts` (Task 6's new schema-drift/notify suite)
 * both import from `./index.ts`.
 */
import { join } from 'node:path';
import type { ProfileSchedule } from '../../../core/schedule/index.ts';
import type { DeferredSlotRow } from '../../../ports/deferred_slots.ts';
import type { DaemonDeps, SpawnRun } from '../daemon.ts';
import type { DaemonPidfileDeps } from '../pidfile.ts';
import { acquireDaemonPidfile, readDaemonPidfile } from '../pidfile.ts';
import type { ScanDeps } from '../scan/index.ts';

export const ROOT = '/fake/root';
export const PROFILES_DIR = '/fake/profiles';

export function profilePath(name: string): string {
  return join(PROFILES_DIR, name, 'profile.json');
}

export function profileJson(
  schedule: Partial<ProfileSchedule> & { times: string[] },
): string {
  return JSON.stringify({
    connector: 'notion',
    schedule: {
      times: schedule.times,
      enabled: schedule.enabled ?? true,
      weekdays: schedule.weekdays ?? [1, 2, 3, 4, 5],
      graceMinutes: schedule.graceMinutes ?? 90,
    },
  });
}

export function fakeScanDeps(
  files: Record<string, string>,
  dirs: Record<string, string[]>,
): ScanDeps {
  return {
    readdirSync: (p) => {
      const entries = dirs[p];
      if (!entries) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return entries;
    },
    readProfileJson: async (profilesDir, name) =>
      files[join(profilesDir, name, 'profile.json')],
  };
}

export function fakePidfileDeps(): DaemonPidfileDeps {
  const files = new Map<string, string>();
  const notFound = (): never => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p) ?? notFound(),
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    writeFileSyncExclusive: (p, data) => {
      if (files.has(p)) return false;
      files.set(p, data);
      return true;
    },
    renameSync: (from, to) => {
      const content = files.get(from) ?? notFound();
      files.delete(from);
      files.set(to, content);
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
    pidIsAlive: () => true,
    now: () => new Date(),
  };
}

export function readLastTickAt(deps: DaemonDeps): string | undefined {
  return readDaemonPidfile(deps.root, deps.pidfile)?.lastTickAt;
}

/** In-memory fake mirroring `DeferredSlotStore`'s own contract (task 4) —
 * `recordDeferral` is idempotent per (runDate, slot), `markNotified` marks
 * EVERY row for a date, `listUnnotifiedDatesBefore` returns distinct dates
 * strictly before the cutoff with at least one unnotified row. Used by
 * `daemon_gate.test.ts` to exercise the T4/catch-up sequencing end-to-end
 * without a real sqlite store. */
export function fakeDeferredSlotStore(): {
  recordDeferral: DaemonDeps['recordDeferral'];
  listForDate: DaemonDeps['listForDate'];
  listUnnotifiedDatesBefore: DaemonDeps['listUnnotifiedDatesBefore'];
  markNotified: DaemonDeps['markNotified'];
  rows: Map<string, DeferredSlotRow[]>;
} {
  const rows = new Map<string, DeferredSlotRow[]>();
  return {
    rows,
    recordDeferral(profile, entry) {
      const list = rows.get(profile) ?? [];
      if (list.some((r) => r.runDate === entry.runDate && r.slot === entry.slot)) return;
      list.push({ ...entry, notifiedAt: null });
      rows.set(profile, list);
    },
    listForDate(profile, runDate) {
      return (rows.get(profile) ?? []).filter((r) => r.runDate === runDate);
    },
    listUnnotifiedDatesBefore(profile, beforeDate) {
      const dates = new Set(
        (rows.get(profile) ?? [])
          .filter((r) => r.notifiedAt === null && r.runDate < beforeDate)
          .map((r) => r.runDate),
      );
      return [...dates].sort();
    },
    markNotified(profile, runDate, notifiedAt) {
      for (const r of rows.get(profile) ?? []) {
        if (r.runDate === runDate) r.notifiedAt = notifiedAt;
      }
    },
  };
}

export function baseDeps(overrides: Partial<DaemonDeps> = {}): {
  deps: DaemonDeps;
  events: Array<{
    event: string;
    data?: Record<string, unknown>;
    level?: 'info' | 'warn' | 'error';
  }>;
} {
  const events: Array<{
    event: string;
    data?: Record<string, unknown>;
    level?: 'info' | 'warn' | 'error';
  }> = [];
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 5000, pidfile);

  const deferredStore = fakeDeferredSlotStore();

  const deps: DaemonDeps = {
    root: ROOT,
    profilesDir: PROFILES_DIR,
    scan: fakeScanDeps({}, {}),
    pidfile,
    spawnRun: (async () => 0) as SpawnRun,
    readRunHistory: () => [],
    checkSchemaDrift: () => new Map(),
    notify: async () => true,
    hasNotifierConfigured: async () => false,
    readIntents: () => [],
    claimIntent: () => true,
    attachIntentRun: () => {},
    // Reachable/no-suspend by default (regression posture — "behaves
    // exactly as today" — see daemon_gate.test.ts for the suspend/
    // unreachable-gate cases, which override this).
    probeReachable: async () => true,
    recordDeferral: deferredStore.recordDeferral,
    listForDate: deferredStore.listForDate,
    listUnnotifiedDatesBefore: deferredStore.listUnnotifiedDatesBefore,
    markNotified: deferredStore.markNotified,
    spawnCatchup: async () => 0,
    log: (event, data, level) => {
      events.push({ event, data, level });
    },
    now: () => new Date(2026, 6, 27, 14, 4), // 2026-07-27 is a Monday.
    ...overrides,
  };
  return { deps, events };
}
