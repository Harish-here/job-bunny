/**
 * plist.ts (P8 Task 2) — pure launchd plist/XML generation from
 * `ScheduledJob[]` (`ports/scheduler.ts`). No I/O, no env reads: `root`/
 * `home` are always caller-supplied so this stays deterministic and
 * testable; `launchd.ts` is the only caller that resolves them from the
 * real filesystem/`os.homedir()`.
 *
 * Pins the v0 plist shape (`scripts/ops/schedule.js`'s `renderPlist` +
 * install loop) with two intentional deviations called out in the P8 plan:
 *   - Label is `com.jobbunny.<HHMM>` (v0: `com.jobbunny.run.<HHMM>`) — the
 *     plan's literal label, dropping the `.run.` infix.
 *   - `ProgramArguments` is `["/bin/bash", "-lc", <cmd>]` (v0: a script
 *     path, `run_scheduled.sh`) — v2 has no wrapper shell script yet, so
 *     the whole run_scheduled.sh cadence (cd repo root, chain profiles
 *     with `;` so one failing profile doesn't abort the rest, coarse
 *     backstop SIGTERM-then-SIGKILL watchdog) is inlined into one `-lc`
 *     command string built here.
 *
 * StartCalendarInterval, RunAtLoad: false, WorkingDirectory, and the
 * Standard{Out,Error}Path convention (`~/Library/Logs/JobBunny/<label>.
 * {out,err}.log`) are unchanged from v0.
 */
import type { ScheduledJob } from '../../../ports/scheduler.ts';

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Fallback runner-side run cap used ONLY when a caller doesn't supply
 * `runCapMs` (`wireScheduler()` in `cli/wire.ts` is the one production
 * caller, and currently doesn't). This is a REAL hard-kill input, not
 * informational: `buildCommand`'s embedded watchdog SIGTERMs (then
 * SIGKILLs) the whole `jobbunny run` process group at
 * `ceil(runCapMs / 1000) + 300` seconds — see `buildCommand` below.
 *
 * v0's `run_scheduled.sh` default was 30 min (`JOBBUNNY_RUN_TIMEOUT_SECONDS`),
 * back when a run was LinkedIn-card-bound and short. v2's own derived run
 * cap (`computeRunCapMs` in `cli/commands/run.ts`, driven by the wired
 * stages' `timeoutMs * (retries + 1)` sums) is now measured at 13_012_500ms
 * (~3h37m) against the real production stage set (farm's 90-minute
 * LinkedIn-jitter ceiling dominates) — a 30-minute backstop here would kill
 * every legitimate scheduled run. Set with ~25% headroom above that
 * measured figure (same margin `computeRunCapMs` itself uses) so it isn't
 * a hair-trigger the next time a stage timeout grows; it is NOT
 * automatically re-derived (this module is intentionally pure/no-I/O and
 * `wireScheduler()` is deliberately decoupled from per-profile `wire()` —
 * see `cli/wire.ts`'s file header) — bump it by hand if `computeRunCapMs`
 * against the real stage list ever exceeds it. */
export const DEFAULT_RUN_CAP_MS = 16_200_000;

/** Seconds the watchdog waits after SIGTERM before escalating to SIGKILL —
 * mirrors `run_scheduled.sh`'s `sleep 20` between the two signals. */
const SIGKILL_GRACE_SECONDS = 20;

export interface BuildPlistsOptions {
  /** Runner's own internal run cap, ms. Backstop = ceil(runCapMs/1000)+300. */
  runCapMs?: number;
  /** Repo root — `cd`'d into before running any profile. Caller-supplied;
   * never read from `process.cwd()` here. */
  root?: string;
  /** Home directory — used to build the `~/Library/Logs/JobBunny` log
   * paths. Caller-supplied; never read from `os.homedir()` here. */
  home?: string;
}

export interface BuiltPlist {
  label: string;
  time: string;
  profiles: string[];
  xml: string;
}

type PlistValue =
  | string
  | number
  | boolean
  | PlistValue[]
  | { [key: string]: PlistValue };

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderValue(value: PlistValue, indent: string): string {
  if (typeof value === 'string') {
    return `${indent}<string>${escapeXml(value)}</string>`;
  }
  if (typeof value === 'number') {
    return `${indent}<integer>${value}</integer>`;
  }
  if (typeof value === 'boolean') {
    return `${indent}<${value ? 'true' : 'false'}/>`;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => renderValue(item, `${indent}  `));
    return `${indent}<array>\n${items.join('\n')}\n${indent}</array>`;
  }
  const items: string[] = [];
  for (const [key, val] of Object.entries(value)) {
    items.push(`${indent}  <key>${escapeXml(key)}</key>`);
    items.push(renderValue(val, `${indent}  `));
  }
  return `${indent}<dict>\n${items.join('\n')}\n${indent}</dict>`;
}

function renderPlist(dict: Record<string, PlistValue>): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    renderValue(dict, ''),
    '</plist>',
  ];
  return lines.join('\n');
}

/** Parses a validated "HH:MM" into { hour, minute } integers. */
function parseTime(time: string): { hour: number; minute: number } {
  const match = TIME_REGEX.exec(time);
  if (!match) {
    throw new Error(
      `launchd/plist: invalid schedule time "${time}" — expected HH:MM (24h)`,
    );
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Builds the `/bin/bash -lc` command string: cd repo root, then every
 * profile's `jobbunny run --profile <p> --headless` chained with `; ` (in
 * input order) so one profile failing never aborts the rest (v0's
 * `run_scheduled.sh` loop is deliberately not `set -e`), run as a
 * background process group so the watchdog below can signal the whole
 * tree, then a coarse SIGTERM-then-SIGKILL backstop above the runner's own
 * run cap. */
function buildCommand(root: string, profiles: string[], backstopSeconds: number): string {
  const chained = profiles
    .map((p) => `jobbunny run --profile ${p} --headless`)
    .join('; ');
  return [
    'set -uo pipefail',
    'set -m', // job control: gives the backgrounded chain its own process group.
    `cd '${root}'`,
    `{ ${chained}; } &`,
    'PGID=$!',
    '(',
    `  sleep ${backstopSeconds}`,
    '  if kill -0 "$PGID" 2>/dev/null; then',
    '    kill -SIGTERM -- "-$PGID" 2>/dev/null',
    `    sleep ${SIGKILL_GRACE_SECONDS}`,
    '    kill -SIGKILL -- "-$PGID" 2>/dev/null',
    '  fi',
    ') &',
    'WATCHDOG=$!',
    'wait "$PGID"',
    'EXIT=$?',
    'kill "$WATCHDOG" 2>/dev/null',
    'wait "$WATCHDOG" 2>/dev/null',
    'exit "$EXIT"',
  ].join('\n');
}

/** Builds one plist per DISTINCT time across `jobs` — profiles sharing a
 * time run sequentially (in input order) inside one job. Pure/deterministic:
 * `root`/`home` must be supplied by the caller (never read from real env
 * here); `runCapMs` defaults to `DEFAULT_RUN_CAP_MS`. */
export function buildPlists(
  jobs: ScheduledJob[],
  opts: BuildPlistsOptions = {},
): BuiltPlist[] {
  const runCapMs = opts.runCapMs ?? DEFAULT_RUN_CAP_MS;
  const root = opts.root ?? '';
  const home = opts.home ?? '';
  const backstopSeconds = Math.ceil(runCapMs / 1000) + 300;

  const profilesByTime = new Map<string, string[]>();
  for (const job of jobs) {
    parseTime(job.time); // validate eagerly, even for a time with no further use yet.
    const existing = profilesByTime.get(job.time);
    if (existing) {
      existing.push(job.profile);
    } else {
      profilesByTime.set(job.time, [job.profile]);
    }
  }

  const result: BuiltPlist[] = [];
  for (const [time, profiles] of profilesByTime) {
    const { hour, minute } = parseTime(time);
    const hhmm = time.replace(':', '');
    const label = `com.jobbunny.${hhmm}`;
    const cmd = buildCommand(root, profiles, backstopSeconds);
    const startCalendarInterval = [1, 2, 3, 4, 5].map((weekday) => ({
      Weekday: weekday,
      Hour: hour,
      Minute: minute,
    }));
    const outLog = `${home}/Library/Logs/JobBunny/${label}.out.log`;
    const errLog = `${home}/Library/Logs/JobBunny/${label}.err.log`;

    const xml = renderPlist({
      Label: label,
      ProgramArguments: ['/bin/bash', '-lc', cmd],
      StartCalendarInterval: startCalendarInterval,
      RunAtLoad: false,
      WorkingDirectory: root,
      StandardOutPath: outLog,
      StandardErrorPath: errLog,
    });

    result.push({ label, time, profiles, xml });
  }

  return result;
}
