/**
 * ops/daemon/scan/scan.ts — filesystem -> ProfileSchedule[]. Injected fs
 * deps (mirrors ops/scheduling/run_lock.ts's shape) so this is fully
 * unit-testable without a real filesystem. One bad profile.json (missing,
 * unreadable, malformed, or schema-invalid) is skipped, never thrown — the
 * daemon's schedule scan must survive a single broken profile (spec
 * §9.1's fail-soft row for the schedule scan).
 *
 * RunRecord[] evidence (durable owed-slot history) no longer comes from
 * this module — the on-disk `runs/<date>/` folders it used to scan
 * (`scanRunHistory`, retired) stopped being written once checkpoints moved
 * to `jobbunny.db` (Phase 2). The daemon now reads that evidence straight
 * from each profile's own `RunStoreReader.listRunTimeDirs` (`cli/wire/
 * daemon.ts`'s `wireDaemonRunHistory`, injected as `DaemonDeps.
 * readRunHistory` — see `ops/daemon/daemon.ts`'s doc comment).
 *
 * `readProfileJson` (config→db Phase 4, Task 5) replaced the direct
 * `existsSync`+`readFileSync` reliance for `profile.json` specifically —
 * this module (`ops/daemon`) may not import `src/adapters/**`, so its real
 * implementation (a readonly `ConfigStore`, `cli/wire/daemon.ts`'s
 * `wireDaemonScheduleConfig`) is injected from outside. `readdirSync`
 * stays a plain fs dep: it only lists directory NAMES, unrelated to config
 * content.
 */
import { readdirSync } from 'node:fs';
import { PipelineConfigSchema } from '../../../core/config/index.ts';
import type { ProfileSchedule } from '../../../core/schedule/index.ts';

export interface ScanDeps {
  readdirSync(path: string): string[];
  /** `undefined` covers every "nothing to schedule" case this module
   * treats as skip-worthy: missing db AND missing legacy file, or any
   * other resolution failure the real `ConfigStore`-backed implementation
   * already degrades to `undefined` for. Real implementation: `cli/wire/
   * daemon.ts`'s `wireDaemonScheduleConfig`. */
  readProfileJson(profilesDir: string, name: string): Promise<string | undefined>;
}

/** Every enabled profile's schedule, read from `<profilesDir>/<name>/profile.json`.
 * Profiles are visited in sorted order for determinism. A profile is
 * skipped (not thrown for) when its profile.json is missing/unresolvable,
 * unparsable JSON, fails PipelineConfigSchema validation, has no
 * `schedule` block, or has `schedule.enabled === false`. */
export async function scanProfileSchedules(
  profilesDir: string,
  deps: ScanDeps,
): Promise<ProfileSchedule[]> {
  let names: string[];
  try {
    names = deps.readdirSync(profilesDir);
  } catch {
    return [];
  }

  const schedules: ProfileSchedule[] = [];
  for (const name of [...names].sort()) {
    const raw = await deps.readProfileJson(profilesDir, name);
    if (raw === undefined) continue; // missing/unresolvable — fail-soft, skip.

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      continue; // malformed JSON — fail-soft, skip this profile.
    }

    const result = PipelineConfigSchema.safeParse(parsedJson);
    if (!result.success) continue; // invalid config — fail-soft, skip this profile.

    const schedule = result.data.schedule;
    if (!schedule?.enabled) continue;

    schedules.push({
      profile: name,
      enabled: schedule.enabled,
      times: schedule.times,
      weekdays: schedule.weekdays as ProfileSchedule['weekdays'],
      graceMinutes: schedule.graceMinutes,
    });
  }
  return schedules;
}

/** Builds the real (non-test) `readdirSync`-only half of `ScanDeps` —
 * `readProfileJson` has NO default here (config→db Phase 4, Task 5): it
 * would need a `src/adapters/**` import (a real `ConfigStore`), forbidden
 * in this module. Every real caller supplies it explicitly via
 * `cli/wire/daemon.ts`'s `wireDaemonScheduleConfig` (same precedent as
 * `ops/daemon/daemon.ts`'s own `DaemonDeps.readRunHistory`, which has no
 * default here either — always supplied by the real caller). */
export function defaultScanDeps(): Omit<ScanDeps, 'readProfileJson'> {
  return {
    readdirSync: (p) => readdirSync(p),
  };
}
