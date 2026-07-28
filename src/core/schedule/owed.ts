/**
 * core/schedule/owed.ts — the pure decision at the heart of the
 * scheduling daemon: given `now`, every profile's schedule, and the
 * history of what has already run today, which (profile, slot) pairs are
 * owed right now? Zero I/O — `now` is always a parameter, never read from
 * the wall clock internally, per CLAUDE.md's core-purity convention.
 */

import type { OwedRun, ProfileSchedule, RunRecord, Weekday } from './types.ts';
import { formatLocalDate, hhMmToMinutes } from './types.ts';

/** Local wall-clock moment for `time` ("HH:MM") on `date` ("YYYY-MM-DD").
 * No UTC conversion anywhere in this file — see types.ts's module doc
 * comment for why that distinction matters here specifically. */
function parseLocal(date: string, time: string): Date {
  const dateParts = date.split('-');
  const timeParts = time.split(':');
  const year = Number(dateParts[0]);
  const month = Number(dateParts[1]);
  const day = Number(dateParts[2]);
  const hour = Number(timeParts[0]);
  const minute = Number(timeParts[1]);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/**
 * A slot (profile, date, time) is owed at `now` iff: the profile is
 * enabled; `now`'s local weekday is in schedule.weekdays; `now` is at or
 * after the slot and at or before slot+graceMinutes; and no RunRecord
 * (real run folder OR synthetic attempts-ledger entry — the daemon merges
 * both into `history` before calling this) falls in that same window.
 * Only `now`'s own local calendar date is ever evaluated — no
 * midnight-straddling grace (accepted scope limit, see spec §5.1).
 */
export function isRunOwed(
  now: Date,
  schedules: readonly ProfileSchedule[],
  history: readonly RunRecord[],
): OwedRun[] {
  const date = formatLocalDate(now);
  const weekday = now.getDay() as Weekday;
  const owed: OwedRun[] = [];

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!schedule.weekdays.includes(weekday)) continue;

    for (const slot of schedule.times) {
      const slotAt = parseLocal(date, slot);
      const graceEndAt = new Date(slotAt.getTime() + schedule.graceMinutes * 60_000);
      if (now < slotAt || now > graceEndAt) continue;

      const served = history.some((record) => {
        if (record.profile !== schedule.profile || record.date !== date) return false;
        const startedAt = parseLocal(date, record.startedAt);
        return startedAt >= slotAt && startedAt <= graceEndAt;
      });
      if (served) continue;

      owed.push({ profile: schedule.profile, date, slot });
    }
  }

  // Rule 5: sort ascending by (slot, profileName) — the daemon's own
  // sequential-execution loop (Task 7) relies on this ordering rather than
  // re-deriving it, but isRunOwed guarantees it here regardless.
  owed.sort((a, b) => {
    const slotCmp = hhMmToMinutes(a.slot) - hhMmToMinutes(b.slot);
    return slotCmp !== 0 ? slotCmp : a.profile.localeCompare(b.profile);
  });

  return owed;
}

/**
 * Pure informational helper for `serve status`'s "next scheduled run"
 * line only — it does NOT drive the daemon's timing (D4: no
 * timer-to-next-fire; the daemon always ticks every 30s and re-evaluates
 * isRunOwed against the real clock). Returns only STRICTLY FUTURE slots
 * and never consults `history`, so it cannot know whether an
 * already-passed, still-in-grace slot was served — `serve status` calls
 * isRunOwed directly for that.
 */
export function nextFireAt(
  now: Date,
  schedules: readonly ProfileSchedule[],
): { at: Date; runs: OwedRun[] } | null {
  const date = formatLocalDate(now);
  const weekday = now.getDay() as Weekday;
  let best: { at: Date; runs: OwedRun[] } | undefined;

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!schedule.weekdays.includes(weekday)) continue;

    for (const slot of schedule.times) {
      const slotAt = parseLocal(date, slot);
      if (slotAt <= now) continue; // strictly future only.

      if (!best || slotAt.getTime() < best.at.getTime()) {
        best = { at: slotAt, runs: [{ profile: schedule.profile, date, slot }] };
      } else if (slotAt.getTime() === best.at.getTime()) {
        best.runs.push({ profile: schedule.profile, date, slot });
      }
    }
  }

  if (!best) return null;
  best.runs.sort((a, b) => a.profile.localeCompare(b.profile));
  return best;
}
