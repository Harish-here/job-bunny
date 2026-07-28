/**
 * cli/commands/serve.ts (D2, D6) — `serve start|stop|status`, which
 * replaced the deleted `schedule install`/`schedule remove`. NO
 * `--profile` — cross-profile by design, the same posture `schedule
 * install` had. `start` splits into a PARENT (acquires the pidfile,
 * spawns a detached child, confirms it's alive, exits) and a CHILD
 * (`--daemon-child`, runs the tick loop in the foreground) — §6.1/S3.
 *
 * No `src/adapters/**` import here — the daemon spawns `jobbunny run` as
 * a plain child process (D3); this file never touches an adapter, and
 * derives its one adapter-adjacent number (`runCapMs`) from the pipeline's
 * own static `STAGE_BUDGETS` table (`pipeline/stages/budgets.ts`, Task 8,
 * not an adapter) rather than `cli/wire/`'s `compose.ts` — see the plan's Task 9
 * design note, and Task 8's `test/invariants/stage_budgets.test.ts` for
 * the drift guard that keeps that table honest.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatLocalDate, isRunOwed, nextFireAt } from '../../core/schedule/index.ts';
import {
  acquireDaemonPidfile,
  createDaemon,
  createSpawnRun,
  type DaemonDeps,
  type DaemonPidfileDeps,
  defaultDaemonPidfileDeps,
  HEARTBEAT_STALE_MS,
  isDaemonPidfileStale,
  readDaemonPidfile,
  releaseDaemonPidfile,
  SIGKILL_GRACE_MS,
  type SuperviseDeps,
  updateDaemonPidfile,
} from '../../ops/daemon/index.ts';
import {
  daemonLogPath,
  defaultLogDeps,
  type LogDeps,
  openAppendFd,
  rotateIfLarge,
} from '../../ops/daemon/logs/index.ts';
import {
  defaultScanDeps,
  type ScanDeps,
  scanProfileSchedules,
  scanRunHistory,
} from '../../ops/daemon/scan/index.ts';
import { computeRunCapMs } from '../../pipeline/stages/budgets.ts';

export const LEGACY_PLIST_REGEX = /^com\.jobbunny\.\d{4}\.plist$/;
/** One 30s tick plus a 5s margin (D22/A15.4) — see `isDaemonPidfileStale`'s
 * own doc comment for why an alive-but-stale-heartbeat pid isn't stolen
 * on first observation. */
const STEAL_RECHECK_WAIT_MS = 35_000;
const CHILD_ALIVE_CHECK_MS = 2_000;
const POLL_INTERVAL_MS = 250;

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

export interface SpawnHandle {
  pid?: number;
  on(event: string, cb: (arg: unknown) => void): void;
  kill(signal: string): boolean;
  unref?(): void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: { stdio: readonly unknown[]; detached?: boolean },
) => SpawnHandle;

export interface ServeDeps {
  root: string;
  home: string;
  platform: NodeJS.Platform;
  uid: number | undefined;
  pid: number;
  profilesDir: string;
  pidfile: DaemonPidfileDeps;
  logs: LogDeps;
  scan: ScanDeps;
  listLaunchAgentFiles(): string[];
  spawn: SpawnFn;
  nodeBin: string;
  cliEntry: string;
  pidIsAlive(pid: number): boolean;
  killPid(pid: number, signal: string): void;
  now(): Date;
  sleep(ms: number): Promise<void>;
  readDaemonLogTail(): string;
  write(line: string): void;
  writeErr(line: string): void;
}

export type ServeAction = 'start' | 'stop' | 'status';

export interface ServeCommandOptions {
  action: ServeAction;
  daemonChild?: boolean;
}

function defaultServeDeps(): ServeDeps {
  const root = process.cwd();
  const home = homedir();
  // B3: built once, then reused for BOTH `pidfile.pidIsAlive` (the
  // staleness probe `isDaemonPidfileStale` actually consults) and the
  // top-level `pidIsAlive` below (the separate post-steal-decision and
  // 2s-alive-confirm checks) — the SAME `process.kill`-based probe wired
  // to both injection points, never two independently-written copies
  // that could silently drift apart.
  const pidfileDeps = defaultDaemonPidfileDeps();
  return {
    root,
    home,
    platform: process.platform,
    uid: process.getuid?.(),
    pid: process.pid,
    profilesDir: path.join(root, 'profiles'),
    pidfile: pidfileDeps,
    logs: defaultLogDeps(),
    scan: defaultScanDeps(),
    listLaunchAgentFiles: () => {
      try {
        return fsReaddirSync(path.join(home, 'Library', 'LaunchAgents'));
      } catch {
        return [];
      }
    },
    spawn: (command, args, opts) =>
      nodeSpawn(command, args, {
        stdio: opts.stdio as ['ignore', number, number],
        detached: opts.detached,
      }) as unknown as SpawnHandle,
    nodeBin: process.execPath,
    cliEntry: fileURLToPath(new URL('../main.ts', import.meta.url)),
    pidIsAlive: pidfileDeps.pidIsAlive,
    killPid: (pid, signal) => {
      try {
        process.kill(pid, signal as NodeJS.Signals);
      } catch (err) {
        if (!hasCode(err, 'ESRCH')) throw err;
      }
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readDaemonLogTail: () => {
      try {
        const raw = fsReadFileSync(daemonLogPath(home), 'utf8');
        return raw.split('\n').slice(-20).join('\n');
      } catch {
        return '(no daemon.log yet)';
      }
    },
    write: (line) => console.log(line),
    writeErr: (line) => console.error(line),
  };
}

/** D15/§8 — a directory read plus printed strings; no `launchd` code.
 * Exported so `autostart.ts`'s `enable` can reuse it verbatim (§6.7). */
export function migrationCleanupBlock(files: string[], uid: number | undefined): string {
  const lines = [
    `serve start: found ${files.length} leftover launchd job(s) from the old scheduler. Run this first:`,
    '',
  ];
  for (const file of [...files].sort()) {
    const label = file.replace(/\.plist$/, '');
    lines.push(`launchctl bootout gui/${uid ?? '<uid>'}/${label}`);
    lines.push(`rm ~/Library/LaunchAgents/${file}`);
  }
  lines.push('', 'Then re-run: jobbunny serve start');
  return lines.join('\n');
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h${m}m${s}s`;
}

async function runServeStartParent(deps: ServeDeps): Promise<number> {
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

async function runServeStartChild(deps: ServeDeps): Promise<number> {
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
  const log = (event: string, data?: Record<string, unknown>): void => {
    // Lands in daemon.log via the parent's stdio redirection (§6.1) —
    // this process's own stdout was already pointed at the fd before
    // spawn(), so a plain console.log is all that's needed here.
    console.log(JSON.stringify({ event, ...data, ts: new Date().toISOString() }));
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
  // (`runServeStop` below). Releasing it here would delete the pidfile
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

async function waitUntilDead(
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
async function killAndConfirmDead(pid: number, deps: ServeDeps): Promise<boolean> {
  if (!deps.pidIsAlive(pid)) return true;
  deps.killPid(pid, 'SIGTERM');
  if (await waitUntilDead(pid, SIGKILL_GRACE_MS, deps)) return true;
  deps.killPid(pid, 'SIGKILL');
  return waitUntilDead(pid, SIGKILL_GRACE_MS, deps);
}

async function runServeStop(deps: ServeDeps): Promise<number> {
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

async function runServeStatus(deps: ServeDeps): Promise<number> {
  const file = readDaemonPidfile(deps.root, deps.pidfile);
  if (!file || !deps.pidIsAlive(file.pid)) {
    deps.write('serve status: not running');
    return 1;
  }

  const now = deps.now();
  deps.write(
    `serve status: running (pid ${file.pid}, uptime ${formatDuration(now.getTime() - Date.parse(file.startedAt))})`,
  );

  const heartbeatAgeMs = now.getTime() - Date.parse(file.lastTickAt);
  if (!Number.isFinite(heartbeatAgeMs)) {
    // An unparseable lastTickAt is suspicious, not benign: the operator
    // gets the raw value plus the wedged flag rather than `NaNhNaNmNaNs`,
    // which reads as a rendering bug and hides the real problem. Same
    // verdict `isDaemonPidfileStale` reaches for the same file (a
    // non-finite age is stale) — status only REPORTS it, while `serve
    // start` acts on it, one 35s re-check later.
    deps.write(`  last tick: ${file.lastTickAt} (age unknown) — appears wedged`);
  } else {
    const wedged = heartbeatAgeMs > HEARTBEAT_STALE_MS;
    deps.write(
      `  last tick: ${file.lastTickAt} (${formatDuration(heartbeatAgeMs)} ago)` +
        (wedged ? ' — appears wedged' : ''),
    );
  }
  // §6.1: reports the profile and elapsed time, not just the pid — the
  // bare `pid ${n}` form told an operator nothing about WHICH profile
  // was running or for how long.
  deps.write(
    file.inFlight !== undefined
      ? `  in flight: pid ${file.inFlight.pid} (profile ${file.inFlight.profile}, running ` +
          `${formatDuration(now.getTime() - Date.parse(file.inFlight.startedAt))})`
      : '  in flight: none',
  );

  const schedules = scanProfileSchedules(deps.profilesDir, deps.scan);
  const next = nextFireAt(now, schedules);
  deps.write(
    next
      ? `  next fire: ${next.at.toISOString()} (${next.runs.map((r) => r.profile).join(', ')})`
      : '  next fire: none scheduled',
  );

  // D19: the same disk-history-plus-ledger merge daemon.ts's own tick
  // uses — disk history alone would over-report a slot a synthetic
  // ledger entry already served.
  const date = formatLocalDate(now);
  const diskHistory = scanRunHistory(
    deps.profilesDir,
    schedules.map((s) => s.profile),
    date,
    deps.scan,
  );
  const ledgerHistory = file.attempts
    .filter((a) => a.date === date)
    .map((a) => ({ profile: a.profile, date: a.date, startedAt: a.slot }));
  const owed = isRunOwed(now, schedules, [...diskHistory, ...ledgerHistory]);
  if (owed.length > 0) {
    deps.write(
      `  currently owed: ${owed.map((o) => `${o.profile}@${o.slot}`).join(', ')}`,
    );
  }

  return 0;
}

export async function serveCommand(
  opts: ServeCommandOptions,
  overrides: Partial<ServeDeps> = {},
): Promise<number> {
  const deps: ServeDeps = { ...defaultServeDeps(), ...overrides };
  switch (opts.action) {
    case 'start':
      return opts.daemonChild ? runServeStartChild(deps) : runServeStartParent(deps);
    case 'stop':
      return runServeStop(deps);
    case 'status':
      return runServeStatus(deps);
  }
}
