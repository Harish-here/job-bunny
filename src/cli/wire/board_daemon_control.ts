/**
 * cli/wire/board_daemon_control.ts (settings-overhaul, task 11 — BE-gate
 * findings F1/F8; task 12 adds Start) — `BoardSource.stopDaemon`/
 * `startDaemon`'s real implementations. Deliberately its own sibling
 * module, separate from the existing READ-ONLY `board_daemon.ts` (read vs.
 * write is the same split the port itself already draws elsewhere), and
 * split out of `board.ts` for the same file-size-cap reason
 * `board_daemon.ts`/`board_doctor.ts`/`board_preview.ts` already are. Both
 * functions live HERE, not in two sibling files, because both are the
 * WRITE side of daemon control — the same split this module's own name
 * already draws against `board_daemon.ts`.
 *
 * `stopDaemon()` reuses `runServeStop`'s FULL four-step kill-and-confirm
 * lifecycle (`cli/commands/serve/lifecycle.ts`) — NOT a bare signal send.
 * The original spec for this step ("send the exact same signal `jobbunny
 * serve stop` sends, degrade to `already_stopped` on any failure") was
 * found defective (F1): it mis-specified the mechanism and inverted a real
 * failure (a daemon that survives SIGKILL) into a false success. Every
 * branch below is a typed `StopDaemonOutcome` — this function never
 * throws.
 *
 * `startDaemon()` (task 12) wraps `runServeStartParent`
 * (`cli/commands/serve/start.ts`) — see `startBoardDaemon`'s own doc
 * comment below for why that's a wrapping layer, not a pass-through.
 *
 * `setAutostart()` (task 13) lives in the sibling `board_autostart_control.ts`
 * module — split out by the fix round's F13 to stay under the file-size cap
 * once that fix landed; see that module's own doc comment.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultDaemonPidfileDeps,
  readDaemonPidfile,
  releaseDaemonPidfile,
} from '../../ops/daemon/index.ts';
import {
  daemonLogPath,
  defaultLogDeps,
  type LogDeps,
} from '../../ops/daemon/logs/index.ts';
import type { StartDaemonOutcome, StopDaemonOutcome } from '../../ports/board.ts';
import type { ServeDeps, SpawnFn, SpawnHandle } from '../commands/serve/index.ts';
import { type KillDeps, killAndConfirmDead } from '../commands/serve/lifecycle.ts';
import { runServeStartParent } from '../commands/serve/start.ts';

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
  /** Test-only seam: overrides this process's own pid, used ONLY for the
   * self-referential-pidfile guard below (never for anything else — this
   * function itself never has a pid to write). Default: the real
   * `process.pid`. */
  selfPid?: number;
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

  // Guard (stability-review fix) — a pidfile naming THIS process (the
  // board server) is stale/self-referential, never a real daemon:
  // `startBoardDaemon` writes the board's OWN pid into the pidfile before
  // the not-yet-spawned child exists (`ServeDeps.pid`, see that function's
  // own doc comment), so a stop request that lands in that narrow boot
  // window — or an earlier spawn failure that leaked the placeholder —
  // would otherwise read the board's own pid here and kill it. Return a
  // distinct, visible outcome instead of ever reaching `killAndConfirmDead`.
  const selfPid = overrides.selfPid ?? process.pid;
  if (file.pid === selfPid) return { outcome: 'stale_pidfile' };

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

/** `runServeStartParent`'s "already running" message text (`start.ts:44-51,
 * 62-66, 79-83` — all three not-stale/re-check branches share this exact
 * prefix) — the ONE signal this wrapper uses to distinguish "already
 * running" from a genuine spawn failure, since `runServeStartParent`
 * otherwise only communicates via a bare exit code. */
const ALREADY_RUNNING_RE = /a daemon is already running/;

export interface BoardDaemonStartOverrides {
  root: string;
  /** Default: the OS home directory (`homedir()`) — same default
   * `defaultServeDeps()` uses for `~/Library/LaunchAgents` discovery and
   * `~/.jobbunny/logs/daemon.log`; deliberately NOT `root` (`root` is the
   * data home, which may be a repo checkout — see `resolveHome()`). */
  home?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  pid?: number;
  /** Test-only seam: overrides the darwin legacy-plist directory listing.
   * Default: a real read of `<home>/Library/LaunchAgents`, `[]` on any
   * error (mirrors `defaultServeDeps()`). */
  listLaunchAgentFiles?: () => string[];
  /** Test-only seam: replaces the real detached `node:child_process.spawn`
   * call — per this brief's own safety constraint, EVERY test must
   * override this. Default: the real detached spawn `defaultServeDeps()`
   * uses. */
  spawn?: SpawnFn;
  /** Test-only seam: overrides pid liveness for BOTH the pidfile deps'
   * staleness probe and the post-spawn alive-confirm — same B3 precedent
   * `BoardDaemonControlOverrides.pidIsAlive` documents above. Default: the
   * real `process.kill(pid, 0)` probe. */
  pidIsAlive?: (pid: number) => boolean;
  /** Test-only seam: replaces the real sleep — a test never actually waits
   * out `STEAL_RECHECK_WAIT_MS`/`CHILD_ALIVE_CHECK_MS`. Default: a real
   * `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  nodeBin?: string;
  cliEntry?: string;
  logs?: LogDeps;
}

function realListLaunchAgentFiles(home: string): () => string[] {
  return () => {
    try {
      return fsReaddirSync(path.join(home, 'Library', 'LaunchAgents'));
    } catch {
      return [];
    }
  };
}

function realSpawn(): SpawnFn {
  return (command, args, opts) =>
    nodeSpawn(command, args, {
      stdio: opts.stdio as ['ignore', number, number],
      detached: opts.detached,
    }) as unknown as SpawnHandle;
}

function realReadDaemonLogTail(home: string): () => string {
  return () => {
    try {
      const raw = fsReadFileSync(daemonLogPath(home), 'utf8');
      return raw.split('\n').slice(-20).join('\n');
    } catch {
      return '(no daemon.log yet)';
    }
  };
}

/** `BoardSource.startDaemon`'s real implementation (task 12) — a WRAPPING
 * layer over `runServeStartParent`, not a pass-through: that function (i)
 * gates on darwin legacy-plist cleanup, (ii) can legitimately BLOCK UP TO
 * ~37s total re-checking a stale-but-alive incumbent before stealing its
 * pidfile plus the child-alive confirm, and (iii) communicates its result
 * as a bare exit code plus stderr text meant for a terminal, never a typed
 * outcome. This function builds the full `ServeDeps` `runServeStartParent`
 * requires (fields it never reads — `readRunHistory`, `notify`, the tick
 * loop's other daemon-child-only fields — get inert stand-ins, the same
 * posture `serve.test.ts`'s own `baseServeDeps` fake already takes when
 * unit-testing `runServeStartParent` directly), captures what it would
 * have written to stderr instead of printing it, and translates the (exit
 * code, stderr) pair into a `StartDaemonOutcome` DELIBERATELY: "already
 * running" (exit 1, matching `ALREADY_RUNNING_RE`) maps to
 * `'already_running'` — a success from the caller's point of view, the
 * daemon ends up running either way; every OTHER non-zero exit (the
 * legacy-plist gate, a failed re-acquire, the child dying immediately)
 * maps to `'spawn_failed'`, a DISTINCT, visible failure. Wrapped in
 * try/catch: any exception from `runServeStartParent` itself is also
 * `'spawn_failed'` — this function never throws. No timeout wraps the
 * call — the ~37s incumbent-recheck branch is a legitimate slow path, not
 * a hang, per this brief's own instruction. */
export async function startBoardDaemon(
  overrides: BoardDaemonStartOverrides,
): Promise<StartDaemonOutcome> {
  const home = overrides.home ?? homedir();
  const root = overrides.root;
  const pidfileDefaults = defaultDaemonPidfileDeps();
  const pidIsAlive = overrides.pidIsAlive ?? pidfileDefaults.pidIsAlive;
  const errLines: string[] = [];

  const deps: ServeDeps = {
    root,
    home,
    platform: overrides.platform ?? process.platform,
    uid: overrides.uid ?? process.getuid?.(),
    pid: overrides.pid ?? process.pid,
    profilesDir: path.join(root, 'profiles'),
    pidfile: { ...pidfileDefaults, pidIsAlive },
    logs: overrides.logs ?? defaultLogDeps(),
    // Inert — the daemon TICK LOOP's own fields, never read by
    // `runServeStartParent` (only by `runServeStartChild`, which this
    // wrapper never invokes).
    scan: { readdirSync: () => [], readProfileJson: async () => undefined },
    readRunHistory: () => [],
    checkSchemaDrift: () => new Map(),
    notify: async () => true,
    hasNotifierConfigured: async () => false,
    readIntents: () => [],
    claimIntent: () => true,
    attachIntentRun: () => {},
    probeReachable: async () => true,
    recordDeferral: () => {},
    listForDate: () => [],
    listUnnotifiedDatesBefore: () => [],
    markNotified: () => {},
    hasCatchupRun: () => false,
    killPid: () => {},
    now: () => new Date(),
    // Fields `runServeStartParent` actually reads.
    listLaunchAgentFiles:
      overrides.listLaunchAgentFiles ?? realListLaunchAgentFiles(home),
    spawn: overrides.spawn ?? realSpawn(),
    nodeBin: overrides.nodeBin ?? process.execPath,
    cliEntry: overrides.cliEntry ?? fileURLToPath(new URL('../main.ts', import.meta.url)),
    pidIsAlive,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    readDaemonLogTail: realReadDaemonLogTail(home),
    write: () => {},
    writeErr: (line) => errLines.push(line),
  };

  try {
    const code = await runServeStartParent(deps);
    if (code === 0) return { outcome: 'started' };
    if (errLines.some((line) => ALREADY_RUNNING_RE.test(line))) {
      return { outcome: 'already_running' };
    }
    return { outcome: 'spawn_failed' };
  } catch {
    // Stability-review fix: every step of `runServeStartParent` that can
    // throw here (log-file rotate/open, `deps.spawn` itself — none of
    // which are wrapped in try/catch, unlike the legacy-plist listing and
    // pidfile reads) runs AFTER `acquireDaemonPidfile` has already written
    // THIS process's (the board server's) own pid into the pidfile, and
    // BEFORE any child exists to overwrite it with a real pid. Left alone,
    // that permanently leaks a pidfile naming the board's own live pid —
    // the next `stopDaemon()` would then try to kill the board itself
    // (closed defense-in-depth by the self-referential guard in
    // `stopBoardDaemon` above too). Re-read and release ONLY if the
    // pidfile still names exactly the pid we would have written: a throw
    // can only ever leak OUR OWN just-acquired placeholder, never a
    // concurrently, legitimately started daemon's real pidfile.
    const maybeOwn = readDaemonPidfile(root, deps.pidfile);
    if (maybeOwn?.pid === deps.pid) {
      releaseDaemonPidfile(root, deps.pidfile);
    }
    return { outcome: 'spawn_failed' };
  }
}
