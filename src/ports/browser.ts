import type { RunContext } from './context.ts';

/**
 * Lifecycle surface only. P4 extends this with page operations once the
 * LinkedIn lane's real needs are known — do not speculate here.
 */
export interface BrowserProvider {
  readonly name: string;
  launch(ctx: RunContext): Promise<BrowserHandle>;
}

export interface BrowserHandle {
  readonly cdpUrl: string;
  close(): Promise<void>;
}
