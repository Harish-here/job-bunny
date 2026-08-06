/**
 * ops/daemon/daemon.ts — the tick loop. Ticks every TICK_MS (D4: a fixed
 * constant, not user config — setTimeout/setInterval use a monotonic
 * clock that doesn't advance across suspend, so a fixed short interval
 * makes normal fires, downtime catch-up, and post-sleep recovery the same
 * code path), scans profile schedules plus each profile's own durable run
 * history (`DaemonDeps.readRunHistory` — real implementation: `cli/wire/
 * daemon.ts`'s `wireDaemonRunHistory`, over that profile's own `runs`
 * table), merges in the pidfile's attempts ledger, asks the pure
 * isRunOwed which slots are owed, and spawns each owed slot's child
 * sequentially — one Chrome/CDP session exists, so two children can
 * never run concurrently (D6).
 *
 * `readRunHistory` is a plain injected FUNCTION, never an adapter import
 * here (`only-wire-imports-adapters` — this module lives under `src/ops`,
 * which may not import `src/adapters/**`): the real `SqliteRunStore` reads
 * happen in `cli/wire/daemon.ts`, the one place allowed to construct one.
 * This module knows the clock, the pidfile ledger, and how to spawn and
 * await a child. It does NOT know about pipeline stages, adapters, or the
 * CLI — the real child spawn is injected as `SpawnRun`.
 *
 * Historical note: this used to scan `<profile>/data/runs/<date>/` FOLDER
 * names off disk (`scanRunHistory`, retired) for the same evidence. Those
 * folders stopped being written once checkpoints moved into `jobbunny.db`
 * (Phase 2) — a disk scan that always found nothing was silently
 * dead-weight (worse: it made a daemon restart within `graceMinutes`
 * re-spawn every slot the pidfile's own ledger had already forgotten, a
 * genuine duplicate-run bug this `readRunHistory` injection closes).
 */

import type { OwedRun, ProfileSchedule, RunRecord } from '../../core/schedule/index.ts';
import { formatLocalDate, hhMmToMinutes, isRunOwed } from '../../core/schedule/index.ts';
import type { DaemonPidfileDeps } from './pidfile.ts';
import { readDaemonPidfile, updateDaemonPidfile } from './pidfile.ts';
import type { ScanDeps } from './scan/index.ts';
import { scanProfileSchedules } from './scan/index.ts';

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
  /** Each named profile's own durable run history for `date` — real
   * evidence from that profile's `jobbunny.db` `runs` table
   * (`RunStoreReader.listRunTimeDirs`, via `cli/wire/daemon.ts`'s
   * `wireDaemonRunHistory`), NOT the pidfile ledger (`ledgerHistory`
   * below is folded in separately) and NOT a filesystem scan (there is no
   * on-disk run folder to scan post-Phase-2). Must never throw — a
   * profile whose db can't be opened yields no records for it. */
  readRunHistory: (profiles: readonly string[], date: string) => RunRecord[];
  log(
    event: string,
    data?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ): void;
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
  // D10, relocated: `serve stop` kills the daemon BEFORE the in-flight
  // child precisely so the daemon's own `await deps.spawnRun(...)` can
  // never resolve and spawn the NEXT owed entry. That ordering only holds
  // while the daemon is dying from an actual signal; a `stop()` that
  // merely clears the interval would still leave an already-running batch
  // free to march on to its next entry. This flag closes that window:
  // once stop() is called the CURRENT child is left to finish (or be
  // escalated past by `serve stop`'s own SIGTERM/SIGKILL), but no further
  // entry is ever begun.
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  async function runOwedBatch(): Promise<void> {
    const now = deps.now();
    const date = formatLocalDate(now);

    const schedules: ProfileSchedule[] = scanProfileSchedules(
      deps.profilesDir,
      deps.scan,
    );
    const profileNames = schedules.map((s) => s.profile);

    // The daemon's DURABLE evidence — each named profile's own `runs` table,
    // real rows that survive a daemon restart (unlike the pidfile ledger
    // below, which resets every `serve stop`/`serve start`).
    const dbHistory = deps.readRunHistory(profileNames, date);
    const pidfile = readDaemonPidfile(deps.root, deps.pidfile);
    // D19: fold today's ledger entries in as synthetic RunRecords — this
    // is what stops a slot that crashed before its first checkpoint (no
    // `runs` row ever written) from respawning every tick for the rest
    // of its grace window, WITHIN this daemon process's own lifetime.
    const ledgerHistory: RunRecord[] = (pidfile?.attempts ?? [])
      .filter((a) => a.date === date)
      .map((a) => ({ profile: a.profile, date: a.date, startedAt: a.slot }));

    const history = [...dbHistory, ...ledgerHistory];
    const owedRuns = isRunOwed(now, schedules, history);

    // A13: sort explicitly by (slot, profileName) — nothing upstream
    // supplies this ordering once cli/commands/schedule.ts is gone.
    const sorted = [...owedRuns].sort((a, b) => {
      const slotCmp = hhMmToMinutes(a.slot) - hhMmToMinutes(b.slot);
      return slotCmp !== 0 ? slotCmp : a.profile.localeCompare(b.profile);
    });

    for (const owed of sorted) {
      // Checked BEFORE this entry's revalidate/ledger/spawn sequence, so a
      // stop() that lands mid-batch neither ledgers nor spawns the entry it
      // interrupts — that slot stays genuinely unattempted and is owed again
      // (grace permitting) whenever a daemon next runs.
      if (stopping) {
        deps.log('stop-requested-batch-halted', {
          profile: owed.profile,
          slot: owed.slot,
        });
        break;
      }

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
      const ledgered = updateDaemonPidfile(
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
      // A vanished or corrupt pidfile makes that append a silent no-op —
      // and a no-op ledger reopens the exact respawn storm D19 closed: the
      // slot stays owed, so a profile whose run dies before its first
      // checkpoint would be respawned every 30s for its whole grace
      // window. No ledger, no spawn: skip the entry instead. The next tick
      // re-evaluates, and a pidfile restored by then serves it normally.
      if (!ledgered) {
        deps.log(
          'ledger-append-failed-skipping',
          {
            profile: owed.profile,
            slot: owed.slot,
          },
          'warn',
        );
        continue;
      }

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
      deps.log('heartbeat-write-failed', { error: String(err) }, 'warn');
    }

    // Placed AFTER the heartbeat write (A15.1 is untouchable: the
    // heartbeat runs on every firing, whatever the guards below decide)
    // and alongside the reentrancy guard: a tick that fires between
    // stop() and process exit must not open a new batch.
    if (stopping) return;
    if (ticking) return;
    ticking = true;
    try {
      await runOwedBatch();
    } catch (err) {
      // Same containment rationale as the heartbeat swallow above: in
      // production this runs inside a bare setInterval callback, where an
      // escaping rejection kills the daemon (domain 1) over a single bad
      // batch (domain 2). Log it and let the next tick re-evaluate.
      deps.log('tick-failed', { error: String(err) }, 'error');
    } finally {
      // Released whether the batch succeeded, threw, or was skipped — a
      // stuck `ticking` would silently retire the daemon.
      ticking = false;
    }
  }

  return {
    tick,
    start(): void {
      // Idempotent: a second start() must not leak the first interval —
      // that one would keep firing with no handle left to clear it, and
      // stop() would only ever cancel the second.
      if (timer) return;
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
      // Set BEFORE clearing the interval: an in-flight batch must observe
      // it at its very next entry boundary, and a tick already queued on
      // the event loop must short-circuit rather than start a batch the
      // cleared interval can no longer be blamed for.
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
