/**
 * ops/daemon/gate/deferred_sweep/sweep.ts — the deferred-slot sweep and
 * same-day catch-up decision (blueprint `pipeline-stability-hardening`
 * step 1.11, step 4). Split out of `../../daemon.ts` purely to keep that
 * file under the file-size cap — a non-behavioral split, same precedent
 * as `../alert/schema_drift.ts`'s `trackSchemaDriftAndNotify`: `daemon.ts`
 * calls `runDeferredSweepAndCatchup` exactly ONCE, at the end of
 * `runOwedBatch`, and passes its own `deps` straight through with no cast
 * (`DeferredSweepDeps` is a structural subset of `DaemonDeps`). The
 * notify-retry throttle/prune (bug 2/6/9) lives in the sibling
 * `notify_throttle.ts`, imported directly — both files are this same
 * module's own internals; `index.ts` is the folder's public surface.
 *
 * Trap 4 (see task report): `deps.recordDeferral` is called ONLY from this
 * module — never from the per-owed-entry gate guard clause in `daemon.ts`
 * itself, which only logs and stamps `lastGateDecline`/`slotGateDeclines`.
 * Trap 1, generalized to the catch-up: the catch-up's own ledger append is
 * skipped (not merely deferred) when `gate.declined` is true THIS tick —
 * ledgering while gated would permanently consume the one per-calendar-day
 * catch-up slot for a day it never actually ran (see this file's own task
 * report for why this reading of the blueprint's pseudocode was chosen).
 */
import type {
  DeferralCandidate,
  OwedRun,
  ProfileSchedule,
} from '../../../../core/schedule/index.ts';
import { nextFireAt } from '../../../../core/schedule/index.ts';
import type { DeferredSlotRow } from '../../../../ports/deferred_slots.ts';
import type { NotifyEvent } from '../../../../ports/notifier.ts';
import { composeDeferredDaySummary } from '../../../observability/report/index.ts';
import type { DaemonPidfile, DaemonPidfileDeps } from '../../pidfile.ts';
import { readDaemonPidfile, updateDaemonPidfile } from '../../pidfile.ts';
import type { ReachabilityGateDecision } from '../reachability_gate.ts';
import { isNotifyThrottled, stampNotifyAttempt } from './notify_throttle.ts';

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

/** Bug 1 (pipeline-stability-hardening QA, 2026-08-14) — the reason a given
 * expired-unserved candidate is actually attributed to, in priority order:
 * (1) a per-slot record in `slotGateDeclines` — the most precise source,
 * written by `applyGateDecline` on a tick where THIS exact slot was still
 * owed (within grace) and gate-declined; (2) THIS tick's own live `gate`,
 * when it is currently declined — covers the canonical whole-window-asleep
 * case: zero ticks fire while the host is suspended, so no per-slot record
 * was ever written for slots whose grace fully closed during the outage,
 * and the FIRST tick after waking (the one processing them as expired
 * candidates) is the only observation available, itself declined for
 * exactly the reason the outage was; (3) `daemon-unavailable` — genuinely
 * no evidence either way (the daemon process itself was not running, no
 * suspend gap detected, nothing declined this tick either). Never uses a
 * stale cross-slot value: `slotGateDeclines` is keyed per (profile, date,
 * slot), and (2) only ever applies to candidates evaluated on the SAME
 * tick as the live gate reading — never reused across ticks (contrast the
 * old, buggy single rolling `lastGateDecline` field this replaces). */
function attributeReason(
  pidfileNow: DaemonPidfile | undefined,
  gate: ReachabilityGateDecision,
  c: DeferralCandidate,
): { reasonCode: DeferredSlotRow['reasonCode']; reason: string } {
  const perSlot = (pidfileNow?.slotGateDeclines ?? []).find(
    (d) => d.profile === c.profile && d.date === c.date && d.slot === c.slot,
  );
  if (perSlot) return { reasonCode: perSlot.reasonCode, reason: perSlot.reason };
  if (gate.declined && gate.reasonCode && gate.reason) {
    return { reasonCode: gate.reasonCode, reason: gate.reason };
  }
  return {
    reasonCode: 'daemon-unavailable',
    reason: "Job Bunny's scheduler was not running during this scheduled window.",
  };
}

/** Once per `runOwedBatch` tick, after the per-entry loop closes.
 * `candidates` is `deriveExpiredUnserved`'s own output, computed ONCE by
 * the caller (`daemon.ts`) — the caller needs the SAME value to size its
 * own reachability-gate probe decision (`hasOwedEntries`), so it is passed
 * in here rather than re-derived from `activeSchedules`/`history`.
 *
 * `catchupGateFresh` (bug 7, pipeline-stability-hardening QA, 2026-08-14,
 * default `true`): whether `gate` for THIS tick reflects a fresh
 * suspend-check/probe, or a cached decision `daemon.ts` reused to avoid
 * re-probing DNS on every tick for an already-declined, catch-up-only
 * batch. `false` suppresses the catch-up's own `gate-declined` log line
 * below (already logged when the cache was first populated) — never
 * suppresses anything else; the log/probe throttle is purely a catch-up
 * concern. */
export async function runDeferredSweepAndCatchup(
  deps: DeferredSweepDeps,
  now: Date,
  date: string,
  candidates: readonly DeferralCandidate[],
  gate: ReachabilityGateDecision,
  catchupGateFresh = true,
): Promise<void> {
  // Read ONCE, after the caller's own per-entry loop has already made this
  // tick's own `lastGateDecline`/`slotGateDeclines`/ledger writes — nothing
  // below mutates the pidfile for a DIFFERENT profile than the one
  // currently being processed, so one snapshot is equivalent to re-reading
  // per candidate.
  const pidfileNow = readDaemonPidfile(deps.root, deps.pidfile);

  for (const c of candidates) {
    const { reasonCode, reason } = attributeReason(pidfileNow, gate, c);
    deps.recordDeferral(c.profile, {
      runDate: c.date,
      slot: c.slot,
      reasonCode,
      reason,
      decidedAt: now.toISOString(),
    });
  }

  if (candidates.length === 0) return;

  const affectedProfiles = [...new Set(candidates.map((c) => c.profile))];
  for (const profile of affectedProfiles) {
    const alreadyLedgeredToday = (pidfileNow?.attempts ?? []).some(
      (a) => a.profile === profile && a.date === date && a.slot === 'catchup',
    );
    // Bug 5 (pipeline-stability-hardening QA, 2026-08-14): whether a
    // catch-up for TODAY has already fired — either this process's own
    // pidfile ledger, or (surviving a daemon restart) the durable `runs`
    // table. Drives the T4 message's own `catchupFired` field below: "a
    // catch-up is starting now" is only true the FIRST time, before one has
    // actually run — a later same-day retry (e.g. the first send attempt
    // failed) must not keep claiming a fresh catch-up is starting when the
    // day's one catch-up already fired.
    const hasCatchupToday = alreadyLedgeredToday || deps.hasCatchupRun(profile, date);
    const todaysRows = deps.listForDate(profile, date);
    // The T4-MESSAGE guard (`deferred_slots.notifiedAt`) — a SEPARATE
    // concern from the catch-up-SPAWN guard below (pidfile attempts
    // ledger, R8a): conflating them would tie a message-dedup bug to a
    // spawn-dedup bug or vice versa.
    const t4AlreadySentToday =
      todaysRows.length > 0 && todaysRows.every((r) => r.notifiedAt !== null);

    if (todaysRows.length === 0) {
      // Bug 6 (pipeline-stability-hardening QA, 2026-08-14):
      // `recordDeferral` (`SqliteDeferredSlotStore.recordIfAbsent`)
      // fail-softs on a SQL error (warn-once, then return) — a persistent
      // write failure leaves `listForDate` returning nothing even though
      // `candidates.length > 0` above. Both halves of the old bug fixed
      // here: the WARN log is now interval-throttled (was every tick,
      // ~2,880/day) via the SAME `isNotifyThrottled` gate as the notify
      // attempt below it, AND the day still produces a message —
      // reconstructed from `candidates` (already in memory this tick,
      // never touches the broken write path) rather than the empty DB
      // read, so a persistent write failure no longer silently loses the
      // whole day.
      if (!isNotifyThrottled(pidfileNow, profile, date, now)) {
        deps.log('deferred-rows-missing', { profile, date }, 'warn');
        stampNotifyAttempt(deps.root, deps.pidfile, profile, date, now);
        const slots = candidates
          .filter((c) => c.profile === profile)
          .map((c) => ({
            slot: c.slot,
            reasonCode: attributeReason(pidfileNow, gate, c).reasonCode,
          }));
        const text = composeDeferredDaySummary({
          profile,
          date,
          slots,
          catchupFired: !hasCatchupToday,
          nextRunAt: null,
        });
        const sent = await deps.notify(profile, { kind: 'digest', profile, text });
        if (sent) deps.markNotified(profile, date, now.toISOString());
      }
    } else if (!t4AlreadySentToday) {
      // The same-day (live) variant names the catch-up as starting now
      // (bug 5: only when one hasn't already fired today), per the
      // mockup's own ordering ("Catch-up run starting now — digest to
      // follow."), sent BEFORE the spawn decision below — message and
      // spawn are deliberately decoupled (see the gate-declined branch
      // below). Bug 2: the attempt itself is now interval-throttled — see
      // `isNotifyThrottled`'s own doc comment for why a SUCCEEDING notify
      // is not, by itself, reason enough to stop stamping this throttle.
      if (!isNotifyThrottled(pidfileNow, profile, date, now)) {
        stampNotifyAttempt(deps.root, deps.pidfile, profile, date, now);
        const text = composeDeferredDaySummary({
          profile,
          date,
          slots: todaysRows.map((r) => ({ slot: r.slot, reasonCode: r.reasonCode })),
          catchupFired: !hasCatchupToday,
          nextRunAt: null,
        });
        const sent = await deps.notify(profile, { kind: 'digest', profile, text });
        if (sent) deps.markNotified(profile, date, now.toISOString());
      }
    }

    // R8's "at most one catch-up per calendar day" needs a guard that
    // survives a daemon restart — `alreadyLedgeredToday` alone does not:
    // `acquireDaemonPidfile` rewrites `attempts: []` on every `serve
    // start`, but a catch-up run deliberately starts OUTSIDE every slot
    // window, so `deriveExpiredUnserved` keeps returning the same
    // candidate and nothing durable says "a catch-up already ran today"
    // without also consulting `hasCatchupRun` (the `runs` table itself).
    if (hasCatchupToday) continue;

    if (gate.declined) {
      // Same principle as the owed-entry gate (Trap 1), generalized: the
      // ledger records that an attempt was made, and a gate decline is
      // precisely the case where none was — ledgering here would
      // permanently consume the ONE per-day catch-up slot for a day it
      // never actually ran. Retried next tick, once the gate clears. Bug 7
      // (pipeline-stability-hardening QA, 2026-08-14): only logged when
      // `catchupGateFresh` — a reused, cached decline (see this
      // function's own doc comment) was already logged the tick it was
      // first observed.
      if (catchupGateFresh) {
        deps.log('gate-declined', {
          profile,
          slot: 'catchup',
          reasonCode: gate.reasonCode,
        });
      }
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
  const pidfileNow = readDaemonPidfile(deps.root, deps.pidfile);
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
        // Bug 2 (pipeline-stability-hardening QA, 2026-08-14): the SAME
        // interval throttle as the same-day T4 path above — without it,
        // this retries every tick for every stale date, unbounded.
        if (isNotifyThrottled(pidfileNow, profile, staleDate, now)) continue;
        stampNotifyAttempt(deps.root, deps.pidfile, profile, staleDate, now);
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
