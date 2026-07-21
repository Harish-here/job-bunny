import { chromium } from 'playwright';
import type {
  BrowserHandle,
  BrowserProvider,
  PageHandle,
} from '../../../ports/browser.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { ChromeProcessHandle, KillDeps, LauncherDeps } from './launcher.ts';
import {
  DEFAULT_CDP_PORT,
  DEFAULT_USER_DATA_DIR,
  killChrome as defaultKillChrome,
  launchChrome as defaultLaunchChrome,
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
 * pattern: NEVER call browser.close() on a CDP-attached connection (a
 * live-incident lesson there: closing the Browser object over CDP can take
 * the whole Chrome process down with it, an unreliable way to end a
 * session) — release the playwright-side reference and separately kill the
 * spawned OS process by pid (killChrome), unless JOBBUNNY_KEEP_BROWSER=1.
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

export interface CdpChromeProviderDeps {
  connect?: ConnectFn;
  launchChrome?: (
    options: { port: number; userDataDir?: string; candidates?: readonly string[] },
    deps?: LauncherDeps,
  ) => ChromeProcessHandle;
  killChrome?: (pid: number | undefined, deps?: KillDeps) => boolean;
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
  }

  async launch(ctx: RunContext): Promise<BrowserHandle> {
    const proc = this.launchChromeFn(
      { port: this.port, userDataDir: this.userDataDir, candidates: this.candidates },
      this.launcherFsDeps,
    );
    const cdpUrl = `http://127.0.0.1:${this.port}`;
    let browser: CdpBrowser;
    try {
      browser = await this.connectWithRetry(cdpUrl, ctx);
    } catch (err) {
      // Connect never succeeded within the cap — don't leak the spawned
      // Chrome process, kill it before propagating the failure.
      this.killChromeFn(proc.pid, { env: this.killEnv });
      throw err;
    }
    return new CdpChromeBrowserHandle(
      cdpUrl,
      browser,
      ctx,
      proc.pid,
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
  private readonly pid: number | undefined;
  private readonly killChromeFn: NonNullable<CdpChromeProviderDeps['killChrome']>;
  private readonly killEnv: NodeJS.ProcessEnv | undefined;

  constructor(
    cdpUrl: string,
    browser: CdpBrowser,
    ctx: RunContext,
    pid: number | undefined,
    killChromeFn: NonNullable<CdpChromeProviderDeps['killChrome']>,
    killEnv: NodeJS.ProcessEnv | undefined,
  ) {
    this.cdpUrl = cdpUrl;
    this.browser = browser;
    this.ctx = ctx;
    this.pid = pid;
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
    this.killChromeFn(this.pid, { env: this.killEnv });
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
