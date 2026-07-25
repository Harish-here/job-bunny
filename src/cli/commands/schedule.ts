/**
 * commands/schedule.ts (P8 Task 4) — the `schedule` CLI command:
 *
 *  - `install` is CROSS-PROFILE (the one command not scoped to a single
 *    `--profile`): it enumerates every profile under `profiles/`, reads
 *    each `profile.json`, and collects a `ScheduledJob` per entry in that
 *    profile's `schedule.times[]` (`core/config/schema.ts`'s
 *    `ScheduleSchema`), then hands the WHOLE set to `Scheduler.install` in
 *    one declarative reconcile — mirrors v0's `scripts/ops/schedule.js`,
 *    including that a profile is skipped (not an error) when its
 *    `profile.json` is unreadable/malformed, has no `schedule`, or has an
 *    empty `times[]`. `ScheduleSchema` itself carries no `enabled` field,
 *    but the v0 key is still present on migrated profiles — `enabled ===
 *    false` is honored as an explicit skip so migrating a profile's config
 *    to v2 shape never silently starts firing one the user had disabled;
 *    `enabled` absent or `true` schedules normally.
 *  - Profiles are enumerated in sorted directory-name order and a
 *    profile's `times[]` are walked in file order — both feed
 *    deterministically into `Scheduler.install`, which matters because
 *    profiles sharing one time slot must always chain in the same order
 *    (they share one Chrome/CDP session and run strictly sequentially
 *    within a slot — see `adapters/scheduler/launchd/plist.ts`).
 *  - `remove --profile <p>` delegates straight to `Scheduler.remove`.
 *  - Prints one summary line per distinct time slot after `install`
 *    (`<label> | <time> | <profiles>`), and one confirmation line after
 *    `remove`. The `com.jobbunny.<HHMM>` label format is duplicated here
 *    (not imported) — pinned by `adapters/scheduler/launchd/plist.ts`,
 *    which this file may not import (`only-wire-imports-adapters`).
 *
 * No `src/adapters/**` import here — the concrete `Scheduler` is injected
 * (real default: `cli/wire.ts`'s `wireScheduler`, the sole adapter-import
 * chokepoint for the scheduler port; `PipelineCtx`/`wire()` deliberately
 * don't carry a `Scheduler` — only this command needs one).
 */
import { readdir as fsReaddir, readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ScheduledJob, Scheduler } from '../../ports/scheduler.ts';
import { wireScheduler } from '../wire.ts';

export type ScheduleAction = 'install' | 'remove';

export interface ScheduleCommandOptions {
  action: ScheduleAction;
  /** Required for `remove`; ignored by `install` (which is cross-profile). */
  profile?: string;
}

export interface ScheduleDeps {
  scheduler: Scheduler;
  root: string;
  readdir: (dir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  write: (line: string) => void;
}

function defaultDeps(): ScheduleDeps {
  return {
    scheduler: wireScheduler(),
    root: process.cwd(),
    readdir: (dir) => fsReaddir(dir),
    readFile: (p) => fsReadFile(p, 'utf8'),
    write: (line: string) => console.log(line),
  };
}

/** Loose shape of `profile.json`'s `schedule` key — deliberately wider
 * than `core/config/schema.ts`'s `ScheduleSchema` (which requires `times`
 * and knows nothing of `enabled`): this command must also read
 * not-yet-migrated / partially-migrated profiles without throwing. */
const RawScheduleSchema = z
  .object({
    enabled: z.boolean().optional(),
    times: z.array(z.string()).optional(),
  })
  .passthrough();

function isNotFound(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: unknown }).code === 'ENOENT',
  );
}

/** Reads every `profiles/<name>/profile.json` (sorted profile-name order)
 * and collects one `ScheduledJob` per entry in that profile's
 * `schedule.times[]`, in file order. A profile is SKIPPED — never an
 * abort of the rest — when: its `profile.json` can't be read or parsed,
 * its `schedule` is absent or fails even the loose `RawScheduleSchema`,
 * `schedule.times` is empty/absent, or `schedule.enabled === false`
 * (the v0 flag, honored so a migrated-but-disabled profile doesn't start
 * firing). Returns `[]`, not a throw, when `profiles/` itself is absent. */
export async function collectScheduledJobs(deps: ScheduleDeps): Promise<ScheduledJob[]> {
  const profilesDir = path.join(deps.root, 'profiles');
  let names: string[];
  try {
    names = [...(await deps.readdir(profilesDir))].sort();
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }

  const jobs: ScheduledJob[] = [];
  for (const name of names) {
    const profileJsonPath = path.join(profilesDir, name, 'profile.json');
    let raw: string;
    try {
      raw = await deps.readFile(profileJsonPath);
    } catch {
      continue; // unreadable (or not actually a profile dir) — skip.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed profile.json — skip rather than abort every other profile.
    }
    const scheduleRaw = (parsed as { schedule?: unknown }).schedule;
    const result = RawScheduleSchema.safeParse(scheduleRaw);
    if (!result.success) continue;
    if (result.data.enabled === false) continue;
    for (const time of result.data.times ?? []) {
      jobs.push({ profile: name, time });
    }
  }
  return jobs;
}

function groupByTime(jobs: ScheduledJob[]): Map<string, string[]> {
  const byTime = new Map<string, string[]>();
  for (const job of jobs) {
    const existing = byTime.get(job.time);
    if (existing) existing.push(job.profile);
    else byTime.set(job.time, [job.profile]);
  }
  return byTime;
}

async function runInstall(deps: ScheduleDeps): Promise<number> {
  const jobs = await collectScheduledJobs(deps);
  await deps.scheduler.install(jobs);

  if (jobs.length === 0) {
    deps.write('schedule install: no scheduled profiles found');
    return 0;
  }

  const byTime = groupByTime(jobs);
  for (const [time, profiles] of [...byTime.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const label = `com.jobbunny.${time.replace(':', '')}`;
    deps.write(`${label} | ${time} | ${profiles.join(', ')}`);
  }
  return 0;
}

async function runRemove(
  profile: string | undefined,
  deps: ScheduleDeps,
): Promise<number> {
  if (!profile) {
    deps.write('schedule remove: missing required --profile');
    return 1;
  }
  await deps.scheduler.remove(profile);
  deps.write(`schedule remove: removed profile "${profile}"`);
  return 0;
}

export async function scheduleCommand(
  opts: ScheduleCommandOptions,
  overrides: Partial<ScheduleDeps> = {},
): Promise<number> {
  const deps: ScheduleDeps = { ...defaultDeps(), ...overrides };

  if (opts.action === 'remove') {
    return runRemove(opts.profile, deps);
  }
  return runInstall(deps);
}
