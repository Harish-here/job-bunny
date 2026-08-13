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
import {
  deriveExpiredUnserved,
  formatLocalDate,
  hhMmToMinutes,
  isRunOwed,
  parseLocal,
} from '../../core/schedule/index.ts';
import { trackSchemaDriftAndNotify } from './alert/index.ts';
import type { DaemonDeps } from './deps.ts';
import type { CatchupGateCache, ReachabilityGateDecision } from './gate/index.ts';
import {
  applyGateDecline,
  computeCatchupOnlyGate,
  computeReachabilityGate,
  runDeferredSweepAndCatchup,
  runRetrospectiveDeferredSweep,
} from './gate/index.ts';
import { readDaemonPidfile, updateDaemonPidfile } from './pidfile.ts';
import { scanProfileSchedules } from './scan/index.ts';

export type { DaemonDeps, SpawnRun } from './deps.ts';

/** step 1.12 — the real spawn executor's widened parameter type: a plain
 * `OwedRun` for a normal scheduled slot, or an `OwedRun` carrying
 * `standingInFor` for a catch-up run standing in for one or more slots a
 * closed lid deferred. Discriminated STRUCTURALLY (`'standingInFor' in
 * owed`), not by a `kind` tag — `createSpawnRun` (`ops/daemon/supervise/
 * supervise.ts`) branches on presence at runtime. */
export type SpawnTarget = OwedRun | (OwedRun & { standingInFor: readonly string[] });

export const TICK_MS = 30_000;

export function createDaemon(deps: DaemonDeps): {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
} {
  let ticking = false;
  // Bug 7 — catch-up-only tick gate cache; see `computeCatchupOnlyGate`'s
  // own doc comment (`gate/reachability_gate.ts`) for why it lives here.
  let catchupGateCache: CatchupGateCache | undefined;
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

  async function runOwedBatch(previousLastTickAt: string | undefined): Promise<void> {
    const now = deps.now();
    const date = formatLocalDate(now);

    // Board-queued intents run FIRST, before the schedule batch — a human
    // is waiting on an intent, while a scheduled slot has a grace window
    // measured in tens of minutes. Intents are deliberately kept OUT of
    // isRunOwed, the pidfile attempts ledger, and the grace revalidation
    // below: those three mechanisms answer "has this SCHEDULED SLOT been
    // served?", and an intent serves no slot.
    for (const intent of deps.readIntents(now)) {
      if (stopping) {
        deps.log('stop-requested-batch-halted', {
          profile: intent.profile,
          intentId: intent.intentId,
        });
        break;
      }
      if (!deps.claimIntent(intent.profile, intent.intentId)) {
        deps.log('intent-vanished', {
          profile: intent.profile,
          intentId: intent.intentId,
        });
        continue;
      }
      const since = deps.now().toISOString();
      deps.log('intent-spawn', { profile: intent.profile, intentId: intent.intentId });
      const exitCode = await deps.spawnRun({
        profile: intent.profile,
        date: formatLocalDate(now),
        // Not an HH:MM slot on purpose: an intent run serves no scheduled
        // slot, is never written to the attempts ledger, and this string
        // is never parsed as a time.
        slot: 'intent',
      });
      deps.log('child-exit', {
        profile: intent.profile,
        slot: 'intent',
        exitCode,
      });
      try {
        deps.attachIntentRun(intent.profile, intent.intentId, since);
      } catch (err) {
        deps.log(
          'intent-attach-failed',
          {
            profile: intent.profile,
            intentId: intent.intentId,
            error: String(err),
          },
          'warn',
        );
      }
    }

    const schedules: ProfileSchedule[] = await scanProfileSchedules(
      deps.profilesDir,
      deps.scan,
    );
    // Phase 0 (D2 self-heal): a profile whose db schema is newer than
    // this build's LATEST_SCHEMA_VERSION is excluded from spawning
    // entirely THIS tick — never blindly respawned into a throw it
    // cannot recover from (R15). checkSchemaDrift itself never throws.
    const schemaDrift = deps.checkSchemaDrift(schedules.map((s) => s.profile));
    const activeSchedules = schedules.filter((s) => !schemaDrift.has(s.profile));
    const profileNames = activeSchedules.map((s) => s.profile);

    // Phase 0 (D2 self-heal): track newly-degraded profiles in the
    // pidfile and dispatch the single, daemon-level T6 alert (AC14).
    await trackSchemaDriftAndNotify(deps, schemaDrift, schedules, now);

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
    const owedRuns = isRunOwed(now, activeSchedules, history);

    // A13: sort explicitly by (slot, profileName) — nothing upstream
    // supplies this ordering once cli/commands/schedule.ts is gone.
    const sorted = [...owedRuns].sort((a, b) => {
      const slotCmp = hhMmToMinutes(a.slot) - hhMmToMinutes(b.slot);
      return slotCmp !== 0 ? slotCmp : a.profile.localeCompare(b.profile);
    });

    // Also computed here, BEFORE the reachability gate: `deriveExpiredUnserved`
    // (grace fully closed, unserved) and `isRunOwed` (grace still open) are
    // provably disjoint, so a tick that fires ONLY a catch-up (no owed
    // entries at all) used to skip the probe entirely — R2's "before
    // spawning, the daemon runs a bounded external reachability probe"
    // never covered the catch-up path it exists for. Passed straight
    // through to `runDeferredSweepAndCatchup` below so it is derived once.
    const expired = deriveExpiredUnserved(now, activeSchedules, history);

    // step 1.11 (D1/D1b/D3b) — computed ONCE per batch (`gate/
    // reachability_gate.ts`): a suspend gap or unreachable network
    // declines every owed entry THIS tick. Reused by the catch-up below.
    // Bug 7: a catch-up-ONLY tick uses `computeCatchupOnlyGate` instead —
    // see its own doc comment.
    let gate: ReachabilityGateDecision;
    let catchupGateFresh = true; // suppresses the catch-up's own log line on a cache hit.
    if (sorted.length === 0 && expired.length > 0) {
      const result = await computeCatchupOnlyGate(
        catchupGateCache,
        now,
        previousLastTickAt,
        deps.probeReachable,
      );
      gate = result.gate;
      catchupGateCache = result.cache;
      catchupGateFresh = result.fresh;
    } else {
      gate = await computeReachabilityGate(
        previousLastTickAt,
        now,
        sorted.length > 0 || expired.length > 0,
        deps.probeReachable,
      );
    }

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

      // R3/AC3 — the FIRST guard an owed entry can hit, strictly before
      // the grace-revalidate/ledger-append blocks below: a gated entry
      // leaves NO ledger entry (Trap 1's opposite-of-R8a rule). Never
      // calls `recordDeferral` here (Trap 4) — only the post-loop
      // deferred sweep does, once a slot's grace has fully closed.
      if (gate.declined) {
        applyGateDecline(
          deps.root,
          deps.pidfile,
          deps.log,
          owed.profile,
          owed.date,
          owed.slot,
          gate,
          now,
        );
        continue; // no ledger append happens below this line for a gated entry.
      }

      const schedule = schedules.find((s) => s.profile === owed.profile);
      const graceMinutes = schedule?.graceMinutes ?? 0;

      // Revalidate (A3): re-check the grace window immediately before
      // acting on this entry — a slow sequential predecessor earlier in
      // this same batch may have consumed this entry's own grace window
      // while it waited its turn. `parseLocal` uses the OWED ENTRY's OWN
      // date, never `now`'s own calendar date (a batch that runs past
      // local midnight must still evaluate against the scheduled date).
      const revalidateAt = deps.now();
      const slotMoment = parseLocal(owed.date, owed.slot);
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

    // step 1.11, once at the end of the batch (`gate/deferred_sweep.ts`):
    // records slots whose grace fully closed unserved, then decides
    // whether TODAY's catch-up should fire (R8/R8a/R8b/Trap 5). Reuses the
    // SAME `expired` candidates computed above for the reachability gate —
    // no re-derivation. `deps` passes straight through, no cast (structural
    // subset, same precedent as `trackSchemaDriftAndNotify` above).
    await runDeferredSweepAndCatchup(deps, now, date, expired, gate, catchupGateFresh);

    // step 1.11a (coordinator-added, 2026-08-13), split into
    // `gate/deferred_sweep.ts`'s `runRetrospectiveDeferredSweep` purely to
    // keep this file under the file-size cap (non-behavioral split, same
    // precedent as `runDeferredSweepAndCatchup` above) — the day-rollover
    // backstop: a lid that stays closed for a WHOLE calendar day means
    // step 1.11's own T4 guard never fires for that day (it only ever
    // evaluates `today`), and no live catch-up ever runs either. Iterates
    // the FULL `schedules` list (not `activeSchedules`), since a profile
    // currently excluded by today's schema-drift check can still owe a
    // summary for an earlier date.
    await runRetrospectiveDeferredSweep(deps, now, date, schedules);
  }

  async function tick(): Promise<void> {
    // step 1.11 (D1): capture the pre-tick heartbeat before it's
    // overwritten below — the gate measures elapsed time since THIS value.
    // Undefined (first tick, unreadable pidfile) fail-opens to "not
    // suspected" (§8 Failure Semantics).
    let previousLastTickAt: string | undefined;
    try {
      previousLastTickAt = readDaemonPidfile(deps.root, deps.pidfile)?.lastTickAt;
    } catch {
      previousLastTickAt = undefined;
    }

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
      await runOwedBatch(previousLastTickAt);
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
