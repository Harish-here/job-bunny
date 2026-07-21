import { chromium } from 'playwright';
import type {
  BrowserHandle,
  BrowserProvider,
  PageHandle,
} from '../../../ports/browser.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { ChromeProcessHandle, KillDeps, LauncherDeps } from './launcher.ts';
import {
  CHROME_MAX_AGE_MS,
  DEFAULT_CDP_PORT,
  DEFAULT_USER_DATA_DIR,
  getProcessAgeMs as defaultGetProcessAgeMs,
  killChrome as defaultKillChrome,
  launchChrome as defaultLaunchChrome,
  resolveListenerPid as defaultResolveListenerPid,
} from './launcher.ts';

/**
 * CdpChromeProvider — BrowserProvider implementation over a real, locally
 * spawned Chrome attached via CDP (playwright's connectOverCDP). Every
 * PageHandle method is deadline-bound: a hanging playwright call rejects at
 * opts.timeoutMs even if playwright itself never honors the abort signal
 * (2026-07-17 lesson — see src/pipeline/runner/guard.ts for the same race
 * pattern, replicated locally here since adapters must not import pipeline/).
 *
 * Chrome lifecycle mirrors scripts/lib/browser.js's proven, hard-won
 * ensureChrome pattern:
 *  - launch() ALWAYS probes CDP reachability (bounded fetch of
 *    `${cdpUrl}/json/version`) before spawning. Reachable + fresh (age
 *    <= maxAgeMs, via resolveListenerPid + getProcessAgeMs) => REUSE the
 *    live instance, no spawn. Reachable + older than maxAgeMs => RECYCLE
 *    (kill the live instance, then spawn fresh over the same user-data-dir)
 *    when recycleIfOld is true, else reuse anyway. Only truly unreachable
 *    falls through to spawning. This exists because launch() used to spawn
 *    unconditionally: a Chrome already listening on the port (same
 *    user-data-dir) makes a fresh spawn hand off and exit immediately
 *    (Chrome's profile singleton behavior) while connectWithRetry goes on
 *    to connect to the OLD Chrome — the handle would then hold the dead
 *    stub's pid and close() would signal a already-gone process, leaking
 *    the real Chrome forever.
 *  - Both the reuse/recycle decision and close() resolve the pid to act on
 *    via resolveListenerPid (v0: `lsof -ti :<port>`) — the pid actually
 *    LISTENING on the CDP port — never the pid launchChrome's spawn() call
 *    happened to return, for the same hand-off reason above.
 *  - NEVER call browser.close() on a CDP-attached connection (a
 *    live-incident lesson there: closing the Browser object over CDP can
 *    take the whole Chrome process down with it, an unreliable way to end a
 *    session) — release the playwright-side reference and separately kill
 *    the OS process by resolved pid (killChrome), unless
 *    JOBBUNNY_KEEP_BROWSER=1.
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

/** Minimal playwright Browser surface this adapter drives. */
export interface CdpBrowser {
  newPage(): Promise<CdpPage>;
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
 * (connection refused, non-2xx, timeout) — never throws. */
const defaultCdpReachable: CdpReachableFn = async (cdpUrl, opts = {}) => {
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
  /** Resolves the pid actually listening on the CDP port (v0: `lsof -ti
   * :<port>`) — used both to decide reuse/recycle and, at close() time, to
   * find the real pid to kill. Injectable so tests never shell out.
   * Default: launcher.ts's resolveListenerPid. */
  resolveListenerPid?: (port: number) => number | undefined;
  /** Age of a running pid (v0: `ps -o etime=`). Injectable so tests never
   * shell out. Default: launcher.ts's getProcessAgeMs. */
  getProcessAgeMs?: (pid: number) => number | null;
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
  private readonly userDataDir: string | undefined;
  private readonly candidates: readonly string[] | undefined;
  private readonly launcherFsDeps: LauncherDeps | undefined;
  private readonly killEnv: NodeJS.ProcessEnv | undefined;
  private readonly connectRetryMs: number;
  private readonly connectMaxWaitMs: number;
  private readonly cdpReachableFn: CdpReachableFn;
  private readonly resolveListenerPidFn: NonNullable<
    CdpChromeProviderDeps['resolveListenerPid']
  >;
  private readonly getProcessAgeMsFn: NonNullable<
    CdpChromeProviderDeps['getProcessAgeMs']
  >;
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
    this.resolveListenerPidFn =
      deps.resolveListenerPid ?? ((port) => defaultResolveListenerPid(port));
    this.getProcessAgeMsFn =
      deps.getProcessAgeMs ?? ((pid) => defaultGetProcessAgeMs(pid));
    this.maxAgeMs = deps.maxAgeMs ?? CHROME_MAX_AGE_MS;
    this.recycleIfOld = deps.recycleIfOld ?? true;
    this.reachabilityTimeoutMs = deps.reachabilityTimeoutMs ?? 2000;
  }

  async launch(ctx: RunContext): Promise<BrowserHandle> {
    const cdpUrl = `http://127.0.0.1:${this.port}`;
    const version = await this.cdpReachableFn(cdpUrl, {
      timeoutMs: this.reachabilityTimeoutMs,
    });
    const listenerPid = version ? this.resolveListenerPidFn(this.port) : undefined;
    const ageMs = listenerPid != null ? this.getProcessAgeMsFn(listenerPid) : null;
    const action = decideChromeAction({
      reachable: !!version,
      ageMs,
      maxAgeMs: this.maxAgeMs,
    });

    if (action === 'reuse' || (action === 'recycle' && !this.recycleIfOld)) {
      const browser = await this.connectWithRetry(cdpUrl, ctx);
      return new CdpChromeBrowserHandle(
        cdpUrl,
        browser,
        ctx,
        listenerPid,
        this.port,
        this.resolveListenerPidFn,
        this.killChromeFn,
        this.killEnv,
      );
    }

    if (action === 'recycle') {
      ctx.logger.info('cdp-chrome: recycling a reachable-but-stale Chrome instance', {
        ageMs,
        maxAgeMs: this.maxAgeMs,
        port: this.port,
      });
      await this.killChromeFn(listenerPid, { env: this.killEnv });
    }

    // action === 'launch', or fell through from a recycle above.
    const proc = this.launchChromeFn(
      { port: this.port, userDataDir: this.userDataDir, candidates: this.candidates },
      this.launcherFsDeps,
    );
    let browser: CdpBrowser;
    try {
      browser = await this.connectWithRetry(cdpUrl, ctx);
    } catch (err) {
      // Connect never succeeded within the cap — don't leak the spawned
      // Chrome process. Resolve the real listener pid rather than trusting
      // proc.pid (same hand-off risk as close(), see class doc comment);
      // fall back to proc.pid only if nothing resolves (e.g. Chrome never
      // got far enough to open the port at all).
      const pidToKill = this.resolveListenerPidFn(this.port) ?? proc.pid;
      await this.killChromeFn(pidToKill, { env: this.killEnv });
      throw err;
    }
    return new CdpChromeBrowserHandle(
      cdpUrl,
      browser,
      ctx,
      proc.pid,
      this.port,
      this.resolveListenerPidFn,
      this.killChromeFn,
      this.killEnv,
    );
  }

  /**
   * Chrome needs a moment to bind its debug port after spawn (v0's
   * scripts/lib/browser.js polls cdpReachable() for up to ~10s before
   * connecting) — connectOverCDP called immediately after spawn races that
   * and fails intermittently. Retries connect() on failure, delayed by
   * connectRetryMs between attempts, bounded by BOTH connectMaxWaitMs and
   * ctx.signal.
   */
  private async connectWithRetry(cdpUrl: string, ctx: RunContext): Promise<CdpBrowser> {
    const deadline = Date.now() + this.connectMaxWaitMs;
    let lastError: unknown;
    while (true) {
      if (ctx.signal.aborted) {
        throw new Error(`connect to Chrome CDP at ${cdpUrl} aborted`, {
          cause: ctx.signal.reason ?? lastError,
        });
      }
      try {
        return await this.connect(cdpUrl);
      } catch (err) {
        lastError = err;
      }
      if (Date.now() >= deadline) {
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

/** Resolves after ms, or rejects immediately with signal.reason if the
 * signal is already aborted / aborts during the wait. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class CdpChromeBrowserHandle implements BrowserHandle {
  readonly cdpUrl: string;
  private readonly browser: CdpBrowser;
  private readonly ctx: RunContext;
  /** Fallback pid only — the one launch() had on hand when this handle was
   * built (spawn's own pid, or the listener pid resolved during the
   * reuse/recycle check). close() re-resolves the live listener pid fresh
   * and prefers that; this is used only if that resolution comes back
   * empty (e.g. Chrome already gone). */
  private readonly fallbackPid: number | undefined;
  private readonly port: number;
  private readonly resolveListenerPidFn: NonNullable<
    CdpChromeProviderDeps['resolveListenerPid']
  >;
  private readonly killChromeFn: NonNullable<CdpChromeProviderDeps['killChrome']>;
  private readonly killEnv: NodeJS.ProcessEnv | undefined;

  constructor(
    cdpUrl: string,
    browser: CdpBrowser,
    ctx: RunContext,
    fallbackPid: number | undefined,
    port: number,
    resolveListenerPidFn: NonNullable<CdpChromeProviderDeps['resolveListenerPid']>,
    killChromeFn: NonNullable<CdpChromeProviderDeps['killChrome']>,
    killEnv: NodeJS.ProcessEnv | undefined,
  ) {
    this.cdpUrl = cdpUrl;
    this.browser = browser;
    this.ctx = ctx;
    this.fallbackPid = fallbackPid;
    this.port = port;
    this.resolveListenerPidFn = resolveListenerPidFn;
    this.killChromeFn = killChromeFn;
    this.killEnv = killEnv;
  }

  async newPage(): Promise<PageHandle> {
    const page = await this.browser.newPage();
    return new CdpChromePageHandle(page, this.ctx);
  }

  async close(): Promise<void> {
    // Deliberately NOT calling browser.close() here — see the class-level
    // doc comment / scripts/lib/browser.js's disconnect() for why. Only the
    // OS-level process kill actually ends the session.
    //
    // Re-resolve the pid actually LISTENING on the port right now rather
    // than trusting whatever pid this handle was built with — that stored
    // pid can be a dead hand-off stub (see class doc comment) that no
    // longer corresponds to the real, running Chrome.
    const pid = this.resolveListenerPidFn(this.port) ?? this.fallbackPid;
    await this.killChromeFn(pid, { env: this.killEnv });
  }
}

class CdpChromePageHandle implements PageHandle {
  private readonly page: CdpPage;
  private readonly ctx: RunContext;

  constructor(page: CdpPage, ctx: RunContext) {
    this.page = page;
    this.ctx = ctx;
  }

  async goto(url: string, opts: { timeoutMs: number }): Promise<void> {
    await withDeadline(
      this.page.goto(url, { timeout: opts.timeoutMs }),
      this.ctx,
      opts.timeoutMs,
      `goto(${url})`,
    );
  }

  async evaluate<T>(fn: string, opts: { timeoutMs: number }): Promise<T> {
    return withDeadline(this.page.evaluate<T>(fn), this.ctx, opts.timeoutMs, 'evaluate');
  }

  async click(selector: string, opts: { timeoutMs: number }): Promise<void> {
    await withDeadline(
      this.page.click(selector, { timeout: opts.timeoutMs }),
      this.ctx,
      opts.timeoutMs,
      `click(${selector})`,
    );
  }

  async waitFor(selector: string, opts: { timeoutMs: number }): Promise<void> {
    await withDeadline(
      this.page.waitForSelector(selector, { timeout: opts.timeoutMs }),
      this.ctx,
      opts.timeoutMs,
      `waitFor(${selector})`,
    );
  }

  async content(opts: { timeoutMs: number }): Promise<string> {
    return withDeadline(this.page.content(), this.ctx, opts.timeoutMs, 'content');
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}

/**
 * Races an in-flight playwright call against a deadline derived from
 * AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) — same
 * race-a-promise-against-an-abort-listener pattern as
 * src/pipeline/runner/guard.ts's runOneAttempt, replicated locally since
 * adapters must not import pipeline/. Guarantees a hanging playwright call
 * rejects at ~timeoutMs even though playwright itself doesn't accept an
 * AbortSignal.
 */
function withDeadline<T>(
  task: Promise<T>,
  ctx: RunContext,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadlineSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);

  let onAbort: () => void = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(toAbortError(deadlineSignal, label));
    if (deadlineSignal.aborted) {
      onAbort();
      return;
    }
    deadlineSignal.addEventListener('abort', onAbort, { once: true });
  });

  return Promise.race([task, abortPromise]).finally(() => {
    deadlineSignal.removeEventListener('abort', onAbort);
  });
}

function toAbortError(signal: AbortSignal, label: string): Error {
  return new Error(`${label} timed out`, { cause: signal.reason });
}
