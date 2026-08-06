import type { DroppedRecord, JD } from '../../core/jd/index.ts';
import type { FarmingLane } from '../../ports/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';
import { CompaniesSeenSchema } from './source.ts';

/** Same relative path source.ts reads from (see its COMPANIES_SEEN_PATH /
 * CompaniesSeenSchema doc comment) — farm is the ONLY writer of this file,
 * source is the only reader; farm MUST run before source in pipeline
 * order so the side-write exists when source needs it. */
const COMPANIES_SEEN_PATH = 'registry/companies_seen.json';

/** 90-minute ceiling over a browser-driven farming run. LinkedIn navigation is
 * slower than API-only staging (source.ts's 300s). The LinkedIn lane adds 5–12s
 * jitter per JD open and per URL navigation, plus a 20–45s pause between
 * saved-search URLs (throttle guard, 2026-07-28 — LinkedIn soft-blocked the
 * shared session under the previous 2–5s cadence). That puts a typical 21-URL
 * fire at roughly 25 minutes, still ~3.5x inside this ceiling, so the value
 * below is deliberately UNCHANGED by that pacing work. Each FarmingLane owns its
 * own bounded per-URL/per-card timeouts internally (adapters/lanes/linkedin), so
 * this is a stage ceiling, not a per-URL budget. This is a ceiling, not typical
 * runtime: real card counts drop well below maxCardsPerUrl (40) via title/avoid
 * card-gating and Notion-cache skips. */
const TIMEOUT_MS = 5_400_000;

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
 *
 * If EVERY farming lane throws, this is not "some breadth lost", it's a
 * total outage — mirrors linkedin/lane.ts's own all-urls-failed guard:
 * fail loud rather than a silently-green zero-job run (v0
 * checkAggregateFailure).
 *
 * **WIRING CONSTRAINT (runPipeline integration):** This stage declares
 * `heartbeat: true` and calls `ctx.beat()` from within each FarmingLane's
 * source() loop (LinkedInLane.source() calls ctx.beat() per card). When
 * wiring this stage into runPipeline, the guard's `stallMs` MUST be set
 * greater than the largest per-unit blocking window within a farming lane
 * (LinkedIn's per-card work: goto ~30s + jd_open per-call timeouts), or the
 * stall watchdog will false-kill a healthy in-progress card. In practice,
 * structure's own constraint (stallMs > 300_000ms LLM per-call timeout) is
 * the larger bound and already covers farm's window, but document farm's
 * requirement explicitly to ensure any future lane implementation respects it.
 */
export function makeFarmStage(
  farmingLanes: FarmingLane[],
): StageDef<StagePayload, StagePayload> {
  return {
    name: 'farm',
    timeoutMs: TIMEOUT_MS,
    retries: 0,
    heartbeat: true,
    async run(input: StagePayload, ctx: StageContext): Promise<StagePayload> {
      const farmedJobs: JD[] = [];
      const farmedDropped: DroppedRecord[] = [];
      const seen: Record<string, string[]> = {};
      let failedLanes = 0;
      let skippedLanes = 0;

      for (const lane of farmingLanes) {
        try {
          const result = await lane.source(ctx);
          if (result.skipped) {
            // Deliberately attempted nothing (e.g. the LinkedIn lane
            // sitting out a throttle cooldown). Not a failure, not an
            // empty success: it contributes no companies_seen entry and
            // is excluded from the outage denominator below.
            skippedLanes += 1;
            ctx.logger.info('farming lane skipped', {
              lane: lane.name,
              reason: result.skipped.reason,
            });
            continue;
          }
          farmedJobs.push(...result.jobs);
          farmedDropped.push(...result.dropped);
          seen[lane.name] = result.companiesSeen;
        } catch (err) {
          if (ctx.signal.aborted) throw err; // run-level abort: propagate, no side-write
          // Whole-lane outage: never let one lane's total failure stop the others.
          failedLanes += 1;
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn('farming lane failed entirely', {
            lane: lane.name,
            error: message,
          });
        }
      }

      // Every farming lane that ATTEMPTED work failed: not one broken lane,
      // a total outage — fail loud rather than a silently-green zero-job run
      // (mirrors linkedin/lane.ts's all-urls-failed guard, v0
      // checkAggregateFailure). Skipped lanes are excluded from the
      // denominator (D10): a lane that never touched the network cannot be
      // evidence of an outage, and counting it would turn a deliberate
      // throttle cooldown into a failed run — the exact opposite of the
      // graceful degradation the skip exists to provide.
      //
      // Known, accepted cost (2026-07-26 review): LinkedIn is currently
      // the ONLY farming lane, so this throw aborts the whole 10-stage run
      // at stage 2 and the healthy Greenhouse/Keka lanes never run that
      // day — an expired login pauses ATS sourcing until it's fixed.
      // Deliberately kept: the abort is what makes the outage loud (the
      // runner's failure digest fires), and downgrading it to a warn
      // inside a green run would bury the expired-login signal — exactly
      // what CLAUDE.md's fail-loud-on-total-outage invariant forbids.
      // Letting ATS lanes still run would need a real "degraded run"
      // status flowing through result.json into both digests — a feature,
      // not a tweak to this condition.
      const attemptedLanes = farmingLanes.length - skippedLanes;
      if (attemptedLanes > 0 && failedLanes === attemptedLanes) {
        throw new Error(
          `farm stage: all ${attemptedLanes} farming lane(s) failed this run — ` +
            'total outage, not one broken lane',
        );
      }

      await ctx.stateStore.writeDoc(COMPANIES_SEEN_PATH, CompaniesSeenSchema.parse(seen));

      return {
        jobs: [...input.jobs, ...farmedJobs],
        dropped: [...input.dropped, ...farmedDropped],
      };
    },
  };
}
