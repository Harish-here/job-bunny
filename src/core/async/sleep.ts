/**
 * core/async/sleep.ts — abort-aware delay, shared by any adapter that
 * needs a cancellable wait (P9 tail: LinkedIn lane jitter is the first
 * caller; adapters/browser/cdp-chrome/provider.ts's connect-retry backoff
 * had its own private copy of this exact function before this file
 * existed). Lives in core (not e.g. adapters/browser/**) because
 * .dependency-cruiser.cjs's `adapters-no-cross-family` rule forbids one
 * adapter family (adapters/lanes/linkedin) reaching into another's
 * internals (adapters/browser/cdp-chrome) — core is importable by every
 * adapter family, so this is the one legal shared home. Pure infra, no
 * business logic: resolves after `ms`, or rejects immediately with
 * `signal.reason` if the signal is already aborted / aborts during the
 * wait. The pending timer is always cleared (on resolve, on abort) so a
 * cancelled wait never leaks a timer or keeps the event loop alive.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
