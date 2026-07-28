import type { BrowserHandle, PageHandle } from '../../../../ports/browser.ts';
import type { RunContext } from '../../../../ports/context.ts';
import type { ChromePidfileDeps } from '../ownership/index.ts';
import type { CdpBrowser, CdpChromeProviderDeps, CdpPage } from '../provider.ts';
import { CdpChromePageHandle } from './page_handle.ts';

/**
 * NEVER call browser.close() on a CDP-attached connection (a live-incident
 * lesson: closing the Browser object over CDP can take the whole Chrome
 * process down with it, an unreliable way to end a session) — release the
 * playwright-side reference and separately kill the OS process by its
 * recorded pid (killChrome), unless JOBBUNNY_KEEP_BROWSER=1.
 *
 * close() only ever kills a Chrome process THIS run spawned (action launch,
 * or recycle's kill-then-respawn). A reused instance (action reuse, or a
 * stale-but-not-recycled one) is the user's own persistent session — close()
 * drops the CDP connection reference and leaves it running (2026-07-25
 * incident: a reuse run's close() killed the user's logged-in Chrome
 * mid-session).
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
    // Deliberately NOT calling browser.close() here — see the class-level
    // doc comment / scripts/lib/browser.js's disconnect() for why. Only the
    // OS-level process kill actually ends the session.
    //
    // This handle didn't spawn Chrome (reuse, or a stale-but-kept instance)
    // — it's the user's own long-running session, so close() only drops
    // the CDP connection reference and leaves the OS process alone.
    if (!this.ownsProcess) return;

    await this.killChromeFn(this.pid, {
      env: this.killEnv,
      userDataDir: this.userDataDir,
      pidfileDeps: this.pidfileDeps,
    });
  }
}
