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
