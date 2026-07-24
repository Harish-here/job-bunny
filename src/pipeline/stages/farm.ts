import type { DroppedRecord, JD } from '../../core/jd/index.ts';
import type { FarmingLane } from '../../ports/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';
import { CompaniesSeenSchema } from './source.ts';

/** Same relative path source.ts reads from (see its COMPANIES_SEEN_PATH /
 * CompaniesSeenSchema doc comment) — farm is the ONLY writer of this file,
 * source is the only reader; farm MUST run before source in pipeline
 * order so the side-write exists when source needs it. */
const COMPANIES_SEEN_PATH = 'registry/companies_seen.json';

/** Generous over a browser-driven farming run — LinkedIn navigation across
 * several search-URL groups is slower than an API probe/fetch loop
 * (source.ts's 300s), and each FarmingLane already owns its own bounded
 * per-URL/per-card timeouts internally (see adapters/lanes/linkedin), so
 * this is a ceiling on the whole stage, not a per-URL budget. */
const TIMEOUT_MS = 600_000;

/**
 * Farming-lane source stage (spec §5, sibling to source.ts's ApiLane
 * loop): runs each FarmingLane (browser-driven — currently LinkedIn) in
 * order, collecting the jobs and card-gate DroppedRecords each one
 * emits, and writes the companies-seen side-write every farming lane
 * reports this run to registry/companies_seen.json — the SAME path and
 * CompaniesSeenSchema (map of farm-lane-name -> company names it saw
 * this run) that source.ts reads back and folds into the company
 * registry via upsertSeen. farm MUST run before source in pipeline
 * order.
 *
 * Fail-soft granularity mirrors source.ts's whole-lane handling: a
 * FarmingLane's own contract (adapters/lanes/linkedin/lane.ts) already
 * absorbs per-URL-group and per-card failures internally and only
 * throws out of source() for a genuinely lane-wide outage (e.g. every
 * attempted URL failed — shaped like an expired LinkedIn session). One
 * lane's total failure must never stop the others, so that throw is
 * caught here, logged as a warn, and the run moves on to the next lane
 * — UNLESS the stage's own ctx.signal is what's aborted, in which case
 * the abort is rethrown immediately (never swallowed into a
 * lane-failure warn) and, as with source.ts, nothing is written for a
 * run-level abort (an aborted run must not durably clobber a healthy
 * companies_seen.json with a partial run's view).
 */
export function makeFarmStage(
  farmingLanes: FarmingLane[],
): StageDef<StagePayload, StagePayload> {
  return {
    name: 'farm',
    timeoutMs: TIMEOUT_MS,
    retries: 0,
    async run(input: StagePayload, ctx: StageContext): Promise<StagePayload> {
      const farmedJobs: JD[] = [];
      const farmedDropped: DroppedRecord[] = [];
      const seen: Record<string, string[]> = {};

      for (const lane of farmingLanes) {
        try {
          const result = await lane.source(ctx);
          farmedJobs.push(...result.jobs);
          farmedDropped.push(...result.dropped);
          seen[lane.name] = result.companiesSeen;
        } catch (err) {
          if (ctx.signal.aborted) throw err; // run-level abort: propagate, no side-write
          // Whole-lane outage: never let one lane's total failure stop the others.
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn('farming lane failed entirely', {
            lane: lane.name,
            error: message,
          });
        }
      }

      await ctx.storage.writeJson(COMPANIES_SEEN_PATH, CompaniesSeenSchema.parse(seen));

      return {
        jobs: [...input.jobs, ...farmedJobs],
        dropped: [...input.dropped, ...farmedDropped],
      };
    },
  };
}
