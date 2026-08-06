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

  let checks: WireResult['checks'];
  try {
    // `configLiftMode: 'readonly'` (config→db Phase 4): doctor must never
    // create/migrate `jobbunny.db` as a side effect of reading config.
    ({ checks } = await resolved.wire(opts.profile, { configLiftMode: 'readonly' }));
  } catch (err) {
    // A broken config (e.g. a retired `settings.sqlite.path`, a missing
    // profile.json) must degrade the diagnostic ONE step, never abort it —
    // `main.ts`'s outer catch would otherwise turn this into a single bare
    // stderr line, and every other check (env tokens, claude-on-path,
    // daemon liveness, adapter reachability...) would silently never run
    // at all, even though none of them need a successfully wired profile.
    const message = err instanceof Error ? err.message : String(err);
    const finding: DoctorFinding = {
      check: 'wire',
      status: 'red',
      detail: `could not wire profile '${opts.profile}': ${message}`,
    };
    resolved.write(formatTable([finding])[0] as string);
    return 1;
  }

  const findings = await Promise.all(checks.map((c) => c.run()));

  for (const line of formatTable(findings)) {
    resolved.write(line);
  }

  return findings.some((f) => f.status === 'red') ? 1 : 0;
}
