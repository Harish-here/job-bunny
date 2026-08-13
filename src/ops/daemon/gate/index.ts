export type { DeferredSweepDeps } from './deferred_sweep.ts';
export {
  runDeferredSweepAndCatchup,
  runRetrospectiveDeferredSweep,
} from './deferred_sweep.ts';
export type { ReachabilityGateDecision } from './reachability_gate.ts';
export { applyGateDecline, computeReachabilityGate } from './reachability_gate.ts';
