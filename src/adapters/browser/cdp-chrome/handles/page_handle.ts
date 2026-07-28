import type { PageHandle } from '../../../../ports/browser.ts';
import type { RunContext } from '../../../../ports/context.ts';
import type { CdpPage } from '../provider.ts';

export class CdpChromePageHandle implements PageHandle {
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
