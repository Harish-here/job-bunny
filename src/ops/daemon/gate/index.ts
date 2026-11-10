export type { DeferredSweepDeps } from './deferred_sweep/index.ts';
export {
  runDeferredSweepAndCatchup,
  runRetrospectiveDeferredSweep,
} from './deferred_sweep/index.ts';
export type {
  CatchupGateCache,
  ReachabilityGateDecision,
} from './reachability_gate.ts';
export {
  applyGateDecline,
  computeCatchupOnlyGate,
  computeReachabilityGate,
  createWakeSettleTracker,
} from './reachability_gate.ts';
