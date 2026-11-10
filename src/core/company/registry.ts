import { companyKey } from '../jd/index.ts';
import type { CompanyRecord, ProbeState, RegistryPolicy } from './schema.ts';

/**
 * Company registry — pure state transitions (spec §5, P5). No I/O, no
 * Date.now() — `now` is always an ISO-8601 string passed in by the caller
 * (the source stage, in pipeline/), which is what keeps this module
 * testable and core-pure.
 *
 * core/ may import nothing from ports/ (depcruise 'core-is-pure'). The
 * real `ProbeResult` lives at ports/lane.ts; this is a structurally
 * identical LOCAL type so recordProbe stays free of a ports import. The
 * pipeline-layer source stage (Task 2) bridges ports' ProbeResult into
 * this shape — the two are structurally compatible, so no adapter code
 * is needed at the call site.
 */
export type ProbeResult =
  | { status: 'found'; boardRef: string }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * Record `names` as seen by `lane` at `now`. Existing companies (matched
 * by companyKey) get lastSeen bumped and `lane` added to seenBy (deduped);
 * firstSeen is never touched. Unknown companies are created fresh with an
 * empty probes map. Names that normalize to the same key within a single
 * call are merged into one record (first name wins).
 */
export function upsertSeen(
  reg: CompanyRecord[],
  names: string[],
  lane: string,
  now: string,
): CompanyRecord[] {
  const byKey = new Map(reg.map((r) => [r.normalizedKey, r]));
  const touchedThisCall = new Set<string>();

  for (const name of names) {
    const key = companyKey(name);
    if (touchedThisCall.has(key)) continue; // dedup within this call — first name wins
    touchedThisCall.add(key);

    const existing = byKey.get(key);
    if (existing) {
      const seenBy = existing.seenBy.includes(lane)
        ? existing.seenBy
        : [...existing.seenBy, lane];
      byKey.set(key, { ...existing, lastSeen: now, seenBy });
    } else {
      byKey.set(key, {
        name,
        normalizedKey: key,
        firstSeen: now,
        lastSeen: now,
        seenBy: [lane],
        probes: {},
        curated: false,
      });
    }
  }

  return Array.from(byKey.values());
}

/**
 * Records due for a probe by `apiLane` this run: never probed, a
 * not-found or stale probe past its TTL (spec: re-probe after
 * reprobeNotFoundAfterDays — comparison is strict, so exactly-at-boundary
 * is NOT yet due; a stale board is a dead board parked for a retry, so it
 * shares the not-found clock, measured from when it went stale), or an
 * errored probe still under the failure cap. 'found' probes, and errored
 * probes at/over the cap, are excluded. Curated records follow the
 * identical rules — curation only affects recordFetchFailure's stale
 * behavior, not probe eligibility.
 */
export function probeCandidates(
  reg: CompanyRecord[],
  apiLane: string,
  policy: RegistryPolicy,
  now: string,
): CompanyRecord[] {
  const nowMs = Date.parse(now);
  const ttlMs = policy.reprobeNotFoundAfterDays * 24 * 60 * 60 * 1000;

  return reg.filter((r) => {
    const probe = r.probes[apiLane];
    if (!probe || probe.status === 'unprobed') return true;
    if (probe.status === 'not-found' || probe.status === 'stale') {
      if (!probe.probedAt) return true;
      return nowMs - Date.parse(probe.probedAt) > ttlMs;
    }
    if (probe.status === 'error') {
      return probe.failCount < policy.maxProbeFailures;
    }
    return false; // 'found'
  });
}

/**
 * Applies a probe outcome for the record whose normalizedKey === key.
 * found/not-found reset failCount to 0; error increments the prior
 * failCount — except on a stale (dead-board) record, where an errored
 * re-probe is no evidence either way: it stays stale with probedAt bumped,
 * so the retry comes after the next TTL instead of the record sliding into
 * the permanent errored-at-cap state. No-op (returns `reg` unchanged) if
 * `key` isn't in the registry.
 */
export function recordProbe(
  reg: CompanyRecord[],
  key: string,
  apiLane: string,
  result: ProbeResult,
  now: string,
): CompanyRecord[] {
  if (!reg.some((r) => r.normalizedKey === key)) return reg;

  return reg.map((r) => {
    if (r.normalizedKey !== key) return r;

    const prev = r.probes[apiLane];
    const prevFailCount = prev?.failCount ?? 0;
    let next: ProbeState;
    if (result.status === 'found') {
      next = { status: 'found', boardRef: result.boardRef, probedAt: now, failCount: 0 };
    } else if (result.status === 'not-found') {
      next = { status: 'not-found', probedAt: now, failCount: 0 };
    } else if (prev?.status === 'stale') {
      next = { ...prev, probedAt: now };
    } else {
      next = { status: 'error', probedAt: now, failCount: prevFailCount + 1 };
    }

    return { ...r, probes: { ...r.probes, [apiLane]: next } };
  });
}

/**
 * Boards ready to fetch for `apiLane`: every record whose probe is
 * 'found' with a boardRef. Stale boards are deliberately excluded — they
 * are flagged, not fetched.
 */
export function boardsToFetch(
  reg: CompanyRecord[],
  apiLane: string,
): Array<{ key: string; boardRef: string; curated: boolean }> {
  const out: Array<{ key: string; boardRef: string; curated: boolean }> = [];
  for (const r of reg) {
    const probe = r.probes[apiLane];
    if (probe?.status === 'found' && probe.boardRef) {
      out.push({ key: r.normalizedKey, boardRef: probe.boardRef, curated: r.curated });
    }
  }
  return out;
}

/**
 * A board that fetched fine is not failing: reset its consecutive-failure
 * count. failCount is a CONSECUTIVE counter — without this reset, sporadic
 * blips over months add up and park a healthy board. No-op unless the
 * record's probe for `apiLane` is 'found' with failCount > 0.
 */
export function recordFetchSuccess(
  reg: CompanyRecord[],
  key: string,
  apiLane: string,
): CompanyRecord[] {
  return reg.map((r) => {
    if (r.normalizedKey !== key) return r;
    const prev = r.probes[apiLane];
    if (prev?.status !== 'found' || prev.failCount === 0) return r;
    return { ...r, probes: { ...r.probes, [apiLane]: { ...prev, failCount: 0 } } };
  });
}

/**
 * Records a fetch failure (as opposed to a probe failure) against a
 * previously-found board: increments the consecutive failCount. Once it
 * reaches staleAfterFetchFailures the board moves to 'stale'
 * (boardsToFetch then skips it) and `probedAt` is stamped with `now`, which
 * starts the clock probeCandidates uses to re-probe it — that re-probe is
 * the way back if the board returns.
 *
 * Two kinds of failure. A transient one (default) keeps the original rule:
 * curated records only flag it via failCount and never auto-expire — one
 * 5xx blip must not retire a human-picked board. A `gone` one (the board
 * answered HTTP 404/410 — definitive, not a hiccup) retires curated records
 * too: before this, a curated board that was deleted upstream was fetched
 * and failed on every run forever (no human-facing way to retire it).
 * `now` is required for the stamp when `gone`; without it a stale record is
 * stamped with nothing (probeCandidates then treats it as due at once).
 * No-op if `key`/`apiLane` has no probe state.
 */
export function recordFetchFailure(
  reg: CompanyRecord[],
  key: string,
  apiLane: string,
  policy: RegistryPolicy,
  opts: { gone?: boolean; now?: string } = {},
): CompanyRecord[] {
  return reg.map((r) => {
    if (r.normalizedKey !== key) return r;

    const prev = r.probes[apiLane];
    if (!prev) return r;

    const failCount = prev.failCount + 1;
    const goesStale =
      failCount >= policy.staleAfterFetchFailures && (!r.curated || opts.gone === true);
    const next: ProbeState = goesStale
      ? {
          ...prev,
          failCount,
          status: 'stale',
          ...(opts.now !== undefined && { probedAt: opts.now }),
        }
      : { ...prev, failCount };

    return { ...r, probes: { ...r.probes, [apiLane]: next } };
  });
}
