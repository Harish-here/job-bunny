import { join } from 'node:path';

/**
 * Diagnostics for a Chrome that dies right after spawn (2026-11-03/04
 * incident: the spawned Chrome exited ~210ms after launch — consistent with
 * a singleton handoff to another Chrome holding the same user-data-dir —
 * while the connect loop polled for the full 10s and reported only "gave up
 * connecting", with Chrome's stderr discarded).
 *
 * Chrome's stderr goes to a file in the user-data-dir (never a pipe: a
 * pipe nobody drains blocks Chrome, and a pipe whose reader exits hands
 * Chrome EPIPE), truncated at each launch so it is bounded by one Chrome's
 * lifetime. It is read only on the failure path. Nothing here is on the
 * success path's critical path, and every fs failure degrades to "no
 * diagnostics" — diagnostics must never fail a launch.
 */
export const STDERR_LOG_NAME = '.jobbunny-chrome-stderr.log';

const STDERR_TAIL_CHARS = 2000;

export interface ChildExitDeps {
  openSync: (path: string, flags: 'w') => number;
  closeSync: (fd: number) => void;
  readFileSync: (path: string, encoding: 'utf8') => string;
  nowMs: () => number;
}

/** The slice of a ChildProcess this module listens to. */
export interface ExitWatchableChild {
  on?(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

/** Opens (truncating) the stderr log for the child to inherit. Returns
 * undefined when it cannot — e.g. the user-data-dir doesn't exist yet on a
 * first run; the caller then spawns with stderr ignored, as before. */
export function openStderrLog(
  userDataDir: string,
  deps: Pick<ChildExitDeps, 'openSync'>,
): number | undefined {
  try {
    return deps.openSync(join(userDataDir, STDERR_LOG_NAME), 'w');
  } catch {
    return undefined;
  }
}

function readTail(
  userDataDir: string,
  deps: Pick<ChildExitDeps, 'readFileSync'>,
  captured: boolean,
): string {
  if (!captured) return '(not captured)';
  try {
    const text = deps.readFileSync(join(userDataDir, STDERR_LOG_NAME), 'utf8').trim();
    return text === '' ? '(empty)' : text.slice(-STDERR_TAIL_CHARS);
  } catch {
    return '(unreadable)';
  }
}

/** Starts watching `child` for an early exit. Returns a probe: undefined
 * while the child is alive (or can't be watched), else a ready-to-throw
 * message naming the exit status, the time since launch, and the stderr
 * tail. The listeners don't keep the event loop alive. */
export function watchEarlyExit(
  child: ExitWatchableChild,
  opts: { port: number; userDataDir: string; stderrCaptured: boolean },
  deps: Pick<ChildExitDeps, 'readFileSync' | 'nowMs'>,
): () => string | undefined {
  const startedAt = deps.nowMs();
  let status: string | undefined;
  const record = (what: string) => {
    status ??= `${what} ${deps.nowMs() - startedAt}ms after launch`;
  };
  child.on?.('exit', (code, signal) => {
    record(`Chrome exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`);
  });
  child.on?.('error', (err) => {
    record(`Chrome process error (${err.message})`);
  });
  return () => {
    if (status === undefined) return undefined;
    const tail = readTail(opts.userDataDir, deps, opts.stderrCaptured);
    return (
      `${status}, before CDP port ${opts.port} came up — typical of a handoff to another ` +
      `Chrome already running on user-data-dir ${opts.userDataDir}; stderr tail: ${tail}`
    );
  };
}
