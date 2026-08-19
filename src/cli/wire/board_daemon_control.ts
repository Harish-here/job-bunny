/**
 * cli/wire/board_daemon_control.ts (settings-overhaul, task 11 — BE-gate
 * findings F1/F8) — `BoardSource.stopDaemon`'s real implementation.
 * Deliberately its own sibling module, separate from the existing
 * READ-ONLY `board_daemon.ts` (read vs. write is the same split the port
 * itself already draws elsewhere), and split out of `board.ts` for the
 * same file-size-cap reason `board_daemon.ts`/`board_doctor.ts`/
 * `board_preview.ts` already are.
 *
 * `stopDaemon()` reuses `runServeStop`'s FULL four-step kill-and-confirm
 * lifecycle (`cli/commands/serve/lifecycle.ts`) — NOT a bare signal send.
 * The original spec for this step ("send the exact same signal `jobbunny
 * serve stop` sends, degrade to `already_stopped` on any failure") was
 * found defective (F1): it mis-specified the mechanism and inverted a real
 * failure (a daemon that survives SIGKILL) into a false success. Every
 * branch below is a typed `StopDaemonOutcome` — this function never
 * throws.
 */
import {
  defaultDaemonPidfileDeps,
  readDaemonPidfile,
  releaseDaemonPidfile,
} from '../../ops/daemon/index.ts';
import type { StopDaemonOutcome } from '../../ports/board.ts';
import { type KillDeps, killAndConfirmDead } from '../commands/serve/lifecycle.ts';

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

/** Real `process.kill` send, ESRCH (already-dead) absorbed — same idiom as
 * `cli/commands/serve/index.ts`'s own `defaultServeDeps().killPid`, not
 * importable from here (that function is private to `index.ts`), so
 * mirrored rather than duplicating the whole `ServeDeps` construction. */
function realKillPid(pid: number, signal: string): void {
  try {
    process.kill(pid, signal as NodeJS.Signals);
  } catch (err) {
    if (!hasCode(err, 'ESRCH')) throw err;
  }
}

export interface BoardDaemonControlOverrides {
  root: string;
  /** Test-only seam: overrides pid liveness for BOTH the pidfile deps'
   * staleness probe and the kill loop's own poll — mirrors
   * `board_daemon.ts`'s `BoardDaemonOverrides.pidIsAlive`: the two are
   * always the SAME probe (B3, `cli/commands/serve/index.ts`), never two
   * independently-written copies. Default: the real `process.kill(pid, 0)`
   * probe. */
  pidIsAlive?: (pid: number) => boolean;
  /** Test-only seam: replaces the real `process.kill` send. Default:
   * `realKillPid` above. */
  killPid?: (pid: number, signal: string) => void;
  /** Test-only seam: replaces the real poll delay so a test never actually
   * waits out `SIGKILL_GRACE_MS`. Default: a real `setTimeout`-backed
   * sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** `BoardSource.stopDaemon`'s real implementation. Never throws — every
 * branch is a typed `StopDaemonOutcome`. See this module's own doc comment
 * for why this is the full 4-step lifecycle, not a bare signal. */
export async function stopBoardDaemon(
  overrides: BoardDaemonControlOverrides,
): Promise<StopDaemonOutcome> {
  const defaults = defaultDaemonPidfileDeps();
  const pidIsAlive = overrides.pidIsAlive ?? defaults.pidIsAlive;
  const pidfileDeps = { ...defaults, pidIsAlive };
  const killDeps: KillDeps = {
    pidIsAlive,
    killPid: overrides.killPid ?? realKillPid,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  // Step 1 — no pidfile at all: nothing to stop.
  const file = readDaemonPidfile(overrides.root, pidfileDeps);
  if (!file) return { outcome: 'already_stopped' };

  // Step 2 — daemon FIRST (D10, `lifecycle.ts`'s own comment: killing the
  // child first would let the daemon's own `await` on it resolve and spawn
  // the next owed run before the daemon's own SIGTERM lands, orphaning
  // that next child). A survived SIGKILL is a DISTINCT, visible outcome —
  // never reported as `already_stopped`; that would be the exact
  // false-success this design exists to prevent.
  const daemonDead = await killAndConfirmDead(file.pid, killDeps);
  if (!daemonDead) return { outcome: 'daemon_unresponsive' };

  // Step 3 — re-read the pidfile. This step exists on purpose: the daemon
  // child's own shutdown handler deliberately does NOT release the
  // pidfile on SIGTERM (`cli/commands/serve/start.ts:232-243`), precisely
  // so this re-read still finds an in-flight child to kill. Skipping it
  // orphans a live run holding Chrome open.
  const after = readDaemonPidfile(overrides.root, pidfileDeps);
  if (after?.inFlight !== undefined) {
    const childDead = await killAndConfirmDead(after.inFlight.pid, killDeps);
    if (!childDead) {
      return { outcome: 'child_unresponsive', childPid: after.inFlight.pid };
    }
  }

  // Step 4 — only once BOTH the daemon and any in-flight child are
  // confirmed dead.
  releaseDaemonPidfile(overrides.root, pidfileDeps);
  return { outcome: 'stopped' };
}
