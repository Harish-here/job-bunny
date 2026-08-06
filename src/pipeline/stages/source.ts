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
import { type FilterConfig, FilterConfigSchema } from '../../core/filter/config.ts';
import {
  CacheEntrySchema,
  type DroppedRecord,
  type JD,
  JDSchema,
} from '../../core/jd/index.ts';
import type { ApiLane } from '../../ports/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';
import { newGateCounters, runJobGates } from './gates.ts';
import { CACHE_PATH } from './reconcile.ts';

const CacheSchema = z.array(CacheEntrySchema);

/**
 * Per-job "already fetched in a prior run" ledger for the API lanes —
 * job id -> last-seen ISO date. Deliberately a SEPARATE file from
 * `registry/companies.json` (a per-COMPANY ledger, unrelated) and from
 * `registry/companies_seen.json` (the farming-lane side-write of company
 * names this stage upserts into the registry above) — v0 parity name
 * would be ghSeen.json/kekaSeen.json (one per lane); v2 uses one shared
 * file since job ids already carry a lane-specific prefix (`gh-`/`kk-`)
 * and never collide across lanes.
 */
export const API_SEEN_PATH = 'registry/api_seen.json';
const ApiSeenSchema = z.record(z.string(), z.string());

/** v0 parity: GH_MAX_NEW/KEKA_MAX_NEW both default 40 (scripts/pipeline/
 * greenhouse.js, keka.js) — a per-lane backstop cap on how many NEW jobs
 * (post title/avoid-gate, post seen/cache-skip) one run emits from a
 * single api lane. This is a backstop, not the primary mechanism — the
 * title/avoid gate above it is what does the real volume reduction (P9
 * closure register §1); when the cap does fire it must never truncate
 * silently, so every job it drops still gets a DroppedRecord plus one
 * loud warn per lane the first time it fires. */
const DEFAULT_MAX_NEW_PER_LANE = 40;

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
 * probe/fetch failure is a narrow SoftError — ONE lane's whole outage
 * yields zero jobs from that lane plus a warn, never a thrown stage
 * failure (v0 invariant: API lanes are optional breadth). But if EVERY
 * api lane fails entirely, that's not lost breadth, it's a total
 * outage — the stage throws rather than silently reporting a
 * zero-job success (mirrors linkedin/lane.ts's all-urls-failed guard).
 *
 * Notion-cache gate (parity with v0's greenhouse.js/ats_common.js): every
 * fetched job whose id already appears in the reconciled Notion cache
 * (`reconcile.ts`'s CACHE_PATH) is dropped silently at fetch time — no
 * per-job log, no DroppedRecord, just an aggregate skip counter logged once
 * per run. A real run can fetch thousands of already-known jobs from these
 * ATS lanes; without this gate they flood the downstream LLM `structure`
 * stage and blow its timeout. Missing cache (e.g. `jobbunny stage source`
 * run standalone, without a preceding `reconcile`) disables the gate rather
 * than throwing — unlike dedup.ts's cache read, this stage's contract is
 * fail-soft on breadth, and the full pipeline always runs reconcile first.
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
    /** Card-gate config (title/company avoid) applied to every fetched
     * job BEFORE the seen/cache skip and the maxNewPerLane cap — the
     * cheapest check runs first (P9 closure register §1: gate first,
     * measure what survives, cap only as a backstop). Defaults to a
     * permissive empty FilterConfig (no title/company sections ⇒
     * evaluateCard drops nothing) so existing callers/tests that don't
     * pass one see unchanged behavior. */
    filterCfg?: FilterConfig;
    /** Per-lane backstop cap on new jobs emitted this run (v0 parity:
     * GH_MAX_NEW/KEKA_MAX_NEW, both default 40). Applies independently to
     * each api lane. */
    maxNewPerLane?: number;
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
        (await ctx.stateStore.readDoc(REGISTRY_PATH, RegistrySchema)) ?? [];

      const seen =
        (await ctx.stateStore.readDoc(COMPANIES_SEEN_PATH, CompaniesSeenSchema)) ?? {};
      for (const [farmLane, names] of Object.entries(seen)) {
        reg = upsertSeen(reg, names, farmLane, now);
      }

      // Missing-cache policy — deliberate divergence from dedup.ts, which
      // throws on a missing cache. The full pipeline runs reconcile before
      // source, so the cache is always present there; but
      // `jobbunny stage source` can run this stage standalone, and this
      // stage's contract is fail-soft on breadth — a missing cache must not
      // kill a run. So an absent cache just disables the gate (empty set)
      // plus one warn, rather than throwing.
      const cache = await ctx.stateStore.readDoc(CACHE_PATH, CacheSchema);
      if (cache === undefined) {
        ctx.logger.warn(
          'source: no Notion cache found — cache gate disabled, known jobs may reach the LLM stage',
          { path: CACHE_PATH },
        );
      }
      const cacheIds = new Set<string>((cache ?? []).map((c) => c.id).filter(Boolean));

      const apiSeen: Record<string, string> =
        (await ctx.stateStore.readDoc(API_SEEN_PATH, ApiSeenSchema)) ?? {};

      const filterCfg = opts.filterCfg ?? FilterConfigSchema.parse({});
      const maxNewPerLane = opts.maxNewPerLane ?? DEFAULT_MAX_NEW_PER_LANE;

      const fetchedJobs: JD[] = [];
      const laneDrops: DroppedRecord[] = [];
      let probesIssued = 0;
      const gateCounters = newGateCounters();
      let failedLanes = 0;

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
            let emittedThisLane = 0;
            let capLoggedThisLane = false;
            for (const { key, boardRef } of boards) {
              throwIfAborted(ctx.signal);
              if (laneSignal.aborted) {
                budgetExpired = true;
                break;
              }

              try {
                const { jobs, dropped } = await apiLane.fetchBoard(boardRef, laneCtx);
                laneDrops.push(...dropped);
                for (const job of jobs) {
                  const parsed = JDSchema.safeParse(job);
                  if (!parsed.success) {
                    ctx.logger.warn('dropped invalid JD from board fetch', {
                      lane: apiLane.name,
                      boardRef,
                      error: parsed.error.message,
                    });
                    continue;
                  }

                  const { identity } = parsed.data;

                  // Gate order, cheapest first (P9 closure register §1):
                  // title/avoid card gate → seen ledger → Notion cache →
                  // maxNewPerLane backstop — see gates.ts's own doc
                  // comment for the full rationale of each step.
                  const gateOutcome = runJobGates(
                    identity,
                    {
                      filterCfg,
                      apiSeen,
                      cacheIds,
                      emittedThisLane,
                      maxNewPerLane,
                      laneName: apiLane.name,
                    },
                    gateCounters,
                  );
                  if (gateOutcome.kind === 'drop') {
                    laneDrops.push(gateOutcome.dropped);
                    if (
                      gateOutcome.dropped.reasons[0]?.rule === 'source.maxNewCap' &&
                      !capLoggedThisLane
                    ) {
                      capLoggedThisLane = true;
                      ctx.logger.warn(
                        'source: maxNewPerLane cap hit — dropping remainder',
                        { lane: apiLane.name, maxNewPerLane },
                      );
                    }
                    continue;
                  }
                  if (gateOutcome.kind === 'skip') continue;

                  fetchedJobs.push(parsed.data);
                  apiSeen[identity.id] = now;
                  emittedThisLane++;
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
          failedLanes += 1;
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn('api lane failed entirely', {
            lane: apiLane.name,
            error: message,
          });
        } finally {
          clearTimeout(laneBudgetTimer);
        }
      }

      // Every API lane failed: not one broken lane, a total outage — fail
      // loud rather than a silently-green zero-job run (mirrors
      // linkedin/lane.ts's all-urls-failed guard, v0 checkAggregateFailure).
      if (apiLanes.length > 0 && failedLanes === apiLanes.length) {
        throw new Error(
          `source stage: all ${apiLanes.length} api lane(s) failed this run — ` +
            'total outage, not one broken lane',
        );
      }

      await ctx.stateStore.writeDoc(REGISTRY_PATH, reg);
      await ctx.stateStore.writeDoc(API_SEEN_PATH, apiSeen);

      ctx.logger.info('source: gate summary', {
        fetched: fetchedJobs.length,
        cardGateDropped: gateCounters.cardGateDropped,
        apiSeenSkipped: gateCounters.apiSeenSkipped,
        cacheSkipped: gateCounters.cacheSkipped,
        capDropped: gateCounters.capDropped,
      });

      return {
        jobs: [...input.jobs, ...fetchedJobs],
        dropped: [...input.dropped, ...laneDrops],
      };
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
