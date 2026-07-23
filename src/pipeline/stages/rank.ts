import type { StructuredJD } from '../../core/jd/index.ts';
import { type RankConfig, rank } from '../../core/rank/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';

/**
 * Rank stage (P7 Task 5) — thin `StageDef` wrapper over the pure
 * `core/rank`'s `rank(jobs, cfg)`: scores every surviving job (deterministic
 * 100-pt score, `excitement` banding, `matchReasons`, including a per-rule
 * penalty for every soft-fail verdict the `filter` stage left attached —
 * see `core/rank/rank.ts`'s `softFailPenalty`). Runs last in the job-flow
 * before `sync`, after `filter`/`dedup` have already dropped every hard
 * casualty, so every job on the payload must carry `structured` — same
 * fail-loud-on-ordering-bug posture as `filter.ts`/`compress.ts`.
 *
 * `cfg: RankConfig` is injected via a factory (`makeRankStage`), the same
 * pattern as `makeFilterStage`'s `FilterConfig` (see filter.ts's header for
 * why config is a constructor argument rather than something read off
 * `ctx`).
 */
export function makeRankStage(cfg: RankConfig): StageDef<StagePayload, StagePayload> {
  return {
    name: 'rank',
    timeoutMs: 30_000,
    retries: 0,
    async run(input: StagePayload, _ctx: StageContext): Promise<StagePayload> {
      const structuredJobs: StructuredJD[] = input.jobs.map((jd) => {
        if (!jd.structured) {
          throw new Error(
            `rank: job ${jd.identity.id} has no structured data — rank must run after filter/dedup`,
          );
        }
        return jd as StructuredJD;
      });

      const ranked = rank(structuredJobs, cfg);
      return { jobs: ranked, dropped: input.dropped };
    },
  };
}
