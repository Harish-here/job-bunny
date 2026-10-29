import type { DoctorCheck, DoctorFinding } from '../../../ports/doctor.ts';
import {
  assertOurChrome,
  defaultOwnershipDeps,
  ForeignChromeError,
  type OwnershipDeps,
} from './foreign/index.ts';
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
 * residual risk). A reachable Chrome on a FOREIGN user-data-dir (not proven
 * ours via CDP SystemInfo.getInfo) is also `warn`, with the provider's
 * ForeignChromeError message: `red` here would make `run`'s doctor
 * preflight abort the whole run (greenhouse/keka lanes included), while the
 * provider already fails only the browser lane loudly and never attaches.
 */
export interface CdpReachableCheckDeps {
  reachable: CdpReachableFn;
  port?: number;
  /** userDataDir whose Chrome pid file is consulted once CDP is found
   * reachable. `cli/wire` always injects `join(<data home>, 'chrome')`;
   * DEFAULT_USER_DATA_DIR is only an inert fallback for a caller that
   * constructs this check with no `userDataDir` at all. */
  userDataDir?: string;
  /** Injectable Chrome pid-file deps. Default: defaultChromePidfileDeps(). */
  pidfileDeps?: ChromePidfileDeps;
  /** Injectable ownership-proof deps. Default: defaultOwnershipDeps(). */
  ownership?: OwnershipDeps;
}

export function cdpReachableCheck(deps: CdpReachableCheckDeps): DoctorCheck {
  const name = 'cdp-reachable';
  const port = deps.port ?? DEFAULT_CDP_PORT;
  const userDataDir = deps.userDataDir ?? DEFAULT_USER_DATA_DIR;
  const pidfileDeps = deps.pidfileDeps ?? defaultChromePidfileDeps();
  const ownership = deps.ownership ?? defaultOwnershipDeps();
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
        try {
          await assertOurChrome({
            version,
            port,
            userDataDir,
            signal: new AbortController().signal, // assertOurChrome adds its own 3s bound
            deps: ownership,
          });
        } catch (err) {
          if (err instanceof ForeignChromeError) {
            return { check: name, status: 'warn', detail: err.message };
          }
          throw err;
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
