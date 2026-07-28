/**
 * cli/commands/serve/lifecycle.ts — `serve stop`'s kill-and-confirm
 * machinery: SIGTERM, poll for death, SIGKILL if it didn't take, poll
 * again. Split out of `serve.ts` (task 5, 2026-07-28 file-size split
 * plan); see `./index.ts` for the shared `ServeDeps` bag and dispatch.
 */
import {
  readDaemonPidfile,
  releaseDaemonPidfile,
  SIGKILL_GRACE_MS,
} from '../../../ops/daemon/index.ts';
import type { ServeDeps } from './index.ts';

const POLL_INTERVAL_MS = 250;

export async function waitUntilDead(
  pid: number,
  graceMs: number,
  deps: ServeDeps,
): Promise<boolean> {
  const maxAttempts = Math.ceil(graceMs / POLL_INTERVAL_MS);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!deps.pidIsAlive(pid)) return true;
    await deps.sleep(POLL_INTERVAL_MS);
  }
  return !deps.pidIsAlive(pid);
}

/** SIGTERM → poll until dead or SIGKILL_GRACE_MS → SIGKILL → poll again.
 * `ESRCH` at any step is already-dead, not an error (absorbed by
 * `pidIsAlive`/`killPid`). Reused for both the daemon and its `inFlight`
 * child (D10) — same constant, not a second one. */
export async function killAndConfirmDead(pid: number, deps: ServeDeps): Promise<boolean> {
  if (!deps.pidIsAlive(pid)) return true;
  deps.killPid(pid, 'SIGTERM');
  if (await waitUntilDead(pid, SIGKILL_GRACE_MS, deps)) return true;
  deps.killPid(pid, 'SIGKILL');
  return waitUntilDead(pid, SIGKILL_GRACE_MS, deps);
}

export async function runServeStop(deps: ServeDeps): Promise<number> {
  const file = readDaemonPidfile(deps.root, deps.pidfile);
  if (!file) {
    deps.write('serve stop: no daemon pidfile found — nothing to stop');
    return 0;
  }

  // D10: daemon FIRST. Killing the child first would let the daemon's
  // own `await` on it resolve and spawn the NEXT owed run before the
  // daemon's own SIGTERM lands, orphaning that next child.
  const daemonDead = await killAndConfirmDead(file.pid, deps);
  if (!daemonDead) {
    deps.writeErr(`serve stop: daemon (pid ${file.pid}) survived SIGKILL`);
    return 1;
  }

  // Safe to re-read now: a dead daemon cannot spawn or write to the
  // pidfile again, so its last write is authoritative. B1: this re-read
  // is exactly why the daemon child's own shutdown handler must NOT
  // release the pidfile on SIGTERM — if it did, this read would find
  // nothing and the in-flight child below would never be found or killed.
  const after = readDaemonPidfile(deps.root, deps.pidfile);
  if (after?.inFlight !== undefined) {
    const childDead = await killAndConfirmDead(after.inFlight.pid, deps);
    if (!childDead) {
      deps.writeErr(
        `serve stop: in-flight child (pid ${after.inFlight.pid}) survived SIGKILL`,
      );
      return 1;
    }
  }

  releaseDaemonPidfile(deps.root, deps.pidfile);
  deps.write('serve stop: daemon stopped');
  return 0;
}
