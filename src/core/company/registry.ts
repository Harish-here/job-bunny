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
 * not-found probe past its TTL (spec: re-probe after
 * reprobeNotFoundAfterDays — comparison is strict, so exactly-at-boundary
 * is NOT yet due), or an errored probe still under the failure cap.
 * 'found' and 'stale' probes, and errored probes at/over the cap, are
 * excluded. Curated records follow the identical rules — curation only
 * affects recordFetchFailure's stale behavior, not probe eligibility.
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
    if (probe.status === 'not-found') {
      if (!probe.probedAt) return true;
      return nowMs - Date.parse(probe.probedAt) > ttlMs;
    }
    if (probe.status === 'error') {
      return probe.failCount < policy.maxProbeFailures;
    }
    return false; // 'found' or 'stale'
  });
}

/**
 * Applies a probe outcome for the record whose normalizedKey === key.
 * found/not-found reset failCount to 0; error increments the prior
 * failCount. No-op (returns `reg` unchanged) if `key` isn't in the
 * registry.
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

    const prevFailCount = r.probes[apiLane]?.failCount ?? 0;
    let next: ProbeState;
    if (result.status === 'found') {
      next = { status: 'found', boardRef: result.boardRef, probedAt: now, failCount: 0 };
    } else if (result.status === 'not-found') {
      next = { status: 'not-found', probedAt: now, failCount: 0 };
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
 * Records a fetch failure (as opposed to a probe failure) against a
 * previously-found board: increments failCount. Non-curated records move
 * to 'stale' once failCount reaches staleAfterFetchFailures (boardsToFetch
 * then skips them). Curated records flag the failure via failCount but
 * never auto-expire to 'stale' — a human curated the board reference, so
 * only a human retires it. No-op if `key`/`apiLane` has no probe state.
 */
export function recordFetchFailure(
  reg: CompanyRecord[],
  key: string,
  apiLane: string,
  policy: RegistryPolicy,
): CompanyRecord[] {
  return reg.map((r) => {
    if (r.normalizedKey !== key) return r;

    const prev = r.probes[apiLane];
    if (!prev) return r;

    const failCount = prev.failCount + 1;
    const status: ProbeState['status'] =
      !r.curated && failCount >= policy.staleAfterFetchFailures ? 'stale' : prev.status;

    return { ...r, probes: { ...r.probes, [apiLane]: { ...prev, failCount, status } } };
  });
}
