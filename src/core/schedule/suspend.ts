/**
 * core/schedule/suspend.ts — pure suspend-gap detector. Arithmetic on a
 * single already-computed gap in milliseconds; no clock read, no Date
 * parsing, no imports (core stays pure — `core-is-pure`).
 */

export const TICK_MS = 30_000; // re-exported/mirrored from ops/daemon/daemon.ts's own constant —
// do not import across the ops/core boundary; core may not import ops. Keep the two values equal
// by a shared test (see below), not a shared import.
export const SUSPECTED_SUSPEND_GAP_MS = TICK_MS * 4; // 120_000ms — "far exceeds the tick interval"
// (R1's own wording). Judgment call, no incident-derived exact threshold exists; see NOTES.
export function wasHostSuspended(gapMs: number): boolean {
  return gapMs > SUSPECTED_SUSPEND_GAP_MS;
}

/** How long the host must stay continuously awake after a suspend-sized gap
 * before the daemon may spawn: 6 ticks. A macOS maintenance DarkWake lasts
 * 45-63s (measured), then the host sleeps again — a spawn started a tick or
 * two after the wake dies of the stall watchdog when it does. */
export const WAKE_SETTLE_MS = TICK_MS * 6; // 180_000ms.

/** Result of observing one tick: whether spawning must still be declined as
 * `host-asleep`, and the updated "host last resumed at" epoch ms to carry to
 * the next tick (`undefined` once the host has settled). */
export interface WakeSettle {
  declined: boolean;
  resumedAtMs: number | undefined;
}

/** Pure per-tick state step. `gapMs` is the gap since the previous tick,
 * `nowMs` this tick's epoch ms, `resumedAtMs` the value returned by the
 * previous call. A suspend-sized gap (re)starts the settle window at
 * `nowMs`, so a new sleep during settling resets it; otherwise the window
 * keeps declining until `WAKE_SETTLE_MS` of continuous awake time has passed
 * (exactly `WAKE_SETTLE_MS` is settled). An undefined/NaN gap never starts a
 * window (first tick fails open, as `wasHostSuspended` does). */
export function trackWakeSettle(
  gapMs: number,
  nowMs: number,
  resumedAtMs: number | undefined,
): WakeSettle {
  if (wasHostSuspended(gapMs)) return { declined: true, resumedAtMs: nowMs };
  if (resumedAtMs !== undefined && nowMs - resumedAtMs < WAKE_SETTLE_MS) {
    return { declined: true, resumedAtMs };
  }
  return { declined: false, resumedAtMs: undefined };
}
