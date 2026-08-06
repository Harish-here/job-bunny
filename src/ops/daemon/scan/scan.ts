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
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineConfigSchema } from '../../../core/config/index.ts';
import type { ProfileSchedule } from '../../../core/schedule/index.ts';

export interface ScanDeps {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string): string;
}

/** Every enabled profile's schedule, read from `<profilesDir>/<name>/profile.json`.
 * Profiles are visited in sorted order for determinism. A profile is
 * skipped (not thrown for) when its profile.json is missing, unreadable,
 * malformed JSON, fails PipelineConfigSchema validation, has no `schedule`
 * block, or has `schedule.enabled === false`. */
export function scanProfileSchedules(
  profilesDir: string,
  deps: ScanDeps,
): ProfileSchedule[] {
  let names: string[];
  try {
    names = deps.readdirSync(profilesDir);
  } catch {
    return [];
  }

  const schedules: ProfileSchedule[] = [];
  for (const name of [...names].sort()) {
    const profilePath = join(profilesDir, name, 'profile.json');
    if (!deps.existsSync(profilePath)) continue;

    let raw: string;
    try {
      raw = deps.readFileSync(profilePath);
    } catch {
      continue; // unreadable — fail-soft, skip this profile.
    }

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

/** Builds the real (non-test) ScanDeps. */
export function defaultScanDeps(): ScanDeps {
  return {
    existsSync: (p) => existsSync(p),
    readdirSync: (p) => readdirSync(p),
    readFileSync: (p) => readFileSync(p, 'utf8'),
  };
}
