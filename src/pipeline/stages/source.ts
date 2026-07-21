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
 * Wall-clock budget given to each API lane's probe+fetch work, composed
 * onto the stage's own signal via AbortSignal.any (finding: a hard 120s
 * stage timeout defeats the lanes' fail-soft contract — worst case against
 * a blackholed ATS is 10s FETCH_TIMEOUT × up to 3 candidates × ~25 probes
 * + board fetches ≈ 750s+ for a single lane). When a lane's own budget
 * fires (and only that — not a real run cancellation), the lane's
 * remaining work is abandoned, logged as a warn, and the run moves on to
 * the next lane keeping whatever jobs that lane already fetched.
 */
const LANE_BUDGET_MS = 90_000;

/**
 * Generic probe/fetch source stage (spec §5, P5 Task 2): reads the company
 * registry + companies-seen side-write, upserts sightings, probes candidates
 * (capped by opts.maxProbesPerRun across the whole run, politeness), fetches
 * boards found, and appends the resulting JDs to the payload. Every
 * probe/fetch failure is a narrow SoftError — a whole-lane outage yields
 * zero jobs from that lane plus a warn, never a thrown stage failure
 * (v0 invariant: API lanes are optional breadth).
 *
 * timeoutMs (300s) is sized against LANE_BUDGET_MS (90s): with the two
 * lanes currently wired (greenhouse, keka) that's 2 × 90s = 180s of
 * lane work, leaving 120s of headroom for registry I/O and bookkeeping
 * before the stage's own guardStage timeout could ever fire under normal
 * operation. If a third lane is wired, raise timeoutMs (or lower
 * LANE_BUDGET_MS) so the sum of per-lane budgets stays comfortably under
 * it.
 *
 * Three abort-ish causes are deliberately kept distinct (throwIfAborted
 * below, plus each lane's own ctx.signal.aborted check before recording a
 * probe/fetch error — see greenhouse/keka lane.ts): a lane exceeding
 * LANE_BUDGET_MS is a soft, per-lane event — nothing is recorded for the
 * candidate/board in flight, but the registry write at the end still
 * happens with whatever was legitimately recorded before the budget
 * fired. A genuine run-level
 * abort (ctx.signal, the stage's own composed signal) is terminal for the
 * whole stage — it is rethrown immediately and the registry is NEVER
 * written, so an aborted run can't durably lock out a healthy company via
 * a stray failCount/staleness bump.
 */
export function makeSourceStage(
  apiLanes: ApiLane[],
  policy: RegistryPolicy,
  opts: {
    maxProbesPerRun: number;
    /** Overrides LANE_BUDGET_MS — production callers should leave this
     * unset; tests use it to exercise the budget-expiry path without a
     * real 90s wait. */
    laneBudgetMs?: number;
  },
): StageDef<StagePayload, StagePayload> {
  const laneBudgetMs = opts.laneBudgetMs ?? LANE_BUDGET_MS;

  return {
    name: 'source',
    timeoutMs: 300_000,
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
        throwIfAborted(ctx.signal);

        const laneBudget = new AbortController();
        const laneBudgetTimer = setTimeout(() => {
          laneBudget.abort(
            new SoftError(
              `source.budget.${apiLane.name}`,
              `lane ${apiLane.name} exceeded its ${laneBudgetMs}ms budget`,
            ),
          );
        }, laneBudgetMs);
        laneBudgetTimer.unref?.();

        try {
          const laneSignal = AbortSignal.any([ctx.signal, laneBudget.signal]);
          const laneCtx: StageContext = { ...ctx, signal: laneSignal };

          let budgetExpired = false;
          const candidates = probeCandidates(reg, apiLane.name, policy, now);

          for (const candidate of candidates) {
            if (probesIssued >= opts.maxProbesPerRun) break;
            throwIfAborted(ctx.signal);
            if (laneSignal.aborted) {
              budgetExpired = true;
              break;
            }

            try {
              const result = await apiLane.probe(candidate.name, laneCtx);
              reg = recordProbe(reg, candidate.normalizedKey, apiLane.name, result, now);
            } catch (err) {
              throwIfAborted(ctx.signal);
              if (laneSignal.aborted) {
                budgetExpired = true;
                break;
              }
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

          if (!budgetExpired) {
            const boards = boardsToFetch(reg, apiLane.name);
            for (const { key, boardRef } of boards) {
              throwIfAborted(ctx.signal);
              if (laneSignal.aborted) {
                budgetExpired = true;
                break;
              }

              try {
                const jobs = await apiLane.fetchBoard(boardRef, laneCtx);
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
                throwIfAborted(ctx.signal);
                if (laneSignal.aborted) {
                  budgetExpired = true;
                  break;
                }
                const message = err instanceof Error ? err.message : String(err);
                const soft = isSoftError(err)
                  ? err
                  : new SoftError(`source.fetch.${apiLane.name}`, message, {
                      cause: err,
                    });
                ctx.logger.warn('board fetch failed', {
                  lane: apiLane.name,
                  boardRef,
                  error: soft.message,
                });
                reg = recordFetchFailure(reg, key, apiLane.name, policy);
              }
            }
          }

          if (budgetExpired) {
            ctx.logger.warn('lane exceeded its budget', {
              lane: apiLane.name,
              budgetMs: laneBudgetMs,
            });
          }
        } catch (err) {
          if (ctx.signal.aborted) throw err; // run-level abort: propagate, no registry write
          // Whole-lane outage: never let one lane's total failure stop the others.
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn('api lane failed entirely', {
            lane: apiLane.name,
            error: message,
          });
        } finally {
          clearTimeout(laneBudgetTimer);
        }
      }

      await ctx.storage.writeJson(REGISTRY_PATH, reg);

      return { jobs: [...input.jobs, ...fetchedJobs], dropped: input.dropped };
    },
  };
}

/** Throws the stage's own abort reason if `signal` (the stage's ctx.signal
 * — never a lane's per-budget signal) is already aborted. Used at the top
 * of every loop iteration so an in-flight run cancellation or stage
 * timeout is noticed promptly instead of falling through to a
 * probe/fetch call that would otherwise reject and get misrecorded as a
 * per-company failure. */
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error
    ? reason
    : new Error('source stage aborted', { cause: reason });
}
