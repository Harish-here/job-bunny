/**
 * cli/wire/board_doctor.ts (fix round) — `BoardSource.runDoctor`'s real
 * implementation, split out of `board.ts` purely for the file-size cap
 * (`board.ts` hit 404 lines once this call was fixed to close its own
 * `configStore` — see below — pushing it past the 400-line cap). NOT a
 * member of `only-wire-imports-adapters`'s carve-out (`.dependency-
 * cruiser.cjs`'s `pathNot` there names only `compose|builders|registry|
 * board|daemon|migrate\.ts$` — `board_doctor.ts` isn't on that list) — and
 * it doesn't need to be: this file imports no adapter directly, only
 * `compose.ts`'s `wire()` (which IS carve-out-legal) and
 * `ops/doctor/aggregate.ts`'s `runChecks`, so the rule's `to: { path:
 * '^src/adapters' }` never matches anything this file imports. Mirrors
 * `board_daemon.ts`'s own precedent for splitting a `BoardSource` method's
 * body out of `board.ts`.
 *
 * Membership (whether `name` is a CURRENT directory under
 * `<root>/profiles`) is NOT this function's concern — `board.ts`'s
 * `runDoctor` re-derives that the same way every other method there does,
 * before ever calling in here.
 */
import { runChecks } from '../../ops/doctor/aggregate.ts';
import type { DoctorReport } from '../../ports/doctor.ts';
import {
  defaultRunDegradedConfigChecks,
  wireFailureFinding,
} from '../commands/doctor.ts';
import { wire } from './compose.ts';

/** Runs the composed doctor checks for one already-validated profile name.
 * `wire()`'s own doc comment: "Not closed internally (checks close over
 * it, run later) — caller closes." The CLI's one-shot `doctorCommand`
 * exits right after wiring, so process teardown hides that; the board
 * server lives for days, so every call here must close its own
 * short-lived `configStore` or the open-handle count grows without bound
 * (and locks `jobbunny.db` on Windows). On a `wire()` throw, `configStore`
 * is ALREADY closed by `wire()`'s own internal catch (it owns the store in
 * this call — no `overrides.configStore` is ever passed in), so the catch
 * branch below never touches it. */
export async function runBoardDoctor(name: string, root: string): Promise<DoctorReport> {
  try {
    const { checks, configStore } = await wire(name, {
      root,
      configLiftMode: 'readonly',
    });
    try {
      return await runChecks(checks);
    } finally {
      configStore?.close();
    }
  } catch (err) {
    // Same wire()-failure degrade path the CLI's `doctor` command takes
    // (`commands/doctor.ts`) — the synthesized `wire` finding is itself
    // red, so the report's status is always 'red' here; never recomputed
    // from the degraded findings.
    const degraded = await defaultRunDegradedConfigChecks(name, root);
    return { findings: [wireFailureFinding(name, err), ...degraded], status: 'red' };
  }
}
