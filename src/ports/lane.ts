import type { JD } from '../core/jd/index.ts';
import type { RunContext } from './context.ts';

export type ProbeResult =
  | { status: 'found'; boardRef: string }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/** Browser-driven sourcing. The card gate (filter evaluateCard) runs
 * inside the lane BEFORE a JD is opened — token/browser economy, spec §4. */
export interface FarmingLane {
  readonly kind: 'farming';
  readonly name: string;
  source(ctx: RunContext): Promise<{ jobs: JD[]; companiesSeen: string[] }>;
}

/** Keyless ATS API sourcing, driven by the generic probe/fetch loop (P5). */
export interface ApiLane {
  readonly kind: 'api';
  readonly name: string;
  probe(company: string, ctx: RunContext): Promise<ProbeResult>;
  fetchBoard(boardRef: string, ctx: RunContext): Promise<JD[]>;
}

export type Lane = FarmingLane | ApiLane;
