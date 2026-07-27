/**
 * ops/daemon/daemon.ts — the tick loop. Ticks every TICK_MS (D4: a fixed
 * constant, not user config — setTimeout/setInterval use a monotonic
 * clock that doesn't advance across suspend, so a fixed short interval
 * makes normal fires, downtime catch-up, and post-sleep recovery the same
 * code path), scans profile schedules and run history off disk, merges in
 * the pidfile's attempts ledger, asks the pure isRunOwed which slots are
 * owed, and spawns each owed slot's child sequentially — one Chrome/CDP
 * session exists, so two children can never run concurrently (D6).
 *
 * This module knows the clock, the run-folder ledger, and how to spawn
 * and await a child. It does NOT know about pipeline stages, adapters, or
 * the CLI — the real child spawn is injected as `SpawnRun`.
 */

import type { OwedRun, ProfileSchedule, RunRecord } from '../../core/schedule/index.ts';
import { formatLocalDate, hhMmToMinutes, isRunOwed } from '../../core/schedule/index.ts';
import type { DaemonPidfileDeps } from './pidfile.ts';
import { readDaemonPidfile, updateDaemonPidfile } from './pidfile.ts';
import type { ScanDeps } from './scan/index.ts';
import { scanProfileSchedules, scanRunHistory } from './scan/index.ts';

export const TICK_MS = 30_000;

/** Spawns `jobbunny run --profile <owed.profile> --headless` (the real
 * implementation, wired outside this module) and resolves to the child's
 * exit code once it exits. */
export type SpawnRun = (owed: OwedRun) => Promise<number>;

export interface DaemonDeps {
  root: string;
  profilesDir: string;
  scan: ScanDeps;
  pidfile: DaemonPidfileDeps;
  spawnRun: SpawnRun;
  log(event: string, data?: Record<string, unknown>): void;
  now(): Date;
}

/** Local wall-clock moment for `slot` ("HH:MM") ON `date` ("YYYY-MM-DD")
 * — built from the OWED ENTRY's OWN date, never from `now`'s own
 * calendar date (mirrors owed.ts's own `parseLocal`). A batch that runs
 * past local midnight must still evaluate each entry against the date it
 * was actually scheduled for. */
function parseSlotMoment(date: string, slot: string): Date {
  const dateParts = date.split('-');
  const timeParts = slot.split(':');
  const year = Number(dateParts[0]);
  const month = Number(dateParts[1]);
  const day = Number(dateParts[2]);
  const hour = Number(timeParts[0]);
  const minute = Number(timeParts[1]);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

export function createDaemon(deps: DaemonDeps): {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
} {
  let ticking = false;
  let timer: NodeJS.Timeout | undefined;

  async function runOwedBatch(): Promise<void> {
    const now = deps.now();
    const date = formatLocalDate(now);

    const schedules: ProfileSchedule[] = scanProfileSchedules(
      deps.profilesDir,
      deps.scan,
    );
    const profileNames = schedules.map((s) => s.profile);

    const diskHistory = scanRunHistory(deps.profilesDir, profileNames, date, deps.scan);
    const pidfile = readDaemonPidfile(deps.root, deps.pidfile);
    // D19: fold today's ledger entries in as synthetic RunRecords — this
    // is what stops a slot that crashed before its first checkpoint (no
    // run folder ever written) from respawning every tick for the rest
    // of its grace window.
    const ledgerHistory: RunRecord[] = (pidfile?.attempts ?? [])
      .filter((a) => a.date === date)
      .map((a) => ({ profile: a.profile, date: a.date, startedAt: a.slot }));

    const history = [...diskHistory, ...ledgerHistory];
    const owedRuns = isRunOwed(now, schedules, history);

    // A13: sort explicitly by (slot, profileName) — nothing upstream
    // supplies this ordering once cli/commands/schedule.ts is gone.
    const sorted = [...owedRuns].sort((a, b) => {
      const slotCmp = hhMmToMinutes(a.slot) - hhMmToMinutes(b.slot);
      return slotCmp !== 0 ? slotCmp : a.profile.localeCompare(b.profile);
    });

    for (const owed of sorted) {
      const schedule = schedules.find((s) => s.profile === owed.profile);
      const graceMinutes = schedule?.graceMinutes ?? 0;

      // Revalidate (A3): re-check the grace window immediately before
      // acting on this entry — a slow sequential predecessor earlier in
      // this same batch may have consumed this entry's own grace window
      // while it waited its turn.
      const revalidateAt = deps.now();
      const slotMoment = parseSlotMoment(owed.date, owed.slot);
      const graceEndMoment = new Date(slotMoment.getTime() + graceMinutes * 60_000);
      if (revalidateAt > graceEndMoment) {
        deps.log('slot-expired-skipped', { profile: owed.profile, slot: owed.slot });
        continue;
      }

      // Ledger BEFORE spawning — a crash between this write and the
      // spawn call still counts the slot as attempted (D19). A9: prune to
      // only today's entries on every write, not just on read (rule 5) —
      // the pidfile itself never accumulates yesterday's attempts.
      updateDaemonPidfile(
        deps.root,
        (current) => ({
          ...current,
          attempts: [
            ...current.attempts.filter((a) => a.date === owed.date),
            { profile: owed.profile, date: owed.date, slot: owed.slot },
          ],
        }),
        deps.pidfile,
      );

      deps.log('spawn', { profile: owed.profile, slot: owed.slot });
      const exitCode = await deps.spawnRun(owed);
      deps.log('child-exit', { profile: owed.profile, slot: owed.slot, exitCode });
    }
  }

  async function tick(): Promise<void> {
    // A15.1: heartbeat write is the FIRST statement, BEFORE the
    // reentrancy guard, so it runs on every 30s firing — including
    // firings the guard below short-circuits while a child is in flight.
    try {
      updateDaemonPidfile(
        deps.root,
        (current) => ({ ...current, lastTickAt: deps.now().toISOString() }),
        deps.pidfile,
      );
    } catch (err) {
      // A15.3: swallowed, never thrown out of the tick — an uncaught
      // throw here would kill the daemon (domain-1) for a domain-2-shaped
      // problem.
      deps.log('heartbeat-write-failed', { error: String(err) });
    }

    if (ticking) return;
    ticking = true;
    try {
      await runOwedBatch();
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start(): void {
      // §5.2/A15.2: an immediate first tick, BEFORE arming the interval —
      // replay evaluates at daemon start, not TICK_MS after it, and a
      // live daemon must heartbeat within 35s of being observed (the
      // steal-recheck window `serve start` uses).
      void tick();
      timer = setInterval(() => {
        void tick();
      }, TICK_MS);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
