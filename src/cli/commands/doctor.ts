/**
 * commands/doctor.ts (P8) — the `doctor` CLI command: wires a profile,
 * runs every `DoctorCheck` it contributes, prints a plain-text
 * check|status|detail table, and returns 1 iff any finding is `red` (a
 * `warn` never fails the command — see `ports/doctor.ts`).
 *
 * No `src/adapters/**` import here — `wire` is injected (real default:
 * `cli/wire/compose.ts`'s `wire`, the sole adapter-import chokepoint).
 */
import type { DoctorFinding } from '../../ports/doctor.ts';
import {
  wire as defaultWire,
  type WireOverrides,
  type WireResult,
} from '../wire/index.ts';

export interface DoctorCommandOptions {
  profile: string;
}

export interface DoctorDeps {
  wire: (profileName: string, overrides?: WireOverrides) => Promise<WireResult>;
  write: (line: string) => void;
}

function defaultDeps(): DoctorDeps {
  return {
    wire: defaultWire,
    write: (line: string) => console.log(line),
  };
}

function formatTable(findings: DoctorFinding[]): string[] {
  return findings.map((f) => `${f.check} | ${f.status} | ${f.detail}`);
}

export async function doctorCommand(
  opts: DoctorCommandOptions,
  deps: Partial<DoctorDeps> = {},
): Promise<number> {
  const resolved: DoctorDeps = { ...defaultDeps(), ...deps };
  // `configLiftMode: 'readonly'` (config→db Phase 4): doctor must never
  // create/migrate `jobbunny.db` as a side effect of reading config.
  const { checks } = await resolved.wire(opts.profile, { configLiftMode: 'readonly' });

  const findings = await Promise.all(checks.map((c) => c.run()));

  for (const line of formatTable(findings)) {
    resolved.write(line);
  }

  return findings.some((f) => f.status === 'red') ? 1 : 0;
}
