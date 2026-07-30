/**
 * ops/daemon/supervise/supervise.ts — the real SpawnRun that daemon.ts's
 * createDaemon() consumes as an injected function (Task 7). Builds
 * `<nodeBin> <cliEntry> run --profile <owed.profile> --headless`, rotates
 * runs.log immediately before spawning (D21/§6.9 — the safe quiet point,
 * since D6's sequential-execution guarantee means no other child can be
 * writing to it at that instant), captures the child's stdout/stderr into
 * the append fd, records/clears the daemon pidfile's `inFlight` pid, and
 * arms a SIGTERM→SIGKILL backstop that is a faithful PORT of the embedded
 * bash watchdog the retired plist carried inside `buildCommand`
 * (`adapters/scheduler/launchd/plist.ts`, deleted when the launchd
 * scheduler was removed) — the same +300s margin, the same 20s SIGKILL
 * grace, not a new policy (§6.5).
 *
 * This module knows nothing about pipeline stages, the CLI, or the
 * daemon's own tick loop — it only knows how to spawn and supervise ONE
 * child given an `OwedRun` and resolve to its exit code, exactly the
 * `SpawnRun` shape `daemon.ts` expects.
 */
import type { OwedRun } from '../../../core/schedule/index.ts';
import type { SpawnRun } from '../daemon.ts';
import type { LogDeps } from '../logs/index.ts';
import { openAppendFd, rotateIfLarge, runsLogPath } from '../logs/index.ts';
import type { DaemonPidfileDeps } from '../pidfile.ts';
import { updateDaemonPidfile } from '../pidfile.ts';

/** Same `+300s` margin the retired plist watchdog used
 * (`adapters/scheduler/launchd/plist.ts`'s
 * `backstopSeconds = ceil(runCapMs / 1000) + 300`) — a like-for-like
 * port, not a new number (§6.5). */
export const BACKSTOP_MARGIN_MS = 300_000;

/** Same `SIGKILL_GRACE_SECONDS = 20` constant the retired bash watchdog
 * used between its own SIGTERM and SIGKILL. */
export const SIGKILL_GRACE_MS = 20_000;

export interface SuperviseDeps {
  spawn(
    command: string,
    args: readonly string[],
    opts: { stdio: readonly unknown[] },
  ): {
    pid?: number;
    on(event: string, cb: (arg: unknown) => void): void;
    kill(signal: string): boolean;
  };
  pidfile: DaemonPidfileDeps;
  logs: LogDeps;
  root: string;
  home: string;
  nodeBin: string;
  cliEntry: string;
  runCapMs: number;
  log(
    event: string,
    data?: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error',
  ): void;
  setTimeout(cb: () => void, ms: number): { unref?(): void };
  clearTimeout(handle: unknown): void;
}

/** Builds the real SpawnRun: one child, `run --profile <p> --headless`,
 * captured to `runs.log`, backstopped, pidfile-tracked. */
export function createSpawnRun(deps: SuperviseDeps): SpawnRun {
  return (owed: OwedRun) =>
    new Promise<number>((resolve) => {
      // D21/§6.9: rotate BEFORE spawning — the safe quiet point, since
      // D6's sequential-execution guarantee means no other child can be
      // writing to runs.log at this instant.
      const logPath = runsLogPath(deps.home);
      rotateIfLarge(logPath, deps.logs);
      const fd = openAppendFd(logPath, deps.logs);

      // The try/catch covers the SYNCHRONOUS-throw path only (EMFILE at
      // fork time, a bad `nodeBin` on some platforms) — a spawn failure
      // reported the normal way, via the `error` event, is handled by the
      // handler further down instead. Without this, the fd opened above
      // is never closed on that path and the failure mode is
      // self-reinforcing: EMFILE leaks one more fd per attempt, making
      // the next EMFILE more certain on a daemon expected to live for
      // months (D20). Rethrown rather than swallowed, so the promise
      // still REJECTS — daemon.ts's tick already contains that (ee4e035),
      // and turning it into a resolve(1) would falsely report a child
      // that never existed as having run and exited.
      let child: ReturnType<SuperviseDeps['spawn']>;
      try {
        child = deps.spawn(
          deps.nodeBin,
          [deps.cliEntry, 'run', '--profile', owed.profile, '--headless'],
          { stdio: ['ignore', fd, fd] },
        );
      } catch (err) {
        deps.logs.closeSync(fd);
        throw err;
      }

      // The child now holds its own reference to the fd via the stdio
      // hand-off above — this process's own copy must be closed here, or
      // a daemon that lives for months (D20 autostart) leaks one fd per
      // spawned run for the rest of its life.
      deps.logs.closeSync(fd);

      // S1: the pid does not exist until spawn() returns, so recording
      // it is necessarily AFTER, not before, the call above. C1: inFlight
      // is the full DaemonInFlight object — pid, profile, and startedAt —
      // not a bare pid, so `serve status` can report which profile is
      // running and for how long, not just a number.
      if (typeof child.pid === 'number') {
        const childPid = child.pid;
        updateDaemonPidfile(
          deps.root,
          (current) => ({
            ...current,
            inFlight: {
              pid: childPid,
              profile: owed.profile,
              startedAt: deps.pidfile.now().toISOString(),
            },
          }),
          deps.pidfile,
        );
      }

      let settled = false;
      let backstop: ReturnType<SuperviseDeps['setTimeout']> | undefined;
      // Tracked in this ENCLOSING scope, not local to the backstop's own
      // callback below — otherwise a child that exits between SIGTERM and
      // SIGKILL_GRACE_MS leaves this nested timer dangling: `finish()`
      // would clear `backstop` (already fired, a no-op) but have no
      // reference to the still-pending SIGKILL timer to clear.
      let killTimer: ReturnType<SuperviseDeps['setTimeout']> | undefined;

      const clearInFlight = (): void => {
        updateDaemonPidfile(
          deps.root,
          (current) => ({ ...current, inFlight: undefined }),
          deps.pidfile,
        );
      };

      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        if (backstop) deps.clearTimeout(backstop);
        if (killTimer) deps.clearTimeout(killTimer);
        clearInFlight();
        resolve(code);
      };

      // §6.5: a faithful port of the retired plist's embedded bash
      // watchdog — SIGTERM, then SIGKILL after SIGKILL_GRACE_MS if the
      // child is still alive. On Windows, Node emulates both signals as
      // an unconditional terminate, so this escalation collapses to a
      // single hard kill — accepted (D10), no separate code path needed.
      backstop = deps.setTimeout(() => {
        deps.log('backstop-expired', { profile: owed.profile, slot: owed.slot }, 'warn');
        child.kill('SIGTERM');
        killTimer = deps.setTimeout(() => {
          child.kill('SIGKILL');
        }, SIGKILL_GRACE_MS);
        killTimer.unref?.();
      }, deps.runCapMs + BACKSTOP_MARGIN_MS);
      backstop.unref?.();

      child.on('exit', (code: unknown) => {
        finish(typeof code === 'number' ? code : 1);
      });

      // A5/A7: an `error` event (ENOENT, EMFILE) is treated exactly as a
      // nonzero exit — never thrown out of this executor, so it can
      // never kill the daemon. Task 7's ledger append (BEFORE calling
      // this function) already prevents a retry storm here (D19).
      child.on('error', (err: unknown) => {
        deps.log(
          'spawn-error',
          {
            profile: owed.profile,
            slot: owed.slot,
            error: String(err),
          },
          'error',
        );
        finish(1);
      });
    });
}
