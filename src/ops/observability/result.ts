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

/** Funnel for a single stage: counts leaving vs entering, and — for every
 * dropped record still riding along in `payloadOut` — the FIRST failing
 * verdict's rule name (spec §4: "why did this job disappear?"). */
export function buildFunnel(
  payloadIn: StagePayload,
  payloadOut: StagePayload,
): { jobsIn: number; jobsOut: number; dropsByRule: Record<string, number> } {
  const dropsByRule: Record<string, number> = {};
  for (const record of payloadOut.dropped) {
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
