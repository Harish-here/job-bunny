/**
 * cli/commands/serve/start.ts — `serve start`'s two halves: the PARENT
 * (acquires the pidfile, spawns a detached child, confirms it's alive,
 * exits) and the CHILD (`--daemon-child`, runs the tick loop in the
 * foreground). Split out of `serve.ts` (task 5, 2026-07-28 file-size split
 * plan); see `./index.ts` for the shared `ServeDeps` bag and dispatch.
 */
import {
  acquireDaemonPidfile,
  createDaemon,
  createSpawnRun,
  type DaemonDeps,
  isDaemonPidfileStale,
  readDaemonPidfile,
  releaseDaemonPidfile,
  type SuperviseDeps,
  updateDaemonPidfile,
} from '../../../ops/daemon/index.ts';
import {
  daemonLogPath,
  openAppendFd,
  rotateIfLarge,
} from '../../../ops/daemon/logs/index.ts';
import { createDaemonLogger } from '../../../ops/observability/index.ts';
import { computeRunCapMs } from '../../../pipeline/stages/budgets.ts';
import { LEGACY_PLIST_REGEX, migrationCleanupBlock, type ServeDeps } from './index.ts';

/** One 30s tick plus a 5s margin (D22/A15.4) — see `isDaemonPidfileStale`'s
 * own doc comment for why an alive-but-stale-heartbeat pid isn't stolen
 * on first observation. */
const STEAL_RECHECK_WAIT_MS = 35_000;
const CHILD_ALIVE_CHECK_MS = 2_000;

export async function runServeStartParent(deps: ServeDeps): Promise<number> {
  if (deps.platform === 'darwin') {
    const legacy = deps.listLaunchAgentFiles().filter((f) => LEGACY_PLIST_REGEX.test(f));
    if (legacy.length > 0) {
      deps.writeErr(migrationCleanupBlock(legacy, deps.uid));
      return 1;
    }
  }

  let acquired = acquireDaemonPidfile(deps.root, deps.pid, deps.pidfile);
  if (!acquired) {
    const existing = readDaemonPidfile(deps.root, deps.pidfile);
    if (!isDaemonPidfileStale(existing, deps.pidfile)) {
      deps.writeErr(
        `serve start: a daemon is already running (pid ${existing?.pid}, started ${existing?.startedAt})`,
      );
      return 1;
    }
    // D22/A15.4: an alive-but-stale-heartbeat pid gets one re-check,
    // 35s later, before stealing — a machine that just woke from sleep
    // legitimately shows a stale heartbeat for up to one tick. A dead
    // pid steals immediately, no wait.
    const observedHeartbeat = existing?.lastTickAt;
    if (existing && deps.pidIsAlive(existing.pid)) {
      await deps.sleep(STEAL_RECHECK_WAIT_MS);
      const recheck = readDaemonPidfile(deps.root, deps.pidfile);
      if (recheck && recheck.lastTickAt !== observedHeartbeat) {
        deps.writeErr(
          `serve start: a daemon is already running (pid ${recheck.pid}, started ${recheck.startedAt})`,
        );
        return 1;
      }
    }
    // S3: `releaseDaemonPidfile` below is an unconditional unlink, so two
    // `serve start`s that both reach this point (both passed the 35s
    // re-check, or both observed the same dead pid) could otherwise
    // release/acquire over each other — the second unlinking the
    // first's freshly-created pidfile. One more re-read, immediately
    // before the release, narrows that window to a residual
    // microsecond-scale race (accepted, the same posture as
    // `run_lock`'s own bounded steal) rather than the multi-tens-of-
    // seconds window the 35s wait alone would leave open.
    const finalCheck = readDaemonPidfile(deps.root, deps.pidfile);
    if (finalCheck && finalCheck.lastTickAt !== observedHeartbeat) {
      deps.writeErr(
        `serve start: a daemon is already running (pid ${finalCheck.pid}, started ${finalCheck.startedAt})`,
      );
      return 1;
    }
    releaseDaemonPidfile(deps.root, deps.pidfile);
    acquired = acquireDaemonPidfile(deps.root, deps.pid, deps.pidfile);
    if (!acquired) {
      deps.writeErr('serve start: could not acquire the daemon pidfile');
      return 1;
    }
  }

  const logPath = daemonLogPath(deps.home);
  rotateIfLarge(logPath, deps.logs); // start-only rotation (Task 6/D21).
  const fd = openAppendFd(logPath, deps.logs);

  const child = deps.spawn(
    deps.nodeBin,
    [deps.cliEntry, 'serve', 'start', '--daemon-child'],
    { stdio: ['ignore', fd, fd], detached: true },
  );
  deps.logs.closeSync(fd);

  let spawnErrored = false;
  child.on('error', () => {
    spawnErrored = true;
  });

  // F8: the parent does NOT write the child's pid here. It used to, which
  // raced the child's own boot-time write of the same field — two writers,
  // no ordering guarantee, and a losing parent write could leave the
  // pidfile naming a process that has already exited. The parent's `wx`
  // acquire above covers the boot window with its own pid (so a concurrent
  // `serve start` still finds a live owner), the child overwrites it with
  // its own pid as its first action, and the 2s alive-confirm below reads
  // the spawn handle's pid rather than the file.
  child.unref?.();

  await deps.sleep(CHILD_ALIVE_CHECK_MS);
  const alive =
    typeof child.pid === 'number' && !spawnErrored && deps.pidIsAlive(child.pid);
  if (!alive) {
    releaseDaemonPidfile(deps.root, deps.pidfile);
    deps.writeErr(
      `serve start: daemon child died immediately — tail of daemon.log:\n${deps.readDaemonLogTail()}`,
    );
    return 1;
  }
  deps.write(`serve start: daemon running (pid ${child.pid})`);
  return 0;
}

export async function runServeStartChild(deps: ServeDeps): Promise<number> {
  // F8: FIRST action — claim the pidfile's `pid` field for this process.
  // The parent created the file under its OWN pid (an `wx` placeholder
  // that keeps a concurrent `serve start` out during the boot window) and
  // deliberately never overwrites it, so this is the single write that
  // makes `serve stop`/`serve status`/staleness checks point at the
  // process that actually runs the tick loop.
  updateDaemonPidfile(
    deps.root,
    (current) => ({ ...current, pid: deps.pid }),
    deps.pidfile,
  );

  const runCapMs = computeRunCapMs();
  // Lands in daemon.log via the parent's stdio redirection (§6.1) — this
  // process's own stdout was already pointed at the fd before spawn(), so
  // a plain console.log (via createDaemonLogger's `write`) is all that's
  // needed here. Events now emit as {ts,level,msg,data} — the same shape
  // every other logger in the system uses — rather than the old bespoke
  // {event,...data,ts} shape; the mechanism (stdout -> fd) is unchanged.
  const daemonLogger = createDaemonLogger();
  const log = (
    event: string,
    data?: Record<string, unknown>,
    level: 'info' | 'warn' | 'error' = 'info',
  ): void => {
    daemonLogger[level](event, data);
  };

  const superviseDeps: SuperviseDeps = {
    spawn: deps.spawn,
    pidfile: deps.pidfile,
    logs: deps.logs,
    root: deps.root,
    home: deps.home,
    nodeBin: deps.nodeBin,
    cliEntry: deps.cliEntry,
    runCapMs,
    log,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };

  const daemonDeps: DaemonDeps = {
    root: deps.root,
    profilesDir: deps.profilesDir,
    scan: deps.scan,
    pidfile: deps.pidfile,
    spawnRun: createSpawnRun(superviseDeps),
    readRunHistory: deps.readRunHistory,
    log,
    now: () => new Date(),
  };

  const daemon = createDaemon(daemonDeps);
  daemon.start();

  // §6.1: the child's only job is the tick loop — it never touches the
  // pidfile's create step (the parent already did) and resolves only on
  // a shutdown signal. B1: the shutdown handler does NOT release the
  // pidfile — removal belongs exclusively to `serve stop`, and only
  // after BOTH the daemon and any in-flight child are confirmed dead
  // (`runServeStop`). Releasing it here would delete the pidfile
  // the instant SIGTERM lands, so `serve stop`'s own re-read (which
  // finds the `inFlight` child to kill) would find nothing and a
  // still-running child would survive a successful stop. A daemon that
  // dies any other way (crash, kill -9) simply leaves a dead-pid pidfile
  // behind — D22's staleness rule (`isDaemonPidfileStale`) self-heals
  // that on the next `serve start`.
  return new Promise<number>((resolve) => {
    const shutdown = (): void => {
      daemon.stop();
      resolve(0);
      // Exit NOW rather than unwinding: an in-flight run child's own
      // handle keeps this process's event loop alive for the rest of that
      // child's runtime (up to the full run cap), so `serve stop` would
      // burn its entire 20s grace and then SIGKILL a daemon that had
      // already shut down cleanly. The run child survives the parent's
      // exit (POSIX), `inFlight` stays on disk, and `serve stop`'s own
      // post-daemon re-read finds and kills it — the designed path.
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
