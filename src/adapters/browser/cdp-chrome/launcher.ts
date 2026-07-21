import { execFileSync as nodeExecFileSync, spawn as nodeSpawn } from 'node:child_process';
import { existsSync as nodeExistsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Chrome-over-CDP process lifecycle: find the local Chrome binary, build its
 * launch argv, spawn/probe/age/kill it. Ported from scripts/lib/browser.js's
 * know-how (CHROME_BIN, CDP_PORT flag, .chrome-debug/ user-data-dir,
 * always-kill-unless-JOBBUNNY_KEEP_BROWSER, lsof-for-the-real-listener,
 * SIGTERM-then-poll-then-SIGKILL). fs/spawn/execFileSync/kill/sleep are all
 * injectable so tests never touch a real filesystem, process, or timer.
 *
 * resolveListenerPid is deliberately the pid actually LISTENING on the CDP
 * port (via lsof), not the pid launchChrome's spawn() call returns — a live
 * incident showed a fresh spawn can hand off to an already-running Chrome
 * (profile singleton on the same user-data-dir) and exit immediately, which
 * would leave the spawned pid dead while the real Chrome keeps running.
 * Callers (provider.ts) must resolve+kill this way, never trust the spawned
 * child's own pid.
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

/** repo-root/.chrome-debug — persistent Chrome profile dir; the persistent
 * LinkedIn login lives in its cookies/local-storage (ported 1:1 from
 * scripts/lib/browser.js's CHROME_DATA_DIR). Derived from this file's own
 * location so it doesn't depend on process.cwd(). */
export const DEFAULT_USER_DATA_DIR = fileURLToPath(
  new URL('../../../../.chrome-debug', import.meta.url),
);

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
      `no Chrome executable found (checked: ${candidates.join(', ')}) — install Google Chrome`,
    );
  }
  return found;
}

export interface LaunchArgvOptions {
  port: number;
  userDataDir: string;
}

/** Builds the CDP launch argv — ported 1:1 from scripts/lib/browser.js's
 * spawn() call (--remote-debugging-port + --user-data-dir, nothing else). */
export function buildLaunchArgv({ port, userDataDir }: LaunchArgvOptions): string[] {
  return [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`];
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
 * it never keeps our event loop alive. */
export function launchChrome(
  options: LaunchChromeOptions,
  deps: LauncherDeps = {},
): ChromeProcessHandle {
  const {
    port,
    userDataDir = DEFAULT_USER_DATA_DIR,
    candidates = CHROME_PATH_CANDIDATES,
  } = options;
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const chromePath = resolveChromePath(candidates, { existsSync });
  const argv = buildLaunchArgv({ port, userDataDir });
  const child = spawn(chromePath, argv, { detached: true, stdio: 'ignore' });
  child.unref();
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

  try {
    kill(pid, 'SIGTERM');
  } catch {
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

  return true;
}

export interface ProcessProbeDeps {
  /** Minimal shape of node:child_process's execFileSync this module needs —
   * injectable so tests never shell out to lsof/ps. */
  execFileSync?: (
    command: string,
    args: string[],
    options: { encoding: 'utf8' },
  ) => string;
}

/** Resolves the pid of whatever process is actually LISTENING on `port` —
 * ported from scripts/lib/browser.js's getChromePid (`lsof -ti :<port>
 * -sTCP:LISTEN`). See the module doc comment for why this, not the spawned
 * child's pid, is the one that must be killed. */
export function resolveListenerPid(
  port: number,
  deps: ProcessProbeDeps = {},
): number | undefined {
  const execFileSync =
    deps.execFileSync ?? (nodeExecFileSync as ProcessProbeDeps['execFileSync']);
  try {
    const out = execFileSync?.('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim();
    const pid = out?.split('\n')[0];
    return pid ? Number(pid) : undefined;
  } catch {
    return undefined;
  }
}

/** Parses `ps -o etime=` output, format `[[DD-]HH:]MM:SS` — ported 1:1 from
 * scripts/lib/browser.js's parseEtimeToMs. Pure, so it's tested directly
 * without shelling out. */
export function parseEtimeToMs(etime: string): number {
  let days = 0;
  let rest = etime.trim();
  if (rest.includes('-')) {
    const [d, r] = rest.split('-');
    days = Number(d);
    rest = r ?? '';
  }
  const parts = rest.split(':').map(Number);
  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 3) {
    h = parts[0] ?? 0;
    m = parts[1] ?? 0;
    s = parts[2] ?? 0;
  } else if (parts.length === 2) {
    m = parts[0] ?? 0;
    s = parts[1] ?? 0;
  } else if (parts.length === 1) {
    s = parts[0] ?? 0;
  }
  return (((days * 24 + h) * 60 + m) * 60 + s) * 1000;
}

/** Age of a running process via `ps -o etime=` — ported from
 * scripts/lib/browser.js's getProcessAgeMs. Returns null if the pid can't be
 * inspected (already gone, ps unavailable, etc) rather than throwing —
 * callers treat null as "unknown age, don't recycle". */
export function getProcessAgeMs(pid: number, deps: ProcessProbeDeps = {}): number | null {
  const execFileSync =
    deps.execFileSync ?? (nodeExecFileSync as ProcessProbeDeps['execFileSync']);
  try {
    const etime = execFileSync?.('ps', ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return etime ? parseEtimeToMs(etime) : null;
  } catch {
    return null;
  }
}

/** A debug Chrome left alone across days just accumulates tabs/memory (live
 * incident: 3-day uptime, 80% swap used, 56 Chrome processes on an 8GB
 * machine). Ported from scripts/lib/browser.js's CHROME_MAX_AGE_MS —
 * recycling past this age keeps the same on-disk profile/LinkedIn session
 * intact (only the process restarts, never the user-data-dir) while capping
 * how long any one instance lives. */
export const CHROME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
