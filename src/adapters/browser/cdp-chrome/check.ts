import type { DoctorCheck, DoctorFinding } from '../../../ports/doctor.ts';
import { DEFAULT_CDP_PORT, DEFAULT_USER_DATA_DIR } from './launcher.ts';
import {
  type ChromePidfileDeps,
  defaultChromePidfileDeps,
  readChromePidfile,
} from './ownership/index.ts';
import type { CdpReachableFn } from './provider.ts';

/**
 * cdpReachableCheck (P8, extended D12/§7.5) — DoctorCheck probing whether a
 * Chrome instance is already listening on the CDP port, and — if so —
 * whether Job Bunny recorded a pid file for it. Mirrors
 * `adapters/lanes/linkedin/inventory.ts`'s factory-returns-`{ name, run() }`
 * shape; `run()` never throws.
 *
 * Reuses `provider.ts`'s existing `CdpReachableFn` (cdpUrl in, parsed
 * `/json/version` body or null out) rather than inventing a new signature.
 * Status is `warn`, never `red`, in every non-ok case: `launch()` spawns
 * Chrome on demand when it's unreachable, so an idle-time miss isn't a
 * run-blocking failure — and a reachable-but-unowned Chrome isn't broken
 * either, it's just outside the recycle policy (D12/§7.6's accepted
 * residual risk).
 */
export interface CdpReachableCheckDeps {
  reachable: CdpReachableFn;
  port?: number;
  /** userDataDir whose Chrome pid file is consulted once CDP is found
   * reachable. Default: DEFAULT_USER_DATA_DIR. */
  userDataDir?: string;
  /** Injectable Chrome pid-file deps. Default: defaultChromePidfileDeps(). */
  pidfileDeps?: ChromePidfileDeps;
}

export function cdpReachableCheck(deps: CdpReachableCheckDeps): DoctorCheck {
  const name = 'cdp-reachable';
  const port = deps.port ?? DEFAULT_CDP_PORT;
  const userDataDir = deps.userDataDir ?? DEFAULT_USER_DATA_DIR;
  const pidfileDeps = deps.pidfileDeps ?? defaultChromePidfileDeps();
  return {
    name,
    async run(): Promise<DoctorFinding> {
      try {
        const version = await deps.reachable(`http://127.0.0.1:${port}`);
        if (!version) {
          return {
            check: name,
            status: 'warn',
            detail: `Chrome CDP not reachable on :${port} — will be launched on demand`,
          };
        }
        const pidfile = readChromePidfile(userDataDir, pidfileDeps);
        if (!pidfile) {
          return {
            check: name,
            status: 'warn',
            detail: `Chrome CDP reachable on :${port} but no Job Bunny pid file found — Job Bunny will attach to but never recycle this browser, and a Chrome it did not start may accumulate memory`,
          };
        }
        return { check: name, status: 'ok', detail: `CDP reachable on :${port}` };
      } catch {
        return {
          check: name,
          status: 'warn',
          detail: `Chrome CDP not reachable on :${port} — will be launched on demand`,
        };
      }
    },
  };
}
