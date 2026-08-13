export type { DeferredSweepDeps } from './deferred_sweep.ts';
export {
  runDeferredSweepAndCatchup,
  runRetrospectiveDeferredSweep,
} from './deferred_sweep.ts';
export type {
  CatchupGateCache,
  ReachabilityGateDecision,
} from './reachability_gate.ts';
export {
  applyGateDecline,
  computeCatchupOnlyGate,
  computeReachabilityGate,
} from './reachability_gate.ts';
