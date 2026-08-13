/**
 * probe.ts (P1 Task 9 — 1.8) — a bounded network-reachability probe used by
 * the daemon (task 12) to gate spawning a doomed run when the machine's own
 * DNS is degraded. The target host is deliberately `www.linkedin.com`
 * (not a generic host like `1.1.1.1`) to mirror the incident's actual
 * failure signature (`net::ERR_NAME_NOT_RESOLVED` against LinkedIn
 * specifically) — a probe that passes against a generic host while
 * LinkedIn's own DNS is still degraded would produce a false-negative gate.
 *
 * `node:dns` (and `node:timers`'s global `setTimeout`) only — no new
 * `package.json` dependency (R4/AC6).
 *
 * `probeReachable` NEVER throws or rejects: every failure path — a real DNS
 * rejection, or the manual timeout racing first — resolves to `false`. A
 * SINGLE `lookup` attempt is raced against a SINGLE timeout, once per
 * invocation; there is no internal retry loop, so the daemon's own
 * "at most once per tick, only when there's an owed entry to gate"
 * discipline fully bounds the network usage this module contributes.
 */
import { lookup as dnsLookup } from 'node:dns/promises';

export interface ReachabilityProbeDeps {
  /** `node:dns.promises.lookup`, injected for tests. */
  lookup: (hostname: string) => Promise<unknown>;
  /** Milliseconds before the probe gives up and reports unreachable. */
  timeoutMs: number;
}

const PROBE_HOST = 'www.linkedin.com';

export async function probeReachable(deps: ReachabilityProbeDeps): Promise<boolean> {
  try {
    await Promise.race([
      deps.lookup(PROBE_HOST),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('reachability probe timed out')),
          deps.timeoutMs,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

export function defaultReachabilityProbeDeps(): ReachabilityProbeDeps {
  return {
    lookup: (hostname: string) => dnsLookup(hostname),
    timeoutMs: 2500,
  };
}
