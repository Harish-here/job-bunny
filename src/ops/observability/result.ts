import { z } from 'zod';
import type { StagePayload } from '../../pipeline/runner/stage.ts';

export const RunResultSchema = z.object({
  profile: z.string(),
  date: z.string(),
  outcome: z.enum(['passed', 'failed']),
  failedStage: z.string().optional(),
  stages: z.array(
    z.object({
      name: z.string(),
      elapsedMs: z.number(),
      attempts: z.number(),
      jobsIn: z.number(),
      jobsOut: z.number(),
      dropsByRule: z.record(z.string(), z.number()), // the funnel
    }),
  ),
});

export type RunResult = z.infer<typeof RunResultSchema>;

/** Funnel for a single stage. `dropped` rides along cumulatively across
 * stages, so a stage's funnel counts only the records IT newly dropped —
 * those in payloadOut.dropped whose job id was not already dropped in
 * payloadIn (spec §4: "why did this job disappear?"), grouped by each
 * record's FIRST failing verdict rule. */
export function buildFunnel(
  payloadIn: StagePayload,
  payloadOut: StagePayload,
): { jobsIn: number; jobsOut: number; dropsByRule: Record<string, number> } {
  const priorDropped = new Set(payloadIn.dropped.map((record) => record.jd.identity.id));
  const dropsByRule: Record<string, number> = {};
  for (const record of payloadOut.dropped) {
    if (priorDropped.has(record.jd.identity.id)) continue;
    const firstFailing = record.reasons.find((verdict) => verdict.pass === false);
    if (!firstFailing) continue;
    dropsByRule[firstFailing.rule] = (dropsByRule[firstFailing.rule] ?? 0) + 1;
  }
  return {
    jobsIn: payloadIn.jobs.length,
    jobsOut: payloadOut.jobs.length,
    dropsByRule,
  };
}
