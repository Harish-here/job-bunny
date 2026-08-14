/**
 * ops/daemon/gate/deferred_sweep/ — public surface (two-pair rule: this
 * folder's own internals — `sweep.ts` and `notify_throttle.ts` — are never
 * imported by anything outside it; only `../index.ts` (`gate/index.ts`)
 * imports from here).
 */
export type { DeferredSweepDeps } from './sweep.ts';
export { runDeferredSweepAndCatchup, runRetrospectiveDeferredSweep } from './sweep.ts';
