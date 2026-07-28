/** Randomized inter-request pacing before every network-facing navigation
 * (P9 tail: confirmed v0->v2 parity regression — LinkedIn served an
 * enterprise reCAPTCHA to a scraping profile that skipped v0's delays).
 * The CLASS default here is deliberately a no-op range (0, 0) — NOT v0's
 * (2000, 5000) — so every direct `new LinkedInLane(...)` call site that
 * predates this fix (this file's whole test suite) keeps running at its
 * original speed instead of silently gaining a real multi-second sleep
 * per card/url. The real v0-parity default (2000, 5000) is applied
 * exactly once, at production wiring time, by `resolveJitterRange` in
 * `cli/wire.ts` (its own same-named constants) — the only caller that
 * needs it live. */
export const DEFAULT_JITTER_MIN_MS = 0;
export const DEFAULT_JITTER_MAX_MS = 0;

/** Randomized pause BETWEEN saved-search urls (throttle guard D2,
 * 2026-07-28). Same no-op-by-default posture as the jitter constants
 * directly above: `(0, 0)` here so every pre-existing `new LinkedInLane(...)`
 * call site keeps its original speed, with the real production range
 * (20_000, 45_000) applied once at wiring time by
 * `resolveInterUrlDelayRange` in `cli/wire.ts`. */
export const DEFAULT_INTER_URL_DELAY_MIN_MS = 0;
export const DEFAULT_INTER_URL_DELAY_MAX_MS = 0;

/** PURE — [minMs, maxMs) jitter amount, v0 parity
 * (scripts/lib/page_actions.js's jitterMs). `rand` is injectable for
 * deterministic tests — mirrors v0's own `rand = Math.random` param. */
export function jitterMs(
  minMs: number,
  maxMs: number,
  rand: () => number = Math.random,
): number {
  return minMs + Math.floor(rand() * (maxMs - minMs));
}
