import type { FilterConfig } from '../../core/filter/config.ts';
import { decide, evaluateCard } from '../../core/filter/engine.ts';
import { type DroppedRecord, type JD, JDSchema } from '../../core/jd/index.ts';

/**
 * pipeline/stages/gates.ts — the per-job 4-gate chain applied to every job
 * fetched by an API lane in `source.ts` (split out, task 5 of the
 * 2026-07-28 file-size split plan), cheapest first (P9 closure register
 * §1): title/avoid card gate → seen ledger → Notion cache → maxNewPerLane
 * backstop cap. `runJobGates` mutates the shared `GateCounters` instance
 * in place so `source.ts`'s post-run "gate summary" log — aggregated
 * across every lane in the run, not per-lane — stays accurate without
 * threading four separate accumulator variables through every call site.
 */

export interface GateCounters {
  cardGateDropped: number;
  apiSeenSkipped: number;
  cacheSkipped: number;
  capDropped: number;
}

export function newGateCounters(): GateCounters {
  return { cardGateDropped: 0, apiSeenSkipped: 0, cacheSkipped: 0, capDropped: 0 };
}

export interface GateOpts {
  filterCfg: FilterConfig;
  /** Per-lane "already fetched in a prior run" ledger — mutated by the
   * caller on an 'emit' outcome, only read here. */
  apiSeen: Readonly<Record<string, string>>;
  cacheIds: ReadonlySet<string>;
  /** How many jobs this lane has already emitted this run — read only;
   * the caller increments its own counter on 'emit'. */
  emittedThisLane: number;
  maxNewPerLane: number;
  laneName: string;
}

export type GateOutcome =
  | { kind: 'drop'; dropped: DroppedRecord }
  | { kind: 'skip' }
  | { kind: 'emit' };

/** Runs one fetched job's `identity` through the 4-gate chain, mutating
 * `counters` in place. The caller is responsible for the emit-side
 * effects (pushing to `fetchedJobs`, recording `apiSeen`, incrementing its
 * own `emittedThisLane`) and for the maxNewPerLane cap's once-per-lane log
 * line — this function only decides and counts. */
export function runJobGates(
  identity: JD['identity'],
  opts: GateOpts,
  counters: GateCounters,
): GateOutcome {
  // 1. title/avoid card gate — pure computation, no lookup at all, and
  // the workhorse that actually cuts volume before this job can ever
  // reach the LLM `structure` stage.
  const verdicts = evaluateCard(
    { title: identity.title, company: identity.company },
    opts.filterCfg,
  );
  if (decide(verdicts) === 'drop') {
    counters.cardGateDropped++;
    return {
      kind: 'drop',
      dropped: { jd: JDSchema.parse({ identity }), reasons: verdicts },
    };
  }

  // 2. seen ledger — this exact job id was already emitted by this lane
  // in a prior run; skip without a DroppedRecord (same posture as the
  // cache gate below — it was never freshly judged this run).
  if (Object.hasOwn(opts.apiSeen, identity.id)) {
    counters.apiSeenSkipped++;
    return { kind: 'skip' };
  }

  // 3. cache gate — already known to Notion. Cache hit: this job was
  // never a candidate that got judged, so unlike a real drop it gets no
  // DroppedRecord (which carries the full `jd` payload — retaining
  // ~3000 of them is exactly the bloat this gate exists to remove) and
  // no per-job log, only the aggregate counter.
  if (opts.cacheIds.has(identity.id)) {
    counters.cacheSkipped++;
    return { kind: 'skip' };
  }

  // 4. maxNewPerLane backstop — fires only once title/avoid + seen +
  // cache have already done the real work. Never a silent truncation:
  // every job the cap drops still gets a DroppedRecord, and the cap
  // firing itself is logged once per lane (by the caller).
  if (opts.emittedThisLane >= opts.maxNewPerLane) {
    counters.capDropped++;
    return {
      kind: 'drop',
      dropped: {
        jd: JDSchema.parse({ identity }),
        reasons: [
          {
            rule: 'source.maxNewCap',
            severity: 'hard',
            pass: false,
            detail: `maxNewPerLane=${opts.maxNewPerLane} reached for lane "${opts.laneName}"`,
          },
        ],
      },
    };
  }

  return { kind: 'emit' };
}
