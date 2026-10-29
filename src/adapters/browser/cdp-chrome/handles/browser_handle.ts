import type { BrowserHandle, PageHandle } from '../../../../ports/browser.ts';
import type { RunContext } from '../../../../ports/context.ts';
import { raceWithTimeout } from '../async/index.ts';
import type { ChromePidfileDeps } from '../ownership/index.ts';
import type { CdpBrowser, CdpChromeProviderDeps, CdpPage } from '../provider.ts';
import { CdpChromePageHandle } from './page_handle.ts';

/** Upper bound on the websocket disconnect, so a wedged connection can never
 * stall close() past a few seconds. */
export const DEFAULT_DISCONNECT_TIMEOUT_MS = 3000;

/**
 * close() ALWAYS releases the playwright CDP connection, and kills the OS
 * process only when this run spawned it.
 *
 * Verified against Playwright 1.62.1 (2026-10): for a `connectOverCDP`
 * browser, `browser.close()` closes only the websocket — it does NOT send
 * Browser.close and does NOT stop the remote Chrome (probed live: Chrome kept
 * serving /json/version afterwards). So it is safe on an attached, user-owned
 * Chrome. Skipping it was the bug: an attached run left the websocket open,
 * which held node's event loop alive after the pipeline finished.
 *
 * Killing is a separate, OS-level step (killChrome) and only ever targets a
 * Chrome THIS run spawned (action launch, or recycle's kill-then-respawn). A
 * reused/attached instance is the user's own persistent session — close()
 * disconnects from it and leaves it running (2026-07-25 incident: a reuse
 * run's close() killed the user's logged-in Chrome mid-session).
 */
export class CdpChromeBrowserHandle implements BrowserHandle {
  readonly cdpUrl: string;
  private readonly browser: CdpBrowser;
  private readonly ctx: RunContext;
  /** The pid this run spawned (undefined when it merely attached to an
   * already-running, unowned Chrome — ownsProcess is false in that case,
   * so close() never reads this field). */
  private readonly pid: number | undefined;
  private readonly killChromeFn: NonNullable<CdpChromeProviderDeps['killChrome']>;
  private readonly killEnv: NodeJS.ProcessEnv | undefined;
  private readonly userDataDir: string;
  private readonly pidfileDeps: ChromePidfileDeps;
  /** True only when THIS process spawned the Chrome instance behind this
   * handle (launch, or recycle's kill-then-respawn) — false when it merely
   * attached to one already running (reuse, or a recycle-eligible instance
   * kept alive because recycleIfOld is false). close() must only ever kill
   * a process this run is responsible for; killing a reused Chrome tore
   * down the user's own logged-in session out from under them
   * (2026-07-25 incident). */
  private readonly ownsProcess: boolean;
  private readonly disconnectTimeoutMs: number;

  constructor(
    cdpUrl: string,
    browser: CdpBrowser,
    ctx: RunContext,
    pid: number | undefined,
    killChromeFn: NonNullable<CdpChromeProviderDeps['killChrome']>,
    killEnv: NodeJS.ProcessEnv | undefined,
    userDataDir: string,
    pidfileDeps: ChromePidfileDeps,
    ownsProcess: boolean,
    disconnectTimeoutMs: number = DEFAULT_DISCONNECT_TIMEOUT_MS,
  ) {
    this.cdpUrl = cdpUrl;
    this.browser = browser;
    this.ctx = ctx;
    this.pid = pid;
    this.killChromeFn = killChromeFn;
    this.killEnv = killEnv;
    this.userDataDir = userDataDir;
    this.pidfileDeps = pidfileDeps;
    this.ownsProcess = ownsProcess;
    this.disconnectTimeoutMs = disconnectTimeoutMs;
  }

  async newPage(): Promise<PageHandle> {
    const page = await this.openPage();
    return new CdpChromePageHandle(page, this.ctx);
  }

  /** Pages MUST open in the persistent context, mirroring v0
   * (`scripts/lib/browser.js:180` — `browser.contexts()[0] || newContext()`).
   * playwright's `browser.newPage()` is shorthand for `newContext()` +
   * `newPage()`, i.e. a FRESH, cookie-less context. Using it over
   * `connectOverCDP` opened every page logged OUT even though the attached
   * Chrome profile held a valid session — LinkedIn answered every url with
   * its logout wall (observed 2026-07-25). */
  private async openPage(): Promise<CdpPage> {
    const existing = this.browser.contexts?.()[0];
    if (existing) return existing.newPage();
    if (this.browser.newContext) {
      const created = await this.browser.newContext();
      return created.newPage();
    }
    return this.browser.newPage();
  }

  async close(): Promise<void> {
    // Not ours (reuse / attach): drop the websocket, leave Chrome running.
    if (!this.ownsProcess) {
      await this.disconnect();
      return;
    }

    // Ours: kill FIRST so the kill's timing/semantics are exactly what they
    // were before (a wedged disconnect can never delay it); the disconnect
    // then runs in `finally` so it happens even if the kill throws. Once
    // Chrome is dead the socket is already gone, so this is near-instant.
    try {
      await this.killChromeFn(this.pid, {
        env: this.killEnv,
        userDataDir: this.userDataDir,
        pidfileDeps: this.pidfileDeps,
      });
    } finally {
      await this.disconnect();
    }
  }

  /** Bounded, fail-soft websocket disconnect — never throws. */
  private async disconnect(): Promise<void> {
    try {
      await raceWithTimeout(
        (async () => this.browser.close?.())(),
        this.disconnectTimeoutMs,
      );
    } catch (err) {
      this.ctx.logger.warn('cdp-chrome: CDP disconnect failed or timed out', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
