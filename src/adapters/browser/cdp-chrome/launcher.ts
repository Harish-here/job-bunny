import { spawn as nodeSpawn } from 'node:child_process';
import {
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
  rmSync as nodeRmSync,
  writeFileSync as nodeWriteFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCandidates } from './discovery/index.ts';
import {
  type ChromePidfileDeps,
  clearChromePidfile,
  defaultChromePidfileDeps,
  writeChromePidfile,
} from './ownership/index.ts';
import {
  clearSessionState,
  SESSION_CLEAR_SKIP_ENV,
  type SessionClearFsDeps,
} from './session_clear.ts';

/**
 * Chrome-over-CDP process lifecycle: find the local Chrome binary, build its
 * launch argv, spawn/probe/age/kill it. Ported from scripts/lib/browser.js's
 * know-how (CHROME_BIN, CDP_PORT flag, <data home>/chrome user-data-dir,
 * always-kill-unless-JOBBUNNY_KEEP_BROWSER, SIGTERM-then-poll-then-SIGKILL).
 * fs/spawn/kill/sleep are all injectable so tests never touch a real
 * filesystem, process, or timer.
 *
 * Ownership (D12): launchChrome writes `.jobbunny-chrome.json` (see
 * ownership/pidfile.ts) into userDataDir immediately after spawn() returns
 * a pid — { pid, port, startedAt }. killChrome clears that file once the
 * process is confirmed dead. This is what pid liveness/age is now decided
 * from, replacing the old lsof/ps-based resolveListenerPid/getProcessAgeMs
 * (deleted): the pid file records exactly the pid THIS codebase spawned,
 * so ownership is "is that exact pid alive and recorded", not "whoever the
 * OS reports is listening on the port right now".
 *
 * launchChrome also runs clearSessionState immediately before spawning
 * (2026-07-25 follow-up): buildLaunchArgv's --restore-last-session=false
 * etc. cut restored CDP targets from ~97 to 4, but didn't fully suppress
 * restore — command-line flags alone weren't enough, one of the 4 was a
 * LinkedIn tab with a live reCAPTCHA widget. clearSessionState deletes the
 * on-disk Sessions/tab-restore state and normalizes Preferences' exit
 * state so Chrome has nothing left to restore from, while leaving
 * cookies/storage/Login Data/the profile dir itself completely untouched —
 * see its own doc comment for the full auth-vs-session split.
 */

/** Default CDP port — matches scripts/lib/browser.js's CDP_URL default. */
export const DEFAULT_CDP_PORT = 9222;

/** macOS Chrome install locations, checked in order — first that exists
 * wins. scripts/lib/browser.js hardcodes just the first of these; extended
 * here so a Beta/Canary/Chromium-only machine still resolves. */
export const CHROME_PATH_CANDIDATES: readonly string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** Inert fallback for the persistent Chrome profile dir (the LinkedIn login
 * lives in its cookies/local-storage). `cli/wire` ALWAYS passes the real
 * value — `join(<data home>, 'chrome')` — so this constant is only ever
 * reached by a caller that constructed the provider with no `userDataDir`
 * at all. It deliberately no longer derives from this file's own on-disk
 * location: user data must never be anchored inside the installed package. */
export const DEFAULT_USER_DATA_DIR = join(homedir(), '.jobbunny', 'chrome');

export interface FsDeps {
  existsSync: (path: string) => boolean;
}

/** Minimal shape of node:child_process's spawn this module needs. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' },
) => { pid?: number; unref: () => void };

export interface LauncherDeps {
  existsSync?: FsDeps['existsSync'];
  spawn?: SpawnFn;
  /** Injectable so tests can assert/skip the JOBBUNNY_SKIP_SESSION_CLEAR
   * opt-out without mutating the real process.env. */
  env?: NodeJS.ProcessEnv;
  /** clearSessionState's fs deps, individually injectable so launchChrome's
   * existing tests (which only care about the spawn call) don't need to
   * know about session clearing at all — defaults cover them. */
  rmSync?: SessionClearFsDeps['rmSync'];
  readFileSync?: SessionClearFsDeps['readFileSync'];
  writeFileSync?: SessionClearFsDeps['writeFileSync'];
  /** Injectable Chrome pid-file deps — used by launchChrome to write, and
   * by killChrome to clear, <data home>/chrome/.jobbunny-chrome.json.
   * Default: defaultChromePidfileDeps(). */
  pidfileDeps?: ChromePidfileDeps;
}

/** Resolves the first candidate path that exists on disk. Throws a clear
 * error (naming every path checked) if none do. */
export function resolveChromePath(
  candidates: readonly string[] = CHROME_PATH_CANDIDATES,
  deps: FsDeps = { existsSync: nodeExistsSync },
): string {
  const found = candidates.find((path) => deps.existsSync(path));
  if (!found) {
    throw new Error(
      `no Chrome executable found (checked: ${candidates.join(', ')}) — install Google Chrome (or Microsoft Edge on Windows)`,
    );
  }
  return found;
}

export interface LaunchArgvOptions {
  port: number;
  userDataDir: string;
}

/** Builds the CDP launch argv — ported from scripts/lib/browser.js's spawn()
 * call (--remote-debugging-port + --user-data-dir), extended (2026-07-25
 * incident) with flags that suppress session/tab restore and the
 * crash-restore bubble on launch. A prior unclean exit left Chrome
 * restoring its ENTIRE previous session on next launch — ~97 CDP targets,
 * duplicate tabs, an invalidated extension retrying a failed fetch every
 * ~1s, and tracker iframes — which is what blew the connectWithRetry
 * timeout in provider.ts. None of these touch cookies, storage, or the
 * user-data-dir itself — the persistent LinkedIn login in <data home>/chrome
 * MUST survive a launch, only the leftover TABS/SESSION must not come
 * back:
 *  - --restore-last-session=false: don't reopen the previous session's tabs.
 *  - --no-first-run: skip first-run UI/promo interstitials that would
 *    otherwise open their own tab.
 *  - --disable-session-crashed-bubble / --hide-crash-restore-bubble: suppress
 *    the "Chrome didn't shut down correctly — Restore" infobar, which both
 *    clutters the page and, if ever clicked/auto-accepted, would itself
 *    restore the old session.
 */
export function buildLaunchArgv({ port, userDataDir }: LaunchArgvOptions): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--restore-last-session=false',
    '--no-first-run',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
  ];
}

export interface LaunchChromeOptions {
  port: number;
  userDataDir?: string;
  candidates?: readonly string[];
}

export interface ChromeProcessHandle {
  pid: number | undefined;
}

/** Spawns Chrome detached (so it survives independently of this process)
 * with CDP enabled against the persistent user-data-dir, and unrefs it so
 * it never keeps our event loop alive.
 *
 * Immediately before spawning (unless `JOBBUNNY_SKIP_SESSION_CLEAR=1`),
 * clears the previous session's tab-restore state via clearSessionState —
 * this is the ONLY place that runs, since launchChrome itself is only ever
 * called on the launch/recycle-then-launch path (never reuse/attach — see
 * provider.ts's `ownsProcess` and this module's clearSessionState doc). */
export function launchChrome(
  options: LaunchChromeOptions,
  deps: LauncherDeps = {},
): ChromeProcessHandle {
  const { port, userDataDir = DEFAULT_USER_DATA_DIR, candidates } = options;
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const env = deps.env ?? process.env;
  if (env[SESSION_CLEAR_SKIP_ENV] !== '1') {
    const sessionClearDeps: SessionClearFsDeps = {
      existsSync,
      rmSync: deps.rmSync ?? nodeRmSync,
      readFileSync: deps.readFileSync ?? nodeReadFileSync,
      writeFileSync: deps.writeFileSync ?? nodeWriteFileSync,
    };
    clearSessionState(userDataDir, sessionClearDeps);
  }
  const resolvedCandidates = resolveCandidates(process.platform, env, candidates);
  const chromePath = resolveChromePath(resolvedCandidates, { existsSync });
  const argv = buildLaunchArgv({ port, userDataDir });
  const child = spawn(chromePath, argv, { detached: true, stdio: 'ignore' });
  child.unref();
  if (child.pid != null) {
    const pidfileDeps = deps.pidfileDeps ?? defaultChromePidfileDeps();
    writeChromePidfile(
      userDataDir,
      { pid: child.pid, port, startedAt: pidfileDeps.now().toISOString() },
      pidfileDeps,
    );
  }
  return { pid: child.pid };
}

export interface KillDeps {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  env?: NodeJS.ProcessEnv;
  /** Liveness probe used while polling after SIGTERM. Injectable so tests
   * never touch a real process. Default: `process.kill(pid, 0)` — signal 0
   * sends nothing, it only checks the pid still exists (throws ESRCH once
   * it's gone). */
  isAlive?: (pid: number) => boolean;
  /** Sleep used between polls, injected so tests can make the whole
   * SIGTERM-wait-SIGKILL loop resolve near-instantly instead of taking
   * graceMs of real wall-clock time. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Total time to wait for a graceful SIGTERM exit before escalating to
   * SIGKILL. Ported from scripts/lib/browser.js's killChrome graceMs
   * (default there: 5000 for a normal kill, 10000 for an age-recycle). */
  graceMs?: number;
  /** Interval between liveness polls while waiting out graceMs. v0 polls
   * every 250ms. */
  pollIntervalMs?: number;
  /** Brief settle time after a SIGKILL, mirroring v0's post-SIGKILL 500ms
   * pause (lets the OS finish tearing the process down before the caller
   * treats the port as free). */
  settleMs?: number;
  /** userDataDir whose Chrome pid file should be cleared once this
   * process is confirmed dead. Default: DEFAULT_USER_DATA_DIR. */
  userDataDir?: string;
  /** Injectable Chrome pid-file deps for the same clear. Default:
   * defaultChromePidfileDeps(). */
  pidfileDeps?: ChromePidfileDeps;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kills the Chrome process spawned by launchChrome — the always-kill
 * invariant from scripts/lib/browser.js, unless JOBBUNNY_KEEP_BROWSER=1 (in
 * which case Chrome is deliberately left running, e.g. for post-mortem).
 *
 * Escalation ported from scripts/lib/browser.js's killChrome: SIGTERM first,
 * poll for exit every pollIntervalMs up to graceMs, then SIGKILL if it's
 * still alive, then a brief settleMs pause. A single unescalated SIGTERM
 * left a wedged Chrome running while reporting success — this fixes that.
 * Best-effort throughout: an already-gone process is treated as a handled
 * no-op, not a throw. */
export async function killChrome(
  pid: number | undefined,
  deps: KillDeps = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (env.JOBBUNNY_KEEP_BROWSER === '1') return false;
  if (pid == null) return false;
  const kill = deps.kill ?? process.kill;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const graceMs = deps.graceMs ?? 5000;
  const pollIntervalMs = deps.pollIntervalMs ?? 250;
  const settleMs = deps.settleMs ?? 500;
  const userDataDir = deps.userDataDir ?? DEFAULT_USER_DATA_DIR;
  const pidfileDeps = deps.pidfileDeps ?? defaultChromePidfileDeps();

  try {
    kill(pid, 'SIGTERM');
  } catch {
    clearChromePidfile(userDataDir, pidfileDeps);
    return false; // already gone
  }

  const deadline = Date.now() + graceMs;
  let stillAlive = true;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if (!isAlive(pid)) {
      stillAlive = false;
      break;
    }
  }

  if (stillAlive) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    await sleep(settleMs);
  }

  clearChromePidfile(userDataDir, pidfileDeps);
  return true;
}

/** A debug Chrome left alone across days just accumulates tabs/memory (live
 * incident: 3-day uptime, 80% swap used, 56 Chrome processes on an 8GB
 * machine). Ported from scripts/lib/browser.js's CHROME_MAX_AGE_MS —
 * recycling past this age keeps the same on-disk profile/LinkedIn session
 * intact (only the process restarts, never the user-data-dir) while capping
 * how long any one instance lives. */
export const CHROME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
