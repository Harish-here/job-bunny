import type { JD, Verdict } from '../../core/jd/index.ts';
import type { RunContext, Storage } from '../../ports/index.ts';

export interface DroppedRecord {
  jd: JD;
  reasons: Verdict[];
}

/** Standard payload flowing between job-flow stages. Dropped records ride
 * along so the funnel and checkpoints can always answer "why did this
 * job disappear?" (spec §4). */
export interface StagePayload {
  jobs: JD[];
  dropped: DroppedRecord[];
}

export interface StageContext extends RunContext {
  storage: Storage;
}

export interface StageDef<In, Out> {
  name: string;
  timeoutMs: number;
  retries: number; // 0 for most; structure/sync 1–2
  heartbeat?: boolean; // declared ⇒ stall watchdog armed
  run(input: In, ctx: StageContext): Promise<Out>;
}
