/**
 * Fire-and-forget cleanup for a connect attempt that lost its race (timeout
 * or abort): if the underlying promise resolves LATER, close the Browser it
 * yields so its CDP websocket doesn't leak. Never awaited, never throws — a
 * rejected attempt or a failing close() is swallowed.
 */
export function disposeWhenSettled(task: Promise<{ close?(): Promise<void> }>): void {
  task.then((browser) => browser.close?.()).catch(() => {});
}
