import type { DroppedRecord, JD } from '../core/jd/index.ts';
import type { RunContext } from './context.ts';

export type ProbeResult =
  | { status: 'found'; boardRef: string }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/** Browser-driven sourcing. The card gate (filter evaluateCard) runs
 * inside the lane BEFORE a JD is opened — token/browser economy, spec §4.
 * `dropped` carries every card-gate drop (identity-only JD + verdicts) so
 * the funnel can always answer "why did this job disappear?" — a lane
 * must never silently swallow them. */
export interface FarmingLane {
  readonly kind: 'farming';
  readonly name: string;
  source(ctx: RunContext): Promise<{
    jobs: JD[];
    dropped: DroppedRecord[];
    companiesSeen: string[];
  }>;
}

/** Keyless ATS API sourcing, driven by the generic probe/fetch loop (P5).
 * `fetchBoard` returns both the surviving jobs AND every job it dropped
 * (e.g. a job that parses the lane's own raw-job schema but fails the
 * final JDSchema build) as DroppedRecords — same funnel-visibility
 * contract as `FarmingLane.source`'s `dropped`, so a caller (the source
 * stage) can always account for a disappearing job instead of a lane
 * being able to swallow it into a warn log line alone. */
export interface ApiLane {
  readonly kind: 'api';
  readonly name: string;
  probe(company: string, ctx: RunContext): Promise<ProbeResult>;
  fetchBoard(
    boardRef: string,
    ctx: RunContext,
  ): Promise<{ jobs: JD[]; dropped: DroppedRecord[] }>;
}

export type Lane = FarmingLane | ApiLane;
