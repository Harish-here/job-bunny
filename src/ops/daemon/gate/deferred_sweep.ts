/**
 * ops/daemon/gate/deferred_sweep.ts — the deferred-slot sweep and
 * same-day catch-up decision (blueprint `pipeline-stability-hardening`
 * step 1.11, step 4). Split out of `../daemon.ts` purely to keep that
 * file under the file-size cap — a non-behavioral split, same precedent
 * as `../alert/schema_drift.ts`'s `trackSchemaDriftAndNotify`: `daemon.ts`
 * calls `runDeferredSweepAndCatchup` exactly ONCE, at the end of
 * `runOwedBatch`, and passes its own `deps` straight through with no cast
 * (`DeferredSweepDeps` is a structural subset of `DaemonDeps`).
 *
 * Trap 4 (see task report): `deps.recordDeferral` is called ONLY from this
 * module — never from the per-owed-entry gate guard clause in `daemon.ts`
 * itself, which only logs and stamps `lastGateDecline`. Trap 1,
 * generalized to the catch-up: the catch-up's own ledger append is
 * skipped (not merely deferred) when `gate.declined` is true THIS tick —
 * ledgering while gated would permanently consume the one per-calendar-day
 * catch-up slot for a day it never actually ran (see this file's own task
 * report for why this reading of the blueprint's pseudocode was chosen).
 */
import type {
  DeferralCandidate,
  OwedRun,
  ProfileSchedule,
} from '../../../core/schedule/index.ts';
import { nextFireAt, parseLocal } from '../../../core/schedule/index.ts';
import type { DeferredSlotRow } from '../../../ports/deferred_slots.ts';
import type { NotifyEvent } from '../../../ports/notifier.ts';
import { composeDeferredDaySummary } from '../../observability/report/index.ts';
import type { DaemonPidfileDeps } from '../pidfile.ts';
import { readDaemonPidfile, updateDaemonPidfile } from '../pidfile.ts';
import type { ReachabilityGateDecision } from './reachability_gate.ts';

export interface DeferredSweepDeps {
  root: string;
  pidfile: DaemonPidfileDeps;
  recordDeferral: (
    profile: string,
    entry: Omit<DeferredSlotRow, 'decidedAt' | 'notifiedAt'> & { decidedAt: string },
  ) => void;
  listForDate: (profile: string, runDate: string) => DeferredSlotRow[];
  markNotified: (profile: string, runDate: string, notifiedAt: string) => void;
  notify: (profile: string, event: NotifyEvent) => Promise<boolean>;
  /** `runRetrospectiveDeferredSweep`'s own query surface — distinct PAST
   * dates (strictly before `date`) that still carry at least one row with
   * `notifiedAt` null. Not used by `runDeferredSweepAndCatchup` itself. */
  listUnnotifiedDatesBefore: (profile: string, beforeDate: string) => string[];
  /** step 1.11a's own catch-up check, reused here for the SAME-day spawn
   * guard (finding — a daemon restart resets the pidfile's `attempts`
   * ledger, defeating R8's "at most one catch-up per calendar day" if
   * `alreadyLedgeredToday` were the only guard): did a `kind: 'catchup'`
   * run already happen TODAY for this profile, per the durable `runs`
   * table? Structurally the same field as `DaemonDeps.hasCatchupRun` — see
   * that field's own doc comment. Never throws. */
  hasCatchupRun: (profile: string, date: string) => boolean;
  spawnCatchup: (
    target: OwedRun & { standingInFor: readonly string[] },
  ) => Promise<number>;
  log: (
    event: string,
    data?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ) => void;
}

/** Once per `runOwedBatch` tick, after the per-entry loop closes.
 * `candidates` is `deriveExpiredUnserved`'s own output, computed ONCE by
 * the caller (`daemon.ts`) — the caller needs the SAME value to size its
 * own reachability-gate probe decision (`hasOwedEntries`), so it is passed
 * in here rather than re-derived from `activeSchedules`/`history`. */
export async function runDeferredSweepAndCatchup(
  deps: DeferredSweepDeps,
  now: Date,
  date: string,
  candidates: readonly DeferralCandidate[],
  gate: ReachabilityGateDecision,
): Promise<void> {
  // Read ONCE, after the caller's own per-entry loop has already made this
  // tick's own `lastGateDecline`/ledger writes — nothing below mutates the
  // pidfile for a DIFFERENT profile than the one currently being
  // processed, so one snapshot is equivalent to re-reading per candidate.
  const pidfileNow = readDaemonPidfile(deps.root, deps.pidfile);

  for (const c of candidates) {
    const slotAt = parseLocal(c.date, c.slot);
    const declineAtMs = pidfileNow?.lastGateDecline
      ? Date.parse(pidfileNow.lastGateDecline.at)
      : Number.NaN;
    const withinGraceWindow =
      Number.isFinite(declineAtMs) &&
      declineAtMs >= slotAt.getTime() &&
      declineAtMs <= c.graceEndAt.getTime();
    const reason =
      withinGraceWindow && pidfileNow?.lastGateDecline
        ? pidfileNow.lastGateDecline
        : {
            reasonCode: 'daemon-unavailable' as const,
            reason: "Job Bunny's scheduler was not running during this scheduled window.",
          };
    deps.recordDeferral(c.profile, {
      runDate: c.date,
      slot: c.slot,
      reasonCode: reason.reasonCode,
      reason: reason.reason,
      decidedAt: now.toISOString(),
    });
  }

  if (candidates.length === 0) return;

  const affectedProfiles = [...new Set(candidates.map((c) => c.profile))];
  for (const profile of affectedProfiles) {
    const alreadyLedgeredToday = (pidfileNow?.attempts ?? []).some(
      (a) => a.profile === profile && a.date === date && a.slot === 'catchup',
    );
    const todaysRows = deps.listForDate(profile, date);
    // The T4-MESSAGE guard (`deferred_slots.notifiedAt`) — a SEPARATE
    // concern from the catch-up-SPAWN guard below (pidfile attempts
    // ledger, R8a): conflating them would tie a message-dedup bug to a
    // spawn-dedup bug or vice versa.
    const t4AlreadySentToday =
      todaysRows.length > 0 && todaysRows.every((r) => r.notifiedAt !== null);

    if (todaysRows.length === 0) {
      // `recordDeferral` (`SqliteDeferredSlotStore.recordIfAbsent`)
      // fail-softs on a SQL error (warn-once, then return) — a persistent
      // write failure leaves `listForDate` returning nothing even though
      // `candidates.length > 0` above. Without this branch,
      // `t4AlreadySentToday` would be permanently false and `notify` would
      // fire on EVERY tick (a 2,880-sends/day storm), composed against an
      // empty `slots` array the summary was never meant to render for.
      // Stay silent and log instead — the write failure is the real
      // problem, and retrying `notify` in a loop cannot fix it.
      deps.log('deferred-rows-missing', { profile, date }, 'warn');
    } else if (!t4AlreadySentToday) {
      // The same-day (live) variant always names the catch-up as starting
      // now, per the mockup's own ordering ("Catch-up run starting now —
      // digest to follow."), sent BEFORE the spawn decision below —
      // message and spawn are deliberately decoupled (see the
      // gate-declined branch below).
      const text = composeDeferredDaySummary({
        profile,
        date,
        slots: todaysRows.map((r) => ({ slot: r.slot, reasonCode: r.reasonCode })),
        catchupFired: true,
        nextRunAt: null,
      });
      // Only stamp `markNotified` when delivery actually succeeded — a
      // discarded return value here would foreclose BOTH the same-day
      // retry (below, next tick) and the retrospective backstop
      // (`listUnnotifiedDatesBefore`, since `notifiedAt` is its sole gate)
      // for one transient send failure. Mirrors `schema_drift.ts`'s own
      // `trackSchemaDriftAndNotify` posture.
      const sent = await deps.notify(profile, { kind: 'digest', profile, text });
      if (sent) deps.markNotified(profile, date, now.toISOString());
    }

    // R8's "at most one catch-up per calendar day" needs a guard that
    // survives a daemon restart — `alreadyLedgeredToday` alone does not:
    // `acquireDaemonPidfile` rewrites `attempts: []` on every `serve
    // start`, but a catch-up run deliberately starts OUTSIDE every slot
    // window, so `deriveExpiredUnserved` keeps returning the same
    // candidate and nothing durable says "a catch-up already ran today"
    // without also consulting `hasCatchupRun` (the `runs` table itself).
    if (alreadyLedgeredToday || deps.hasCatchupRun(profile, date)) continue;

    if (gate.declined) {
      // Same principle as the owed-entry gate (Trap 1), generalized: the
      // ledger records that an attempt was made, and a gate decline is
      // precisely the case where none was — ledgering here would
      // permanently consume the ONE per-day catch-up slot for a day it
      // never actually ran. Retried next tick, once the gate clears.
      deps.log('gate-declined', {
        profile,
        slot: 'catchup',
        reasonCode: gate.reasonCode,
      });
      continue;
    }

    // Ledger BEFORE spawning (R8a) — a failed spawn (nonzero exit) is
    // therefore never retried later the same day (R8b): the NEXT tick's
    // `alreadyLedgeredToday` is already true regardless of what the spawn
    // below resolves to.
    const ledgered = updateDaemonPidfile(
      deps.root,
      (current) => ({
        ...current,
        attempts: [
          ...current.attempts.filter((a) => a.date === date),
          { profile, date, slot: 'catchup' },
        ],
      }),
      deps.pidfile,
    );
    if (ledgered) {
      const standingInFor = deps.listForDate(profile, date).map((r) => r.slot);
      await deps.spawnCatchup({ profile, date, slot: 'catchup', standingInFor });
    }
  }
}

/** step 1.11a (coordinator-added, 2026-08-13) — the day-rollover backstop:
 * a lid that stays closed for a WHOLE calendar day means
 * `runDeferredSweepAndCatchup`'s own same-day T4 guard never fires for
 * that day (it only ever evaluates `today`), and no live catch-up ever
 * runs either. Retrospectively covers every PAST date still carrying
 * unnotified `deferred_slots` rows, once per tick, per scheduled profile.
 * `schedules` is the caller's FULL list (not `activeSchedules`), since a
 * profile currently excluded by today's schema-drift check can still owe
 * a summary for an earlier date. Split out of `daemon.ts` purely to keep
 * that file under the file-size cap — same non-behavioral-split precedent
 * as this file's own header comment. */
export async function runRetrospectiveDeferredSweep(
  deps: DeferredSweepDeps,
  now: Date,
  date: string,
  schedules: readonly ProfileSchedule[],
): Promise<void> {
  for (const profile of schedules.map((s) => s.profile)) {
    const staleDates = deps.listUnnotifiedDatesBefore(profile, date);
    for (const staleDate of staleDates) {
      const hadCatchup = deps.hasCatchupRun(profile, staleDate);
      // Tracks whether THIS tick actually delivered (or never needed to
      // deliver) the retrospective summary — `markNotified` below must
      // stay gated on it, mirroring the same-day T4 fix above: a
      // discarded `notify` return value would permanently foreclose "you
      // missed this day" for one transient send failure, since
      // `listUnnotifiedDatesBefore` never returns a date once
      // `markNotified` has stamped it.
      let sent = true;
      if (!hadCatchup) {
        const slots = deps.listForDate(profile, staleDate);
        const scheduleForProfile = schedules.find((s) => s.profile === profile);
        const nextRun = scheduleForProfile ? nextFireAt(now, [scheduleForProfile]) : null;
        const text = composeDeferredDaySummary({
          profile,
          date: staleDate,
          slots: slots.map((r) => ({ slot: r.slot, reasonCode: r.reasonCode })),
          catchupFired: false,
          nextRunAt: nextRun?.at.toISOString() ?? null,
        });
        sent = await deps.notify(profile, { kind: 'digest', profile, text });
      }
      // `hadCatchup` (a date already covered by a same-day T5 digest — the
      // catch-up DID eventually run, just not detected by THIS mechanism
      // until later) still needs its rows marked regardless of `sent`, so
      // the query stops returning it on future ticks (see this step's own
      // done-when case (c)); a `!hadCatchup` date is marked ONLY once its
      // own notify actually succeeded.
      if (hadCatchup || sent) {
        deps.markNotified(profile, staleDate, now.toISOString());
      }
    }
  }
}
