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

/** Logs `gate-declined` and best-effort stamps the pidfile's single
 * rolling `lastGateDecline` field — shared by the per-owed-entry gate
 * guard clause and the catch-up's own gate check (`deferred_sweep.ts`),
 * both "subject to the SAME gate check" per the blueprint's own wording.
 * Never called when `gate.declined` is false — callers guard that. */
export function applyGateDecline(
  root: string,
  pidfile: DaemonPidfileDeps,
  log: (
    event: string,
    data?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ) => void,
  profile: string,
  slot: string,
  gate: ReachabilityGateDecision,
  now: Date,
): void {
  log('gate-declined', { profile, slot, reasonCode: gate.reasonCode });
  if (gate.reasonCode && gate.reason) {
    const reasonCode = gate.reasonCode;
    const reason = gate.reason;
    updateDaemonPidfile(
      root,
      (current) => ({
        ...current,
        lastGateDecline: { reasonCode, reason, at: now.toISOString() },
      }),
      pidfile,
    );
  }
}
