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
  OwedRun,
  ProfileSchedule,
  RunRecord,
} from '../../../core/schedule/index.ts';
import { deriveExpiredUnserved, parseLocal } from '../../../core/schedule/index.ts';
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
  spawnCatchup: (
    target: OwedRun & { standingInFor: readonly string[] },
  ) => Promise<number>;
  log: (
    event: string,
    data?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ) => void;
}

/** Once per `runOwedBatch` tick, after the per-entry loop closes. Reuses
 * the SAME `activeSchedules`/`history` the caller already computed for
 * `isRunOwed` — no re-fetch. */
export async function runDeferredSweepAndCatchup(
  deps: DeferredSweepDeps,
  now: Date,
  date: string,
  activeSchedules: readonly ProfileSchedule[],
  history: readonly RunRecord[],
  gate: ReachabilityGateDecision,
): Promise<void> {
  const candidates = deriveExpiredUnserved(now, activeSchedules, history);
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

    if (!t4AlreadySentToday) {
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
      await deps.notify(profile, { kind: 'digest', profile, text });
      deps.markNotified(profile, date, now.toISOString());
    }

    if (alreadyLedgeredToday) continue;

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
