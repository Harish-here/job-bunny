import { z } from 'zod';
import {
  boardsToFetch,
  type CompanyRecord,
  probeCandidates,
  type RegistryPolicy,
  RegistrySchema,
  recordFetchFailure,
  recordProbe,
  upsertSeen,
} from '../../core/company/index.ts';
import { isSoftError, SoftError } from '../../core/errors/index.ts';
import { type JD, JDSchema } from '../../core/jd/index.ts';
import type { ApiLane } from '../../ports/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';

/**
 * Side-write from farming lanes: map of farming-lane-name → company names
 * it saw this run. Lives at registry/companies_seen.json, NOT in
 * StagePayload — keeps StagePayload frozen (spec, P5 Task 2).
 */
export const CompaniesSeenSchema = z.record(z.string(), z.array(z.string()));

const REGISTRY_PATH = 'registry/companies.json';
const COMPANIES_SEEN_PATH = 'registry/companies_seen.json';

/**
 * Generic probe/fetch source stage (spec §5, P5 Task 2): reads the company
 * registry + companies-seen side-write, upserts sightings, probes candidates
 * (capped by opts.maxProbesPerRun across the whole run, politeness), fetches
 * boards found, and appends the resulting JDs to the payload. Every
 * probe/fetch failure is a narrow SoftError — a whole-lane outage yields
 * zero jobs from that lane plus a warn, never a thrown stage failure
 * (v0 invariant: API lanes are optional breadth).
 */
export function makeSourceStage(
  apiLanes: ApiLane[],
  policy: RegistryPolicy,
  opts: { maxProbesPerRun: number },
): StageDef<StagePayload, StagePayload> {
  return {
    name: 'source',
    timeoutMs: 120_000,
    retries: 0,
    async run(input, ctx: StageContext) {
      const now = new Date().toISOString();
      let reg: CompanyRecord[] =
        (await ctx.storage.readJson(REGISTRY_PATH, RegistrySchema)) ?? [];

      const seen =
        (await ctx.storage.readJson(COMPANIES_SEEN_PATH, CompaniesSeenSchema)) ?? {};
      for (const [farmLane, names] of Object.entries(seen)) {
        reg = upsertSeen(reg, names, farmLane, now);
      }

      const fetchedJobs: JD[] = [];
      let probesIssued = 0;

      for (const apiLane of apiLanes) {
        try {
          const candidates = probeCandidates(reg, apiLane.name, policy, now);

          for (const candidate of candidates) {
            if (probesIssued >= opts.maxProbesPerRun) break;

            try {
              const result = await apiLane.probe(candidate.name, ctx);
              reg = recordProbe(reg, candidate.normalizedKey, apiLane.name, result, now);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const soft = isSoftError(err)
                ? err
                : new SoftError(`source.probe.${apiLane.name}`, message, { cause: err });
              ctx.logger.warn('probe failed', {
                lane: apiLane.name,
                company: candidate.name,
                error: soft.message,
              });
              reg = recordProbe(
                reg,
                candidate.normalizedKey,
                apiLane.name,
                { status: 'error', message: soft.message },
                now,
              );
            }
            probesIssued++;
          }

          const boards = boardsToFetch(reg, apiLane.name);
          for (const { key, boardRef } of boards) {
            try {
              const jobs = await apiLane.fetchBoard(boardRef, ctx);
              for (const job of jobs) {
                const parsed = JDSchema.safeParse(job);
                if (parsed.success) {
                  fetchedJobs.push(parsed.data);
                } else {
                  ctx.logger.warn('dropped invalid JD from board fetch', {
                    lane: apiLane.name,
                    boardRef,
                    error: parsed.error.message,
                  });
                }
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const soft = isSoftError(err)
                ? err
                : new SoftError(`source.fetch.${apiLane.name}`, message, { cause: err });
              ctx.logger.warn('board fetch failed', {
                lane: apiLane.name,
                boardRef,
                error: soft.message,
              });
              reg = recordFetchFailure(reg, key, apiLane.name, policy);
            }
          }
        } catch (err) {
          // Whole-lane outage: never let one lane's total failure stop the others.
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn('api lane failed entirely', {
            lane: apiLane.name,
            error: message,
          });
        }
      }

      await ctx.storage.writeJson(REGISTRY_PATH, reg);

      return { jobs: [...input.jobs, ...fetchedJobs], dropped: input.dropped };
    },
  };
}
