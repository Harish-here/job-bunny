import { decide, evaluate, type FilterConfig } from '../../core/filter/index.ts';
import type { DroppedRecord, JD, StructuredJD } from '../../core/jd/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';

/**
 * Filter stage (P7 Task 5) — thin `StageDef` wrapper over the P2 filter
 * engine (`core/filter`'s `evaluate`/`decide`): runs the full rule set
 * against every job's `structured` data (must run after `assemble`, which is
 * where `structured` first appears) and splits the payload by
 * `decide()`'s verdict:
 *   - `'drop'` (any failing *hard* rule)  ⇒ the job becomes a `DroppedRecord`
 *     (`reasons` = this stage's verdicts), same "why did this job disappear"
 *     contract every gate in the pipeline follows.
 *   - `'keep'` (soft fails only, or none)  ⇒ the job survives with every
 *     verdict (soft AND hard-that-passed) appended to
 *     `evaluation.verdicts` — soft *failing* verdicts are exactly what the
 *     later `rank` stage penalizes (`core/rank`'s `softFailPenalty` reads
 *     `jd.evaluation.verdicts`), so they must ride along on the surviving
 *     job, not just live in a dropped record nobody sees again.
 *
 * `cfg: FilterConfig` is injected via a factory (`makeFilterStage`), the
 * same pattern `structure.ts` uses for `LlmProvider` and `source.ts` uses
 * for `RegistryPolicy`/`opts` — config values a stage needs are constructor
 * arguments, not something pulled off `ctx` (which has no `ports` at the
 * `StageContext` level, and config isn't a port at all).
 */
export function makeFilterStage(cfg: FilterConfig): StageDef<StagePayload, StagePayload> {
  return {
    name: 'filter',
    timeoutMs: 30_000,
    retries: 0,
    async run(input: StagePayload, _ctx: StageContext): Promise<StagePayload> {
      const jobs: JD[] = [];
      const newDrops: DroppedRecord[] = [];

      for (const jd of input.jobs) {
        if (!jd.structured) {
          throw new Error(
            `filter: job ${jd.identity.id} has no structured data — filter must run after assemble`,
          );
        }
        const structuredJd = jd as StructuredJD;
        const verdicts = evaluate(structuredJd, cfg);

        if (decide(verdicts) === 'drop') {
          newDrops.push({ jd: structuredJd, reasons: verdicts });
          continue;
        }

        jobs.push({
          ...structuredJd,
          evaluation: {
            verdicts: [...(structuredJd.evaluation?.verdicts ?? []), ...verdicts],
            matchReasons: structuredJd.evaluation?.matchReasons ?? [],
            ...(structuredJd.evaluation?.duplicateOf !== undefined
              ? { duplicateOf: structuredJd.evaluation.duplicateOf }
              : {}),
            ...(structuredJd.evaluation?.score !== undefined
              ? { score: structuredJd.evaluation.score }
              : {}),
            ...(structuredJd.evaluation?.excitement !== undefined
              ? { excitement: structuredJd.evaluation.excitement }
              : {}),
          },
        });
      }

      return { jobs, dropped: [...input.dropped, ...newDrops] };
    },
  };
}
