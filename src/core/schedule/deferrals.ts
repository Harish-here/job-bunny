/**
 * core/schedule/deferrals.ts — pure deferred-sweep derivation. Given `now`,
 * every profile's schedule, and the history of what has already run today,
 * which (profile, slot) pairs have had their grace window fully close
 * without being served? Zero I/O — `now` is always a parameter, never read
 * from the wall clock internally, per CLAUDE.md's core-purity convention.
 *
 * This function is called every daemon tick (30s) for the lifetime of a
 * deferred slot's grace window (up to 180 evaluations) — see task 12
 * (step 1.11)'s `runOwedBatch()`. It is deliberately a pure re-derivation
 * from its three inputs on every call: no caching, memo, or "already
 * reported this one" state. It is therefore idempotent by construction —
 * calling it repeatedly with the same inputs always returns the same
 * candidate for a slot whose grace has expired and stays unserved. Turning
 * "returned every tick" into "recorded exactly once" is the CALLER's job,
 * via `deferred_slots`'s `recordIfAbsent` (task 4).
 */

import { graceEndAtFor, isServed, parseLocal } from './owed.ts';
import type { ProfileSchedule, RunRecord, Weekday } from './types.ts';
import { formatLocalDate } from './types.ts';

export interface DeferralCandidate {
  profile: string;
  date: string;
  slot: string;
  graceEndAt: Date;
}

/**
 * Every (profile, slot) whose grace window has fully closed as of `now`,
 * per today's schedules, that has no serving RunRecord in `history`. Mirrors
 * `isRunOwed`'s own served-check exactly, via the shared `isServed`
 * predicate and `graceEndAtFor` arithmetic in owed.ts — do not re-derive
 * either differently here. Also mirrors `isRunOwed`'s `skipNext` guard: a
 * slot the user deliberately skipped is never reported as an
 * expired-unserved candidate (it would otherwise be indistinguishable from
 * a genuine daemon-outage miss and could trigger a same-day catch-up run
 * for a slot that was skipped on purpose) — do not re-derive that
 * differently here either.
 */
export function deriveExpiredUnserved(
  now: Date,
  schedules: readonly ProfileSchedule[],
  history: readonly RunRecord[],
): DeferralCandidate[] {
  const date = formatLocalDate(now);
  const weekday = now.getDay() as Weekday;
  const candidates: DeferralCandidate[] = [];

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!schedule.weekdays.includes(weekday)) continue;

    for (const slot of schedule.times) {
      const slotAt = parseLocal(date, slot);
      const graceEndAt = graceEndAtFor(slotAt, schedule);
      if (now <= graceEndAt) continue; // grace not yet fully closed.

      // Mirrors isRunOwed's own skipNext guard exactly (owed.ts) — a
      // deliberately skipped slot ending its grace unserved is the
      // EXPECTED outcome of the skip, not an expired-unserved candidate;
      // without this it would be indistinguishable from a genuine
      // daemon-outage miss and could spawn a same-day catch-up run,
      // defeating "skipped exactly once and never runs."
      if (
        schedule.skipNext &&
        schedule.skipNext.date === date &&
        schedule.skipNext.slot === slot
      )
        continue;

      if (isServed(history, schedule.profile, date, slotAt, graceEndAt)) continue;

      candidates.push({ profile: schedule.profile, date, slot, graceEndAt });
    }
  }

  return candidates;
}
