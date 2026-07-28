/**
 * Throttle classifier (spec §4.3) — PURE, zero imports, no I/O, no clock.
 *
 * On 2026-07-28 LinkedIn soft-throttled the shared `.chrome-debug` session:
 * the JD hydration request returned 503 while every other request on the
 * page returned 200, so `jdRoot` was present in the DOM with
 * `textContent.length === 0` — a skeleton shell. That is a completely
 * different failure from `jdRoot` not matching at all (selector drift),
 * and conflating the two is the misdiagnosis this module exists to end.
 *
 * Counting is CONSECUTIVE, not cumulative (D5): one or two empty JDs happen
 * for benign reasons (a pulled posting, a slow pane), so a mostly-healthy
 * fire with scattered failures must never trip. A real-text outcome resets
 * the streak; a `missing` outcome leaves it untouched, because selector
 * drift is not evidence of a throttle in either direction.
 */

/** One JD open's outcome. `shell` = jdRoot matched, extracted text empty
 * (the throttle signature). `missing` = jdRoot matched nothing (selector
 * drift — NOT a throttle signal). `ok` = real text came back. */
export type JdOutcome = 'ok' | 'shell' | 'missing';

/** Consecutive `shell` outcomes that mean "this session is blocked" (D5). */
export const THROTTLE_CONSECUTIVE_SHELLS_TO_TRIP = 3;

/** How long the breaker stays open after a trip (D7): long enough to
 * outlast a typical soft block and to break the three-fires-in-five-hours
 * stacking pattern, short enough that same-day recovery is still possible. */
export const THROTTLE_COOLDOWN_MS = 4 * 60 * 60 * 1000;

export class ThrottleCounter {
  private consecutiveShells = 0;
  private readonly threshold: number;

  constructor(threshold: number = THROTTLE_CONSECUTIVE_SHELLS_TO_TRIP) {
    this.threshold = threshold;
  }

  record(outcome: JdOutcome): void {
    if (outcome === 'ok') {
      this.consecutiveShells = 0;
      return;
    }
    if (outcome === 'shell') {
      this.consecutiveShells += 1;
    }
    // 'missing' deliberately falls through: it neither counts toward a trip
    // nor breaks an existing streak.
  }

  get tripped(): boolean {
    return this.consecutiveShells >= this.threshold;
  }
}
