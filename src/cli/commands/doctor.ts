/**
 * commands/doctor.ts (P8) — the `doctor` CLI command: wires a profile,
 * runs every `DoctorCheck` it contributes, prints a plain-text
 * check|status|detail table, and returns 1 iff any finding is `red` (a
 * `warn` never fails the command — see `ports/doctor.ts`).
 *
 * No `src/adapters/**` import here — `wire` is injected (real default:
 * `cli/wire/compose.ts`'s `wire`, the sole adapter-import chokepoint), and
 * the wire()-failure degrade path (`runDegradedConfigChecks`, below)
 * reaches a `ConfigStore` only via `wireConfigStore` (also re-exported from
 * `cli/wire/index.ts` — the SAME carve-out every other command uses to
 * reach a standalone store without a full `wire()`, e.g.
 * `commands/profile.ts`, `commands/config.ts`), never a direct adapter
 * import.
 */
import { configLegacyDivergenceCheck } from '../../ops/doctor/aggregate.ts';
import {
  type CoreCheckOpts,
  emptyLanesCheck,
  filterParsesCheck,
  profileParsesCheck,
  sqlitePathRetiredCheck,
} from '../../ops/doctor/config_checks.ts';
import type { DoctorCheck, DoctorFinding } from '../../ports/doctor.ts';
import { resolveHome } from '../home/index.ts';
import {
  wire as defaultWire,
  type WireOverrides,
  type WireResult,
  wireConfigStore,
} from '../wire/index.ts';

export interface DoctorCommandOptions {
  profile: string;
}

export interface DoctorDeps {
  wire: (profileName: string, overrides?: WireOverrides) => Promise<WireResult>;
  write: (line: string) => void;
  /** wire()-failure degrade path: runs the doctor checks that do NOT need
   * a successfully wired profile — the five `ops/doctor` "config" checks
   * (`profile-parses`, `filter-parses`, `empty-lanes`, `sqlite-path-
   * retired`, `config-legacy-divergence`), all of which read only through
   * a `ConfigStore` — never the wired `WiredPorts`/`PipelineCtx` that a
   * broken profile/config just failed to produce. Real default opens a
   * fresh READONLY `ConfigStore` (`wireConfigStore`, never creates/
   * migrates `jobbunny.db`), runs the five checks against it, closes it,
   * and returns their findings; injected so tests never touch a real
   * store/db. */
  runDegradedConfigChecks: (profileName: string) => Promise<DoctorFinding[]>;
}

export async function defaultRunDegradedConfigChecks(
  profileName: string,
  root: string = resolveHome(),
): Promise<DoctorFinding[]> {
  const store = wireConfigStore(profileName, { liftMode: 'readonly' });
  try {
    const opts: CoreCheckOpts = {
      profileName,
      root,
      readDoc: (key) => store.readText(key),
    };
    const checks: DoctorCheck[] = [
      profileParsesCheck(opts),
      filterParsesCheck(opts),
      emptyLanesCheck(opts),
      sqlitePathRetiredCheck(opts),
      configLegacyDivergenceCheck(opts),
    ];
    return await Promise.all(checks.map((c) => c.run()));
  } finally {
    store.close();
  }
}

function defaultDeps(): DoctorDeps {
  return {
    wire: defaultWire,
    write: (line: string) => console.log(line),
    runDegradedConfigChecks: defaultRunDegradedConfigChecks,
  };
}

function formatTable(findings: DoctorFinding[]): string[] {
  return findings.map((f) => `${f.check} | ${f.status} | ${f.detail}`);
}

/** The synthesized `wire` finding, shared verbatim between the CLI's own
 * wire()-failure degrade path and the board server's `runDoctor`
 * (`cli/wire/board.ts`) — one exported string constructor instead of two
 * independently-worded copies that could drift on the next edit. */
export function wireFailureFinding(profileName: string, err: unknown): DoctorFinding {
  const message = err instanceof Error ? err.message : String(err);
  return {
    check: 'wire',
    status: 'red',
    detail: `could not wire profile '${profileName}': ${message}`,
  };
}

export async function doctorCommand(
  opts: DoctorCommandOptions,
  deps: Partial<DoctorDeps> = {},
): Promise<number> {
  const resolved: DoctorDeps = { ...defaultDeps(), ...deps };

  // Always `ok`: `main()` already refuses to dispatch `doctor` at all when
  // the home is missing (the missing-home check runs before any command
  // does), so by the time this code runs the home exists.
  const homeFinding: DoctorFinding = {
    check: 'home',
    status: 'ok',
    detail: resolveHome(),
  };

  let checks: WireResult['checks'];
  try {
    // `configLiftMode: 'readonly'` (config→db Phase 4): doctor must never
    // create/migrate `jobbunny.db` as a side effect of reading config.
    ({ checks } = await resolved.wire(opts.profile, { configLiftMode: 'readonly' }));
  } catch (err) {
    // A broken config (e.g. a retired `settings.sqlite.path`, a missing
    // profile.json) must degrade the diagnostic ONE step, never abort it —
    // `main.ts`'s outer catch would otherwise turn this into a single bare
    // stderr line. The synthesized `wire` finding names the failure; the
    // FIVE config checks that don't need a successfully wired profile
    // (`runDegradedConfigChecks`) still run and print alongside it, so a
    // broken profile still gets as much of a real diagnostic as its config
    // can support. Adapter-reachability/env/daemon/claude checks (the ones
    // that DO need the wired result — connector, notifier settings, etc.)
    // are genuinely unavailable here and are skipped, not synthesized.
    const wireFinding = wireFailureFinding(opts.profile, err);
    const degraded = await resolved.runDegradedConfigChecks(opts.profile);
    const findings = [homeFinding, wireFinding, ...degraded];
    for (const line of formatTable(findings)) {
      resolved.write(line);
    }
    return 1;
  }

  const findings = [homeFinding, ...(await Promise.all(checks.map((c) => c.run())))];

  for (const line of formatTable(findings)) {
    resolved.write(line);
  }

  return findings.some((f) => f.status === 'red') ? 1 : 0;
}
