/**
 * ops/daemon/gate/reachability_gate.ts — the per-tick suspend/reachability
 * gate (blueprint `pipeline-stability-hardening` step 1.11, steps 2-3):
 * computed ONCE per batch, applied as the FIRST guard clause an owed
 * entry — or the same-day catch-up (deferred_sweep.ts) — can hit. Split
 * out of `../daemon.ts` purely to keep that file under the file-size cap
 * (a non-behavioral split, same precedent as `../alert/schema_drift.ts`:
 * `daemon.ts` calls these two functions directly, no adapter import
 * needed here — `ops/daemon` still may not import `src/adapters/**`).
 */
import { wasHostSuspended } from '../../../core/schedule/index.ts';
import type { DaemonPidfileDeps } from '../pidfile.ts';
import { updateDaemonPidfile } from '../pidfile.ts';

export interface ReachabilityGateDecision {
  declined: boolean;
  reasonCode: 'host-asleep' | 'network-unreachable' | null;
  reason: string | null;
}

/** 1 hour — bug 7 (pipeline-stability-hardening QA, 2026-08-14): on a tick
 * with NO real owed slot entries (only a lingering expired catch-up
 * candidate — `deriveExpiredUnserved` keeps returning the same candidate
 * every tick for the rest of the day, or until served), the reachability
 * gate used to re-probe DNS and re-log `gate-declined` every single 30s
 * tick for as long as the catch-up stayed gate-declined (measured: 240
 * ticks -> 240 log lines and 240 DNS probes). `computeCatchupOnlyGate`
 * below bounds re-probing/re-logging for that catch-up-only case to at
 * most once per interval. Never applies when there's a REAL owed entry —
 * `computeReachabilityGate` always runs fresh then, exactly as before, so
 * real-run timing is unaffected. */
export const CATCHUP_GATE_RETRY_INTERVAL_MS = 60 * 60_000;

/** `daemon.ts`'s own per-process cache (NOT the pidfile — see
 * `computeCatchupOnlyGate`'s doc comment for why). `at` is a
 * `Date.now()`-style epoch ms, not an ISO string, purely because nothing
 * outside `daemon.ts`'s closure ever reads it. */
export interface CatchupGateCache {
  reasonCode: 'host-asleep' | 'network-unreachable';
  reason: string;
  at: number;
}

/** Wraps `computeReachabilityGate` for a catch-up-ONLY tick (no real owed
 * slot entries this tick — `daemon.ts` passes `computeReachabilityGate`
 * straight through otherwise): reuses `cache` instead of re-probing/
 * re-declining while less than `CATCHUP_GATE_RETRY_INTERVAL_MS` has
 * elapsed since it was populated. Lives in this closure-per-daemon-process
 * cache, not the pidfile: it only needs to survive across ticks of the
 * SAME process, never a restart (a fresh process re-probing once on its
 * first catch-up-only tick is correct, not a regression). Returns the
 * gate to use, the cache to carry into the NEXT tick (cleared the moment a
 * fresh probe finds things healthy again — never trusts a stale "still
 * declined" reading once reachability is confirmed), and whether this
 * WAS a fresh evaluation (`fresh: false` on a cache hit tells the caller
 * to suppress its own `gate-declined` log line — already logged the tick
 * the cache was first populated). */
export async function computeCatchupOnlyGate(
  cache: CatchupGateCache | undefined,
  now: Date,
  previousLastTickAt: string | undefined,
  probeReachable: () => Promise<boolean>,
): Promise<{
  gate: ReachabilityGateDecision;
  cache: CatchupGateCache | undefined;
  fresh: boolean;
}> {
  if (cache && now.getTime() - cache.at <= CATCHUP_GATE_RETRY_INTERVAL_MS) {
    return {
      gate: { declined: true, reasonCode: cache.reasonCode, reason: cache.reason },
      cache,
      fresh: false,
    };
  }
  const gate = await computeReachabilityGate(
    previousLastTickAt,
    now,
    true,
    probeReachable,
  );
  const nextCache =
    gate.declined && gate.reasonCode && gate.reason
      ? { reasonCode: gate.reasonCode, reason: gate.reason, at: now.getTime() }
      : undefined;
  return { gate, cache: nextCache, fresh: true };
}

/** Step 2's own pseudocode, verbatim: a suspend gap (pure, no I/O) takes
 * priority over a reachability probe (bounded network I/O), and the probe
 * runs at most once, only when there is at least one owed entry to gate —
 * an empty batch spends no network I/O at all, matching today's
 * steady-state behavior when nothing is owed. */
export async function computeReachabilityGate(
  previousLastTickAt: string | undefined,
  now: Date,
  hasOwedEntries: boolean,
  probeReachable: () => Promise<boolean>,
): Promise<ReachabilityGateDecision> {
  // `previousLastTickAt` undefined (first tick ever, or an unreadable
  // pidfile) makes `Date.parse` produce NaN, which `wasHostSuspended`
  // naturally treats as "not suspected" (`NaN > threshold` is always
  // false) — the blueprint's own §8 Failure Semantics fallback, no
  // special case needed.
  const gapMs = now.getTime() - Date.parse(previousLastTickAt ?? '');
  const suspected = wasHostSuspended(gapMs);
  if (suspected) {
    return {
      declined: true,
      reasonCode: 'host-asleep',
      reason: 'Job Bunny declined to start this run because the host was asleep.',
    };
  }
  const reachable = hasOwedEntries ? await probeReachable() : undefined;
  if (reachable === false) {
    return {
      declined: true,
      reasonCode: 'network-unreachable',
      reason: 'Job Bunny declined to start this run because the network was unreachable.',
    };
  }
  return { declined: false, reasonCode: null, reason: null };
}

/** Logs `gate-declined` and best-effort stamps two pieces of pidfile
 * state — shared by the per-owed-entry gate guard clause and the catch-up's
 * own gate check (`deferred_sweep.ts`), both "subject to the SAME gate
 * check" per the blueprint's own wording. Never called when `gate.declined`
 * is false — callers guard that.
 *
 * `date`/`slot` identify the OWED ENTRY this decline applies to (never
 * `'catchup'` — the catch-up path logs its own gate decline directly in
 * `deferred_sweep.ts` rather than calling this, since a catch-up has no
 * per-slot reason to attribute). Bug 1 (pipeline-stability-hardening QA,
 * 2026-08-14): besides the existing single rolling `lastGateDecline` field,
 * this now ALSO upserts a per-(profile,date,slot) entry into
 * `slotGateDeclines` — the record `deferred_sweep.ts`'s own reason
 * attribution reads once this slot's grace has fully closed, instead of the
 * single rolling field a LATER, unrelated slot's own decline would have
 * since overwritten. Filtered to `date === today` on every write (mirrors
 * `attempts`'s own self-pruning), then upserted (drop this exact
 * profile+date+slot's own prior entry before pushing the fresh one) so a
 * slot gated across many ticks within its grace window keeps exactly one
 * entry, not one per tick. */
export function applyGateDecline(
  root: string,
  pidfile: DaemonPidfileDeps,
  log: (
    event: string,
    data?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ) => void,
  profile: string,
  date: string,
  slot: string,
  gate: ReachabilityGateDecision,
  now: Date,
): void {
  log('gate-declined', { profile, slot, reasonCode: gate.reasonCode });
  if (gate.reasonCode && gate.reason) {
    const reasonCode = gate.reasonCode;
    const reason = gate.reason;
    const at = now.toISOString();
    updateDaemonPidfile(
      root,
      (current) => ({
        ...current,
        lastGateDecline: { reasonCode, reason, at },
        slotGateDeclines: [
          ...current.slotGateDeclines.filter(
            (d) => d.date === date && (d.profile !== profile || d.slot !== slot),
          ),
          { profile, date, slot, reasonCode, reason, at },
        ],
      }),
      pidfile,
    );
  }
}
