import { chromium } from 'playwright';
import { sleep } from '../../../core/async/index.ts';
import type { BrowserHandle, BrowserProvider } from '../../../ports/browser.ts';
import type { RunContext } from '../../../ports/context.ts';
import { CdpChromeBrowserHandle } from './handles/index.ts';
import type { ChromeProcessHandle, KillDeps, LauncherDeps } from './launcher.ts';
import {
  CHROME_MAX_AGE_MS,
  DEFAULT_CDP_PORT,
  DEFAULT_USER_DATA_DIR,
  killChrome as defaultKillChrome,
  launchChrome as defaultLaunchChrome,
} from './launcher.ts';
import {
  type ChromePidfileDeps,
  defaultChromePidfileDeps,
  readChromePidfile,
} from './ownership/index.ts';

/**
 * CdpChromeProvider — BrowserProvider implementation over a real, locally
 * spawned Chrome attached via CDP (playwright's connectOverCDP). PageHandle's
 * deadline-bound behavior lives in ./handles/page_handle.ts.
 *
 * Chrome lifecycle mirrors scripts/lib/browser.js's proven, hard-won
 * ensureChrome pattern, now sourced from a pid file rather than lsof/ps
 * (D12):
 *  - launch() ALWAYS probes CDP reachability (bounded fetch of
 *    `${cdpUrl}/json/version`) before spawning. Unreachable => spawn fresh
 *    (action 'launch'). Reachable + no live pid file (.chrome-debug/
 *    .jobbunny-chrome.json) => this Chrome was not spawned by this
 *    codebase — attach (reuse), never recycle, never kill; this check
 *    happens BEFORE decideChromeAction is consulted at all. Reachable +
 *    live pid file => age is pidfileDeps.now() - pidfile.startedAt (the
 *    same injected clock launchChrome stamped startedAt with), fed into
 *    decideChromeAction exactly as before: 'reuse' if <= maxAgeMs,
 *    'recycle' (kill via the pid file's pid, then respawn) if older.
 *  - The pid file is written by launchChrome itself, from the pid
 *    spawn() returned — never re-resolved via an OS tool. close() kills
 *    exactly that pid (the one this run spawned, recorded at handle
 *    construction time), not a freshly re-resolved "whoever is listening
 *    on the port now" — see ./handles/browser_handle.ts's class doc for the
 *    close()/ownsProcess rules this feeds.
 */

/** Minimal playwright Page surface this adapter drives — narrow so fakes in
 * tests don't need to satisfy playwright's full Page interface. */
export interface CdpPage {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  evaluate<T>(pageFunction: string): Promise<T>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}

/** Minimal playwright BrowserContext surface this adapter drives. Over
 * `connectOverCDP`, `browser.contexts()[0]` is the REAL Chrome profile's
 * persistent context — the one holding the logged-in session cookies. */
export interface CdpBrowserContext {
  newPage(): Promise<CdpPage>;
}

/** Minimal playwright Browser surface this adapter drives.
 *
 * `contexts`/`newContext` are optional only so the many `{ newPage }` fakes
 * in this file's tests stay terse — a real playwright `Browser` always has
 * both, so the persistent-context path below is what actually runs. */
export interface CdpBrowser {
  newPage(): Promise<CdpPage>;
  contexts?(): CdpBrowserContext[];
  newContext?(): Promise<CdpBrowserContext>;
}

export type ConnectFn = (cdpUrl: string) => Promise<CdpBrowser>;

const defaultConnect: ConnectFn = async (cdpUrl) => {
  // noDefaults: this is intended to attach to a real Chrome instance with a
  // persistent profile (ported from scripts/lib/browser.js's connectCDP) —
  // without it, connectOverCDP's default context overrides can throw on
  // Chrome builds that don't expose them over CDP.
  const browser = await chromium.connectOverCDP(cdpUrl, { noDefaults: true });
  return browser;
};

export type CdpReachableFn = (
  cdpUrl: string,
  opts?: { timeoutMs?: number },
) => Promise<unknown | null>;

/** Bounded probe of Chrome's CDP HTTP endpoint — ported from
 * scripts/lib/browser.js's cdpReachable(). Returns the parsed
 * `/json/version` body when Chrome answers, or null on any failure
 * (connection refused, non-2xx, timeout) — never throws. Exported (P8) so
 * `cli/wire/compose.ts` can reuse the exact same probe for `cdpReachableCheck`
 * instead of reimplementing it. */
export const defaultCdpReachable: CdpReachableFn = async (cdpUrl, opts = {}) => {
  try {
    const res = await fetch(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

export type ChromeLaunchAction = 'launch' | 'recycle' | 'reuse';

/** PURE — decides what launch() should do next given the current
 * reachability/age. Ported from scripts/lib/browser.js's
 * decideChromeAction. */
export function decideChromeAction({
  reachable,
  ageMs,
  maxAgeMs,
}: {
  reachable: boolean;
  ageMs: number | null;
  maxAgeMs: number;
}): ChromeLaunchAction {
  if (!reachable) return 'launch';
  if (ageMs != null && ageMs > maxAgeMs) return 'recycle';
  return 'reuse';
}

export interface CdpChromeProviderDeps {
  connect?: ConnectFn;
  launchChrome?: (
    options: { port: number; userDataDir?: string; candidates?: readonly string[] },
    deps?: LauncherDeps,
  ) => ChromeProcessHandle;
  killChrome?: (pid: number | undefined, deps?: KillDeps) => boolean | Promise<boolean>;
  port?: number;
  userDataDir?: string;
  candidates?: readonly string[];
  launcherFsDeps?: LauncherDeps;
  killEnv?: NodeJS.ProcessEnv;
  /** Delay between connectOverCDP retry attempts, in ms. Injectable so tests
   * run with no real waits. Default 250ms. */
  connectRetryMs?: number;
  /** Total time budget for connect retries, in ms, starting from the first
   * attempt. Injectable so tests run with no real waits. Default 10000ms —
   * mirrors scripts/lib/browser.js's cdpReachable() poll cap: Chrome needs a
   * moment to bind its debug port after spawn, so connectOverCDP racing the
   * spawn without a retry fails intermittently. */
  connectMaxWaitMs?: number;
  /** Probes CDP HTTP reachability on the target port before deciding whether
   * to spawn. Injectable so tests never make a real network call. Default:
   * bounded fetch of `${cdpUrl}/json/version`. */
  cdpReachable?: CdpReachableFn;
  /** Injectable Chrome pid-file deps (D12) — used to read
   * .chrome-debug/.jobbunny-chrome.json when deciding reuse/recycle/launch,
   * and passed through to killChrome so close()/recycle clear it after a
   * kill. Injectable so tests never touch the real filesystem or process
   * table. Default: defaultChromePidfileDeps(). */
  pidfileDeps?: ChromePidfileDeps;
  /** Recycle (kill + respawn, same user-data-dir) a reachable Chrome once
   * it's older than this, instead of reusing it indefinitely. Default:
   * CHROME_MAX_AGE_MS (24h), matching scripts/lib/browser.js. */
  maxAgeMs?: number;
  /** When a reachable Chrome is older than maxAgeMs: recycle it when true
   * (default), or just reuse it as-is when false — mirrors
   * scripts/lib/browser.js's ensureChrome recycleIfOld flag. */
  recycleIfOld?: boolean;
  /** Bound on the reachability probe fetch, in ms. Default 2000. */
  reachabilityTimeoutMs?: number;
}

export class CdpChromeProvider implements BrowserProvider {
  readonly name = 'cdp-chrome';

  private readonly connect: ConnectFn;
  private readonly launchChromeFn: NonNullable<CdpChromeProviderDeps['launchChrome']>;
  private readonly killChromeFn: NonNullable<CdpChromeProviderDeps['killChrome']>;
  private readonly port: number;
  private readonly userDataDir: string;
  private readonly candidates: readonly string[] | undefined;
  private readonly launcherFsDeps: LauncherDeps | undefined;
  private readonly killEnv: NodeJS.ProcessEnv | undefined;
  private readonly connectRetryMs: number;
  private readonly connectMaxWaitMs: number;
  private readonly cdpReachableFn: CdpReachableFn;
  private readonly pidfileDeps: ChromePidfileDeps;
  private readonly maxAgeMs: number;
  private readonly recycleIfOld: boolean;
  private readonly reachabilityTimeoutMs: number;

  constructor(deps: CdpChromeProviderDeps = {}) {
    this.connect = deps.connect ?? defaultConnect;
    this.launchChromeFn = deps.launchChrome ?? defaultLaunchChrome;
    this.killChromeFn = deps.killChrome ?? defaultKillChrome;
    this.port = deps.port ?? DEFAULT_CDP_PORT;
    this.userDataDir = deps.userDataDir ?? DEFAULT_USER_DATA_DIR;
    this.candidates = deps.candidates;
    this.launcherFsDeps = deps.launcherFsDeps;
    this.killEnv = deps.killEnv;
    this.connectRetryMs = deps.connectRetryMs ?? 250;
    this.connectMaxWaitMs = deps.connectMaxWaitMs ?? 10_000;
    this.cdpReachableFn = deps.cdpReachable ?? defaultCdpReachable;
    this.pidfileDeps = deps.pidfileDeps ?? defaultChromePidfileDeps();
    this.maxAgeMs = deps.maxAgeMs ?? CHROME_MAX_AGE_MS;
    this.recycleIfOld = deps.recycleIfOld ?? true;
    this.reachabilityTimeoutMs = deps.reachabilityTimeoutMs ?? 2000;
  }

  async launch(ctx: RunContext): Promise<BrowserHandle> {
    const cdpUrl = `http://127.0.0.1:${this.port}`;
    const version = await this.cdpReachableFn(cdpUrl, {
      timeoutMs: this.reachabilityTimeoutMs,
    });

    if (!version) {
      return this.spawnAndConnect(cdpUrl, ctx);
    }

    const pidfile = readChromePidfile(this.userDataDir, this.pidfileDeps);
    if (!pidfile) {
      // Reachable, no live pid file: not ours — attach, never recycle,
      // never kill (D12/§7.4's "strengthens ownsProcess" branch, applied
      // BEFORE decideChromeAction is consulted at all).
      const browser = await this.connectWithRetry(cdpUrl, ctx);
      return new CdpChromeBrowserHandle(
        cdpUrl,
        browser,
        ctx,
        undefined,
        this.killChromeFn,
        this.killEnv,
        this.userDataDir,
        this.pidfileDeps,
        false,
      );
    }

    // pidfileDeps.now() is the single clock for BOTH sides of the pid file:
    // launchChrome stamps startedAt with it, launch() ages that stamp with
    // it. Default is `() => new Date()`, so production behavior is
    // identical to Date.now() — but the seam keeps the read side injectable
    // alongside the write side, so tests are wall-clock-independent.
    const ageMs = this.pidfileDeps.now().getTime() - Date.parse(pidfile.startedAt);
    const action = decideChromeAction({
      reachable: true,
      ageMs,
      maxAgeMs: this.maxAgeMs,
    });

    if (action === 'reuse' || !this.recycleIfOld) {
      const browser = await this.connectWithRetry(cdpUrl, ctx);
      return new CdpChromeBrowserHandle(
        cdpUrl,
        browser,
        ctx,
        undefined,
        this.killChromeFn,
        this.killEnv,
        this.userDataDir,
        this.pidfileDeps,
        false,
      );
    }

    // action === 'recycle' && recycleIfOld.
    ctx.logger.info('cdp-chrome: recycling a reachable-but-stale Chrome instance', {
      ageMs,
      maxAgeMs: this.maxAgeMs,
      port: this.port,
    });
    await this.killChromeFn(pidfile.pid, {
      env: this.killEnv,
      userDataDir: this.userDataDir,
      pidfileDeps: this.pidfileDeps,
    });
    return this.spawnAndConnect(cdpUrl, ctx);
  }

  /** Spawns a fresh Chrome, connects, and — on connect failure — kills the
   * freshly-spawned pid before rethrowing (never leaks the spawned
   * process). Shared by the unreachable branch and the recycle branch of
   * launch(). */
  private async spawnAndConnect(cdpUrl: string, ctx: RunContext): Promise<BrowserHandle> {
    const proc = this.launchChromeFn(
      { port: this.port, userDataDir: this.userDataDir, candidates: this.candidates },
      // pidfileDeps is threaded in explicitly so the ONE seam governs both
      // sides of the pid file: without it, launchChrome's write path fell
      // back to defaultChromePidfileDeps() (real fs) even when this provider
      // was constructed with injected deps, so the write and the subsequent
      // read used different worlds.
      { ...this.launcherFsDeps, pidfileDeps: this.pidfileDeps },
    );
    let browser: CdpBrowser;
    try {
      browser = await this.connectWithRetry(cdpUrl, ctx);
    } catch (err) {
      await this.killChromeFn(proc.pid, {
        env: this.killEnv,
        userDataDir: this.userDataDir,
        pidfileDeps: this.pidfileDeps,
      });
      throw err;
    }
    return new CdpChromeBrowserHandle(
      cdpUrl,
      browser,
      ctx,
      proc.pid,
      this.killChromeFn,
      this.killEnv,
      this.userDataDir,
      this.pidfileDeps,
      // This process just spawned (or recycled-then-spawned) the Chrome
      // instance behind proc.pid — it owns the process and close() must
      // kill it.
      true,
    );
  }

  /**
   * Chrome needs a moment to bind its debug port after spawn (v0's
   * scripts/lib/browser.js polls cdpReachable() for up to ~10s before
   * connecting) — connectOverCDP called immediately after spawn races that
   * and fails intermittently. Retries connect() on failure, delayed by
   * connectRetryMs between attempts, bounded by BOTH connectMaxWaitMs and
   * ctx.signal.
   *
   * Each individual connect() attempt is itself raced against the REMAINING
   * slice of connectMaxWaitMs (2026-07-25 incident: a single connect() call
   * hung on playwright's own internal ~30s connectOverCDP timeout — well
   * past the configured 10s cap — because it was `await`ed unconditionally.
   * The cap must bound total wall-clock time, not just decide whether to
   * retry after the fact).
   */
  private async connectWithRetry(cdpUrl: string, ctx: RunContext): Promise<CdpBrowser> {
    const start = Date.now();
    const deadline = start + this.connectMaxWaitMs;
    let lastError: unknown;
    while (true) {
      if (ctx.signal.aborted) {
        throw new Error(`connect to Chrome CDP at ${cdpUrl} aborted`, {
          cause: ctx.signal.reason ?? lastError,
        });
      }
      try {
        return await raceWithTimeout(this.connect(cdpUrl), deadline - Date.now());
      } catch (err) {
        lastError = err;
      }
      if (Date.now() >= deadline) {
        const elapsedMs = Date.now() - start;
        ctx.logger.error('cdp-chrome: gave up connecting to Chrome CDP', {
          cdpUrl,
          connectMaxWaitMs: this.connectMaxWaitMs,
          elapsedMs,
          error: lastError instanceof Error ? lastError.message : String(lastError),
          cause:
            lastError instanceof Error && lastError.cause !== undefined
              ? String(lastError.cause)
              : undefined,
        });
        throw new Error(
          `gave up connecting to Chrome CDP at ${cdpUrl} after ${this.connectMaxWaitMs}ms`,
          { cause: lastError },
        );
      }
      await sleep(this.connectRetryMs, ctx.signal).catch(() => {
        // Swallow here — the loop re-checks ctx.signal.aborted on its next
        // pass and throws the abort-specific error above.
      });
    }
  }
}

/**
 * Races an in-flight promise against a timer of `ms` — used to enforce
 * connectMaxWaitMs on a single connect() attempt (playwright's
 * connectOverCDP has its own internal ~30s timeout that must never be
 * allowed to outlive our configured cap). The timer is always cleared,
 * whichever side settles first, so a losing timer can never keep the
 * process alive or leak. `task` itself is left to settle on its own time —
 * Promise.race attaches a handler to it, so a late rejection never surfaces
 * as an unhandled rejection.
 */
function raceWithTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        reject(new Error(`connect attempt exceeded ${Math.max(ms, 0)}ms`));
      },
      Math.max(ms, 0),
    );
  });
  return Promise.race([task, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
