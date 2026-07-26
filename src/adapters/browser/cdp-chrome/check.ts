import type { DoctorCheck, DoctorFinding } from '../../../ports/doctor.ts';
import { DEFAULT_CDP_PORT } from './launcher.ts';
import type { CdpReachableFn } from './provider.ts';

/**
 * cdpReachableCheck (P8) — DoctorCheck probing whether a Chrome instance is
 * already listening on the CDP port. Mirrors
 * `adapters/lanes/linkedin/inventory.ts`'s factory-returns-`{ name, run() }`
 * shape; `run()` never throws.
 *
 * Reuses `provider.ts`'s existing `CdpReachableFn` (cdpUrl in, parsed
 * `/json/version` body or null out — the same probe `CdpChromeProvider`
 * injects as `cdpReachable`) rather than inventing a new signature, so a
 * caller wiring the doctor surface can hand this the very same function it
 * already has for the provider. `warn`, not `red`, either way: `launch()`
 * spawns Chrome on demand when it's unreachable, so an idle-time miss isn't
 * a run-blocking failure.
 */
export interface CdpReachableCheckDeps {
  reachable: CdpReachableFn;
  port?: number;
}

export function cdpReachableCheck(deps: CdpReachableCheckDeps): DoctorCheck {
  const name = 'cdp-reachable';
  const port = deps.port ?? DEFAULT_CDP_PORT;
  return {
    name,
    async run(): Promise<DoctorFinding> {
      try {
        const version = await deps.reachable(`http://127.0.0.1:${port}`);
        if (version) {
          return { check: name, status: 'ok', detail: `CDP reachable on :${port}` };
        }
        return {
          check: name,
          status: 'warn',
          detail: `Chrome CDP not reachable on :${port} — will be launched on demand`,
        };
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
