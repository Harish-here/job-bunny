import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chrome pid file (D12) — `<userDataDir>/.jobbunny-chrome.json`, written
 * at launchChrome's spawn time, read/self-healed by provider.ts's
 * launch() to decide reuse/recycle/launch without shelling out to
 * lsof/ps. Mirrors ops/scheduling/run_lock.ts's injectable-deps shape
 * (RunLockDeps -> ChromePidfileDeps) so every caller — including the
 * real default — supplies fs/process deps explicitly and tests never
 * touch a real filesystem or process table.
 */
export interface ChromePidfile {
  pid: number;
  port: number;
  startedAt: string; // ISO 8601
}

export interface ChromePidfileDeps {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  unlinkSync(path: string): void;
  pidIsAlive(pid: number): boolean;
  now(): Date;
}

const PIDFILE_NAME = '.jobbunny-chrome.json';

export function chromePidfilePath(userDataDir: string): string {
  return join(userDataDir, PIDFILE_NAME);
}

function isChromePidfileShape(value: unknown): value is ChromePidfile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ChromePidfile>;
  return (
    typeof v.pid === 'number' &&
    typeof v.port === 'number' &&
    typeof v.startedAt === 'string' &&
    Number.isFinite(Date.parse(v.startedAt))
  );
}

/**
 * Reads the pid file, self-healing as it goes: a dead recorded pid, or an
 * unparseable file, is deleted and treated as "no pid file" — never left
 * in place for a later reader to trust. A missing file is simply
 * undefined, with no delete attempt (nothing to delete).
 */
export function readChromePidfile(
  userDataDir: string,
  deps: ChromePidfileDeps,
): ChromePidfile | undefined {
  const path = chromePidfilePath(userDataDir);
  if (!deps.existsSync(path)) return undefined;

  let raw: string;
  try {
    raw = deps.readFileSync(path);
  } catch {
    // Unreadable for a reason other than "missing" (e.g. a permission
    // error, or a race with a concurrent writer) — don't guess at
    // whether it's safe to delete; just report "unknown".
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    deps.unlinkSync(path);
    return undefined;
  }

  if (!isChromePidfileShape(parsed)) {
    deps.unlinkSync(path);
    return undefined;
  }

  if (!deps.pidIsAlive(parsed.pid)) {
    deps.unlinkSync(path);
    return undefined;
  }

  return parsed;
}

export function writeChromePidfile(
  userDataDir: string,
  info: ChromePidfile,
  deps: ChromePidfileDeps,
): void {
  deps.writeFileSync(chromePidfilePath(userDataDir), JSON.stringify(info));
}

export function clearChromePidfile(userDataDir: string, deps: ChromePidfileDeps): void {
  const path = chromePidfilePath(userDataDir);
  if (!deps.existsSync(path)) return;
  deps.unlinkSync(path);
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

/** Real (non-test) ChromePidfileDeps — node:fs sync calls plus
 * process.kill(pid, 0) for liveness, mirroring
 * run_lock.ts's defaultRunLockDeps.pidIsAlive exactly: ESRCH means dead,
 * EPERM (owned by someone else) still means alive, anything else assumed
 * alive (fail toward not treating a live process as dead). */
export function defaultChromePidfileDeps(): ChromePidfileDeps {
  return {
    existsSync: (path) => existsSync(path),
    readFileSync: (path) => readFileSync(path, 'utf8'),
    writeFileSync: (path, data) => writeFileSync(path, data, 'utf8'),
    unlinkSync: (path) => unlinkSync(path),
    pidIsAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return !hasErrorCode(err, 'ESRCH');
      }
    },
    now: () => new Date(),
  };
}
