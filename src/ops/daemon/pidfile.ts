/**
 * ops/daemon/pidfile.ts — the scheduling daemon's own supervision state:
 * a heartbeat (lastTickAt, D22) instead of an age check (unlike
 * ops/scheduling/run_lock.ts's 4-hour DEFAULT_MAX_AGE_MS — see
 * isDaemonPidfileStale below for why that rule is wrong here), an
 * attempts ledger (D19, closes the respawn-storm gap left by run folders
 * being created lazily), and an inFlight child pid so `serve stop` can
 * find and kill an in-progress run even if the daemon itself has died.
 *
 * File location: `<root>/.jobbunny-daemon.pid`, sibling to
 * `<root>/.jobbunny-run.lock` — same directory convention, a different
 * file, so the daemon's own long-lived supervision state never collides
 * with a single run's cross-process exclusive lock.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DaemonAttempt {
  profile: string;
  date: string; // "YYYY-MM-DD" local
  slot: string; // "HH:MM" local
}

export interface DaemonInFlight {
  pid: number; // pid of the child run currently executing
  profile: string;
  startedAt: string; // ISO 8601
}

export interface DaemonPidfile {
  pid: number;
  startedAt: string; // ISO 8601
  lastTickAt: string; // ISO 8601
  inFlight?: DaemonInFlight;
  attempts: DaemonAttempt[];
}

export interface DaemonPidfileDeps {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  writeFileSyncExclusive(path: string, data: string): boolean; // wx flag; false on EEXIST
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  pidIsAlive(pid: number): boolean;
  now(): Date;
}

/** 5 minutes = 10 missed ticks at the 30s cadence (D22). Replaces
 * run_lock.ts's 4-hour age rule, which is correct for a single bounded
 * run and wrong for a process meant to live for days: from hour 4 onward
 * it would judge every healthy daemon stale and let a new `serve start`
 * steal a live daemon's pidfile. */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

export function daemonPidfilePath(root: string): string {
  return join(root, '.jobbunny-daemon.pid');
}

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

/** Creates the pidfile via an exclusive (`wx`) write — the actual
 * mutual-exclusion guarantee, identical mechanism to run_lock.ts's
 * tryCreate. Returns false (does not throw) if a pidfile already exists;
 * the caller is responsible for staleness-checking and stealing it. */
export function acquireDaemonPidfile(
  root: string,
  pid: number,
  deps: DaemonPidfileDeps,
): boolean {
  const path = daemonPidfilePath(root);
  const initial: DaemonPidfile = {
    pid,
    startedAt: deps.now().toISOString(),
    lastTickAt: deps.now().toISOString(),
    attempts: [],
  };
  return deps.writeFileSyncExclusive(path, JSON.stringify(initial));
}

/** Shape-checks a parsed `inFlight` value: either absent, or the full
 * `DaemonInFlight` object (`pid`/`profile`/`startedAt`) — never the old
 * bare-number form. A partially-shaped object is treated the same as
 * absent (malformed ⇒ safe to drop, not safe to trust). */
function parseInFlight(value: unknown): DaemonInFlight | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<DaemonInFlight>;
  if (
    typeof candidate.pid === 'number' &&
    typeof candidate.profile === 'string' &&
    typeof candidate.startedAt === 'string'
  ) {
    return {
      pid: candidate.pid,
      profile: candidate.profile,
      startedAt: candidate.startedAt,
    };
  }
  return undefined;
}

function parsePidfile(raw: string): DaemonPidfile | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonPidfile>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.lastTickAt === 'string' &&
      Array.isArray(parsed.attempts)
    ) {
      return {
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        lastTickAt: parsed.lastTickAt,
        inFlight: parseInFlight(parsed.inFlight),
        attempts: parsed.attempts as DaemonAttempt[],
      };
    }
    return undefined; // malformed shape — treated the same as unreadable.
  } catch {
    return undefined; // corrupt JSON — same treatment.
  }
}

/** Reads and parses the pidfile. A reader that fails to parse retries
 * once — the same "unreadable ⇒ stale ⇒ safe to steal" posture
 * run_lock.ts already documents for its own lock file — before treating
 * the file as corrupt and returning undefined. Returns undefined (never
 * throws) when the pidfile doesn't exist. */
export function readDaemonPidfile(
  root: string,
  deps: DaemonPidfileDeps,
): DaemonPidfile | undefined {
  const path = daemonPidfilePath(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      raw = deps.readFileSync(path);
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return undefined;
      throw err;
    }
    const parsed = parsePidfile(raw);
    if (parsed) return parsed;
    // First attempt failed to parse — retry once before giving up.
  }
  return undefined;
}

/** Every in-place update (heartbeat, inFlight, attempts) goes through
 * here: SYNCHRONOUS write-to-temp then rename-over-target. Synchronous,
 * not run_folder.ts's async writeAtomic, so the heartbeat write Task 7
 * places outside the reentrancy guard can never interleave with this same
 * function's own guarded-body calls — Node's single-threaded event loop
 * runs a sync write-then-rename to completion without yielding. A no-op
 * if the pidfile is currently unreadable (nothing safe to mutate). */
export function updateDaemonPidfile(
  root: string,
  mutate: (current: DaemonPidfile) => DaemonPidfile,
  deps: DaemonPidfileDeps,
): void {
  const current = readDaemonPidfile(root, deps);
  if (!current) return;
  const next = mutate(current);
  const path = daemonPidfilePath(root);
  const tmpPath = `${path}.tmp`;
  deps.writeFileSync(tmpPath, JSON.stringify(next));
  deps.renameSync(tmpPath, path);
}

/** Removes the pidfile. Tolerates an already-absent file (nothing to do). */
export function releaseDaemonPidfile(root: string, deps: DaemonPidfileDeps): void {
  const path = daemonPidfilePath(root);
  try {
    deps.unlinkSync(path);
  } catch (err) {
    if (!hasCode(err, 'ENOENT')) throw err;
  }
}

/** Stale (safe to steal) when the recorded pid is dead, OR the heartbeat
 * (lastTickAt) is older than HEARTBEAT_STALE_MS — NOT run_lock.ts's
 * 4-hour DEFAULT_MAX_AGE_MS, which is the wrong rule for a long-lived
 * daemon (see HEARTBEAT_STALE_MS's doc comment above). An undefined
 * (missing or corrupt) pidfile is always stale. */
export function isDaemonPidfileStale(
  file: DaemonPidfile | undefined,
  deps: DaemonPidfileDeps,
): boolean {
  if (!file) return true;
  if (!deps.pidIsAlive(file.pid)) return true;
  const age = deps.now().getTime() - Date.parse(file.lastTickAt);
  return Number.isFinite(age) && age > HEARTBEAT_STALE_MS;
}

/** Builds the real (non-test) DaemonPidfileDeps. Mirrors
 * run_lock.ts's defaultRunLockDeps exactly. */
export function defaultDaemonPidfileDeps(): DaemonPidfileDeps {
  return {
    existsSync: (p) => existsSync(p),
    readFileSync: (p) => readFileSync(p, 'utf8'),
    writeFileSync: (p, data) => {
      writeFileSync(p, data, 'utf8');
    },
    writeFileSyncExclusive: (p, data) => {
      try {
        writeFileSync(p, data, { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch (err) {
        if (hasCode(err, 'EEXIST')) return false;
        throw err;
      }
    },
    renameSync: (from, to) => renameSync(from, to),
    unlinkSync: (p) => unlinkSync(p),
    pidIsAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // ESRCH: no such process — dead. EPERM: exists but owned by
        // someone else — still alive. Anything else: assume alive.
        return !hasCode(err, 'ESRCH');
      }
    },
    now: () => new Date(),
  };
}
