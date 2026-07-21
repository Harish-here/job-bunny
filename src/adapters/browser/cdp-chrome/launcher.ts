import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync as nodeExistsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Chrome-over-CDP process lifecycle: find the local Chrome binary, build its
 * launch argv, spawn it, and kill it on the way out. Ported from
 * scripts/lib/browser.js's know-how (CHROME_BIN, CDP_PORT flag,
 * .chrome-debug/ user-data-dir, always-kill-unless-JOBBUNNY_KEEP_BROWSER).
 * fs/spawn are injectable so tests never touch a real filesystem or process.
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
}

/** Kills the Chrome process spawned by launchChrome — the always-kill
 * invariant from scripts/lib/browser.js, unless JOBBUNNY_KEEP_BROWSER=1 (in
 * which case Chrome is deliberately left running, e.g. for post-mortem).
 * Best-effort: an already-gone process is treated as a successful no-op. */
export function killChrome(pid: number | undefined, deps: KillDeps = {}): boolean {
  const env = deps.env ?? process.env;
  if (env.JOBBUNNY_KEEP_BROWSER === '1') return false;
  if (pid == null) return false;
  const kill = deps.kill ?? process.kill;
  try {
    kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
