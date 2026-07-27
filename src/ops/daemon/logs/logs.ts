/**
 * ops/daemon/logs/logs.ts — ~/.jobbunny/logs/ (D16), replacing the
 * macOS-only ~/Library/Logs/JobBunny/. Rotation is deliberately
 * asymmetric between the two log files this daemon writes — see the
 * module-level rule in the plan/spec this implements (D21, §6.9): the
 * caller (the daemon's own spawn path, out of scope for this task) checks
 * runs.log's size before every child spawn (D6's sequential-execution
 * guarantee makes that the one safe quiet point), while daemon.log is
 * checked only once, at daemon start, because its fd is fixed at the
 * detached spawn and renaming an open-handle file fails on Windows.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface LogDeps {
  existsSync(path: string): boolean;
  mkdirSync(path: string): void;
  statSync(path: string): { size: number };
  renameSync(from: string, to: string): void;
  openSync(path: string, flags: string): number;
  closeSync(fd: number): void;
}

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export function jobbunnyLogDir(home: string): string {
  return join(home, '.jobbunny', 'logs');
}

export function daemonLogPath(home: string): string {
  return join(jobbunnyLogDir(home), 'daemon.log');
}

export function runsLogPath(home: string): string {
  return join(jobbunnyLogDir(home), 'runs.log');
}

/** Renames `path` to `<path>.1` (replacing any existing `.1`) if it's over
 * LOG_ROTATE_BYTES. A no-op when the file is missing or under threshold —
 * never opens a fresh replacement itself, since the caller reopens via
 * openAppendFd immediately after, at its own safe quiet point. */
export function rotateIfLarge(path: string, deps: LogDeps): void {
  if (!deps.existsSync(path)) return;
  const { size } = deps.statSync(path);
  if (size <= LOG_ROTATE_BYTES) return;
  deps.renameSync(path, `${path}.1`);
}

/** Creates the log directory if it doesn't exist yet, then opens `path`
 * for append (flag 'a'), returning the fd. */
export function openAppendFd(path: string, deps: LogDeps): number {
  const dir = dirname(path);
  if (!deps.existsSync(dir)) {
    deps.mkdirSync(dir);
  }
  return deps.openSync(path, 'a');
}

/** Builds the real (non-test) LogDeps. mkdirSync uses {recursive: true}
 * so ~/.jobbunny/logs/ is created in one call even when ~/.jobbunny/
 * doesn't exist yet — the injected signature itself stays a plain
 * single-path function; recursion is this implementation's own detail. */
export function defaultLogDeps(): LogDeps {
  return {
    existsSync: (p) => existsSync(p),
    mkdirSync: (p) => {
      mkdirSync(p, { recursive: true });
    },
    statSync: (p) => statSync(p),
    renameSync: (from, to) => renameSync(from, to),
    openSync: (p, flags) => openSync(p, flags),
    closeSync: (fd) => closeSync(fd),
  };
}
