import type { RunContext } from './context.ts';

/**
 * Lifecycle + page surface. P4 (cdp-chrome adapter + LinkedIn lane) is the
 * sole owner of this port for the phase — do not extend further outside it.
 */
export interface BrowserProvider {
  readonly name: string;
  launch(ctx: RunContext): Promise<BrowserHandle>;
}

export interface BrowserHandle {
  readonly cdpUrl: string;
  newPage(): Promise<PageHandle>;
  close(): Promise<void>;
}

/** Minimal page surface lanes are allowed to use. Every method takes the
 * deadline from the RunContext signal it was created under. */
export interface PageHandle {
  goto(url: string, opts: { timeoutMs: number }): Promise<void>;
  /** Run a function in-page and return its JSON-serializable result —
   * the batch-harvest workhorse. */
  evaluate<T>(fn: string, opts: { timeoutMs: number }): Promise<T>;
  click(selector: string, opts: { timeoutMs: number }): Promise<void>;
  waitFor(selector: string, opts: { timeoutMs: number }): Promise<void>;
  content(opts: { timeoutMs: number }): Promise<string>;
  close(): Promise<void>;
}
