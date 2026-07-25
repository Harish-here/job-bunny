/**
 * run_lock.ts (P9 closure register §9, final item) — a cross-process,
 * cross-profile exclusive lock that makes two `jobbunny run` invocations
 * unable to execute a pipeline at the same time, REGARDLESS of which
 * profile(s) they're for or which launchd job (i.e. which distinct
 * schedule time) spawned them.
 *
 * Why this is needed even though `adapters/scheduler/launchd/plist.ts`
 * already chains profiles that share ONE schedule time into a single
 * launchd job (see its `buildCommand`): that only serializes profiles
 * within the SAME time slot. Two DIFFERENT time slots are two SEPARATE
 * launchd jobs/process trees with no coordination between them. Since the
 * run-level cap was raised to a derived ~141min worst case
 * (`cli/commands/run.ts`'s `computeRunCapMs`), an overrunning run can now
 * plausibly still be alive when the next slot fires — and every profile
 * shares exactly one Chrome/CDP session on port 9222 backed by one
 * `.chrome-debug` user-data-dir, so concurrent runs would fight over the
 * browser and corrupt each other's harvest. v0 never needed this: its
 * `run_scheduled.sh` run-cap was a fixed 30 min and schedule slots were
 * spaced hours apart, so cross-slot overlap was never a realistic case.
 *
 * Mechanism: a single lock FILE at `<root>/.jobbunny-run.lock`, holding
 * `{ pid, profile, startedAt }` JSON, created with an OS-level exclusive
 * open (`wx` — fails with `EEXIST` if the file already exists). That
 * exclusive-create is the actual atomicity guarantee across processes;
 * everything else here is bookkeeping and stale-lock recovery.
 *
 * Crash recovery: a lock is judged STALE (safe to steal) if EITHER (a) no
 * process with the recorded pid is currently alive (the primary signal —
 * covers the common case, a run that died via SIGKILL and never reached
 * its own cleanup), OR (b) the lock is older than `maxAgeMs` regardless of
 * liveness (a defense-in-depth fallback for the rare case of a stale pid
 * having been recycled by an unrelated process). `maxAgeMs` defaults to
 * 4 hours — comfortably above the ~141min worst-case run cap so a
 * legitimately slow but still-alive run is never stolen out from under
 * itself, while still bounding how long a truly-wedged lock can survive.
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface LockInfo {
  pid: number;
  profile: string;
  startedAt: string; // ISO 8601
}

export type AcquireLockResult =
  | { acquired: true }
  | { acquired: false; heldBy: LockInfo };

/** Injected dependencies — every call site (including the real default)
 * supplies these explicitly so tests never touch a real file or a real
 * process table. */
export interface RunLockDeps {
  lockPath: string;
  pid: number;
  now: () => Date;
  /** True iff a process with this pid is currently alive. Real default:
   * `process.kill(pid, 0)` (throws ESRCH if dead, succeeds — or throws
   * EPERM, which still means "alive" — otherwise). */
  pidIsAlive: (pid: number) => boolean;
  readFile: (path: string) => string;
  /** Must throw an error with `.code === 'EEXIST'` if `path` already
   * exists — the actual cross-process atomicity guarantee. */
  writeFileExclusive: (path: string, content: string) => void;
  unlink: (path: string) => void;
  /** See header comment. Default: 4 hours. */
  maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

function readLockInfo(deps: RunLockDeps): LockInfo | undefined {
  let raw: string;
  try {
    raw = deps.readFile(deps.lockPath);
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return undefined;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.profile === 'string' &&
      typeof parsed.startedAt === 'string'
    ) {
      return { pid: parsed.pid, profile: parsed.profile, startedAt: parsed.startedAt };
    }
    return undefined; // malformed shape — treated the same as "unreadable" by the caller.
  } catch {
    return undefined; // corrupt JSON — same treatment.
  }
}

function isStale(deps: RunLockDeps, info: LockInfo | undefined): boolean {
  if (!info) return true; // unreadable/corrupt lock file — always safe to steal.
  if (!deps.pidIsAlive(info.pid)) return true;
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const age = deps.now().getTime() - Date.parse(info.startedAt);
  return Number.isFinite(age) && age > maxAgeMs;
}

function tryCreate(deps: RunLockDeps, profile: string): boolean {
  const content = JSON.stringify({
    pid: deps.pid,
    profile,
    startedAt: deps.now().toISOString(),
  } satisfies LockInfo);
  try {
    deps.writeFileExclusive(deps.lockPath, content);
    return true;
  } catch (err) {
    if (hasCode(err, 'EEXIST')) return false;
    throw err;
  }
}

/** Attempts to acquire the run lock for `profile`. Steals a stale lock
 * (dead pid, or older than `maxAgeMs`) and retries exactly once — bounded
 * so a persistent race (two processes both stealing in a tight loop)
 * cannot spin forever; the loser of that race simply reports `heldBy` the
 * winner's info, which is correct (someone else is now running). */
export function acquireRunLock(deps: RunLockDeps, profile: string): AcquireLockResult {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(deps, profile)) return { acquired: true };

    const info = readLockInfo(deps);
    if (!isStale(deps, info)) {
      // info is guaranteed defined here: isStale(deps, undefined) is always true.
      return { acquired: false, heldBy: info as LockInfo };
    }
    try {
      deps.unlink(deps.lockPath);
    } catch (err) {
      if (!hasCode(err, 'ENOENT')) throw err; // someone else already cleaned it up — fine.
    }
    // loop again: retry the exclusive create now that the stale lock is gone.
  }
  // Extremely unlikely (two full attempts both lost the race) — report whoever holds it now.
  const info = readLockInfo(deps);
  return info ? { acquired: false, heldBy: info } : { acquired: true };
}

/** Releases the lock ONLY if it's still ours (matching pid) — a lock
 * already stolen (by another process's stale-recovery, in some pathological
 * timing) must never be released out from under its new legitimate holder.
 * Tolerates an already-absent lock file (nothing to do). */
export function releaseRunLock(deps: RunLockDeps): void {
  const info = readLockInfo(deps);
  if (!info) return; // already gone or unreadable — nothing safe to do.
  if (info.pid !== deps.pid) return; // not ours anymore — leave it alone.
  try {
    deps.unlink(deps.lockPath);
  } catch (err) {
    if (!hasCode(err, 'ENOENT')) throw err;
  }
}

/** Builds the real (non-test) `RunLockDeps` for a given lock file path. */
export function defaultRunLockDeps(lockPath: string): RunLockDeps {
  return {
    lockPath,
    pid: process.pid,
    now: () => new Date(),
    pidIsAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // ESRCH: no such process — dead. EPERM: exists but owned by someone
        // else — still alive. Anything else: assume alive (fail toward
        // NOT stealing a lock we can't actually prove is dead).
        return !hasCode(err, 'ESRCH');
      }
    },
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFileExclusive: (p, content) => {
      writeFileSync(p, content, { encoding: 'utf8', flag: 'wx' });
    },
    unlink: (p) => unlinkSync(p),
  };
}
