/**
 * ops/daemon/scan/scan.ts — filesystem -> ProfileSchedule[] / RunRecord[].
 * Injected fs deps (mirrors ops/scheduling/run_lock.ts's shape) so this is
 * fully unit-testable without a real filesystem. One bad profile.json
 * (missing, unreadable, malformed, or schema-invalid) is skipped, never
 * thrown — the daemon's schedule scan must survive a single broken
 * profile (spec §9.1's fail-soft row for the schedule scan).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineConfigSchema } from '../../../core/config/index.ts';
import type { ProfileSchedule, RunRecord } from '../../../core/schedule/index.ts';
import { parseRunFolderName } from '../../../core/schedule/index.ts';

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

/** RunRecord[] for the given profiles on `date`, built from
 * `<profilesDir>/<profile>/data/runs/<date>/`'s subdirectory names. A
 * missing runs/<date>/ directory yields no records for that profile — not
 * a throw. */
export function scanRunHistory(
  profilesDir: string,
  profiles: readonly string[],
  date: string,
  deps: ScanDeps,
): RunRecord[] {
  const records: RunRecord[] = [];
  for (const profile of profiles) {
    const runsDir = join(profilesDir, profile, 'data', 'runs', date);
    if (!deps.existsSync(runsDir)) continue;

    let entries: string[];
    try {
      entries = deps.readdirSync(runsDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const startedAt = parseRunFolderName(entry);
      if (startedAt === undefined) continue;
      records.push({ profile, date, startedAt });
    }
  }
  return records;
}

/** Builds the real (non-test) ScanDeps. */
export function defaultScanDeps(): ScanDeps {
  return {
    existsSync: (p) => existsSync(p),
    readdirSync: (p) => readdirSync(p),
    readFileSync: (p) => readFileSync(p, 'utf8'),
  };
}
