// src/core/dedup/dedup.ts — pure dedup core: drop jobs already tracked in
// Notion (via the reconciled cache) and collapse intra-run duplicates.
// Ports v0's scripts/pipeline/dedup.js (dedupJobs/dedupKey/repostKey/
// stripPrincipalFromTitle) — see fixtures/replay.json + replay.test.ts for
// the ground truth this was checked against (v0's dedupJobs run directly on
// equivalent input).
//
// Inputs: `jobs` (a run's StructuredJD/EvaluatedJD batch, in extraction
// order) and `cache` (the reconciled Notion mirror, CacheEntry[] — no
// filesystem/network access, both are plain in-memory values).
// Output: DedupResult — `jobs` holds the survivors in original order,
// `dropped` holds one DroppedRecord per job dropped by any rule below, with
// enough `detail` on its Verdict to explain the drop from a checkpoint.
// (DedupResult is structurally identical to pipeline/runner/stage.ts's
// StagePayload — { jobs: JD[]; dropped: DroppedRecord[] } — but declared
// locally, built purely from core/jd primitives, so core-dedup never
// imports the pipeline layer; the dedup StageDef wrapper consumes this
// where a StagePayload is expected.)
//
// Invariants:
//   - ZERO I/O — no fs/network imports, safe to unit test without fixtures.
//   - Never mutates an input `job` or `cache` entry; a dropped duplicate that
//     needs `evaluation.duplicateOf` set gets a shallow-cloned copy instead.
//   - Only KEPT jobs extend the in-run lookup indexes — mirrors v0's
//     `seen`/`seenReposts` sets, which are only ever added to on a keep, so a
//     third repost of the same run always resolves to the first kept
//     occurrence, never to an already-dropped one.
//
// Rule design notes (see also NOTES in the handoff for this task):
//   - `dedup.id`: identity.id equals a CacheEntry.id (or an earlier kept
//     job's id, for the intra-run case) — direct port of v0's primary
//     dedupKey path.
//   - `dedup.repost`: title+company match a tracked job (cache or in-run)
//     under a *different* id, using a light (case/whitespace-only)
//     normalization — the closest available port of v0's repostKey. v0's
//     repostKey additionally required matching location_city: when BOTH the
//     incoming job and the matched origin carry a derivable city (JD
//     structured.locations[0].city / CacheEntry.city), a city mismatch
//     disqualifies the match (same title+company in a different city is a
//     distinct opening, not a repost) — same normalization as v0's
//     repostKey. When either side has no derivable city, this falls back to
//     the title+company-only match (unchanged from before this amendment).
//   - `dedup.role-company`: same title+company match but only found after
//     aggressive normalization (legal-suffix + token folding). Carries the
//     same city-conflict guard as `dedup.repost` above (see NOTES) — without
//     it, a same-title+company-but-different-city job the exact tier
//     correctly let through would still get caught here whenever the names
//     are already identical (its fuzzy key equals its exact key in that
//     case), silently reintroducing the bug the amendment fixes. v0's
//     dedupKey-fallback (its literal ancestor) is only reachable when the
//     incoming job itself has no derivable job_id, which cannot happen for a
//     v2 JD (`identity.id` is required non-empty) — so this rule is a
//     deliberate v2 generalization: a fuzzier catch-all fallback beneath
//     `dedup.repost`'s stricter match, not a literal v0 replay case.
import type { CacheEntry, DroppedRecord, JD, Verdict } from '../jd/index.ts';
import { companyKey, normalizeToken } from '../jd/normalize.ts';

/** Result of a dedup pass — structurally identical to pipeline/runner/
 * stage.ts's StagePayload ({ jobs: JD[]; dropped: DroppedRecord[] }), but
 * declared here (built purely from core/jd primitives) so this module never
 * imports the pipeline layer (core-is-pure). Keep the member names exactly
 * `jobs`/`dropped` so the pipeline-side dedup StageDef wrapper can consume
 * this where a StagePayload is expected with no adapter code. */
export interface DedupResult {
  jobs: JD[];
  dropped: DroppedRecord[];
}

/** Strip the standalone word "Principal" from a title, collapse whitespace,
 * trim dangling punctuation — ports v0's stripPrincipalFromTitle exactly
 * (applied there before every key comparison, so "Principal" variance never
 * causes two listings of the same role to look distinct). */
export function stripPrincipal(title: string): string {
  return title
    .replace(/\bprincipal\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,\-|]+|[\s,\-|]+$/g, '')
    .trim();
}

/** Light normalization (case/whitespace only) for the `dedup.repost` match —
 * the closest available port of v0's repostKey now that city can't be
 * compared (see file header). */
function exactKey(title: string, company: string): string {
  const t = stripPrincipal(title).toLowerCase().replace(/\s+/g, ' ').trim();
  const c = company.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${t}::${c}`;
}

/** Aggressive normalization (legal-suffix + token folding, reusing the same
 * helpers as core/filter and core/company) for the `dedup.role-company`
 * fallback match. */
function fuzzyKey(title: string, company: string): string {
  return `${normalizeToken(stripPrincipal(title))}::${companyKey(company)}`;
}

type Rule = 'dedup.id' | 'dedup.repost' | 'dedup.role-company';

type Origin = { source: 'cache'; entry: CacheEntry } | { source: 'run'; jd: JD };

/** The derivable city for a job/origin — first `structured.locations`
 * entry's city for a JD (a job may list several; the first is treated as
 * "the" city, same simplification v0's single `location_city` string made
 * moot), or `CacheEntry.city` directly. Undefined when not derivable. */
function cityOfJob(job: JD): string | undefined {
  return job.structured?.locations[0]?.city;
}

function cityOfOrigin(origin: Origin): string | undefined {
  return origin.source === 'cache' ? origin.entry.city : cityOfJob(origin.jd);
}

function normalizeCity(city: string): string {
  return city.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True only when BOTH sides have a derivable city and they differ
 * (case/whitespace-insensitive) — the amendment's guard against collapsing
 * two genuinely different (same title+company, different city) jobs into
 * one. Either side missing a city means "can't tell" and falls back to the
 * existing title+company-only match (returns false — not a conflict). */
function citiesConflict(job: JD, origin: Origin): boolean {
  const jobCity = cityOfJob(job);
  const originCity = cityOfOrigin(origin);
  if (!jobCity || !originCity) return false;
  return normalizeCity(jobCity) !== normalizeCity(originCity);
}

function describeMatch(rule: Rule, origin: Origin): string {
  const label =
    rule === 'dedup.id'
      ? 'same id as'
      : rule === 'dedup.repost'
        ? 'repost of (title+company match, different id)'
        : 'role/company fallback match with';
  if (origin.source === 'cache') {
    const { entry } = origin;
    return `${label} cached row ${entry.company} — ${entry.title} (pageId ${entry.pageId}, id ${entry.id || '<none>'})`;
  }
  const { jd } = origin;
  return `${label} earlier job in this run: ${jd.identity.company} — ${jd.identity.title} (id ${jd.identity.id})`;
}

/** Drop `jobs` already tracked in `cache`, then collapse intra-run
 * duplicates (first occurrence wins; later ones are dropped with
 * `evaluation.duplicateOf` set to the first occurrence's id) — see file
 * header for the three cache rules and how the intra-run case reuses them. */
export function dedupe(jobs: JD[], cache: CacheEntry[]): DedupResult {
  const idIndex = new Map<string, Origin>();
  const exactIndex = new Map<string, Origin>();
  const fuzzyIndex = new Map<string, Origin>();

  for (const entry of cache) {
    if (entry.id) idIndex.set(entry.id, { source: 'cache', entry });
    exactIndex.set(exactKey(entry.title, entry.company), { source: 'cache', entry });
    fuzzyIndex.set(fuzzyKey(entry.title, entry.company), { source: 'cache', entry });
  }

  const kept: JD[] = [];
  const dropped: DroppedRecord[] = [];

  for (const job of jobs) {
    const { id, title, company } = job.identity;
    const eKey = exactKey(title, company);
    const fKey = fuzzyKey(title, company);

    const idMatch = idIndex.get(id);
    const exactCandidate = idMatch ? undefined : exactIndex.get(eKey);
    // A same-title+company candidate whose city (when both sides have one)
    // differs from this job's is not a repost — fall through as if no
    // exact match were found.
    const exactMatch =
      exactCandidate && citiesConflict(job, exactCandidate) ? undefined : exactCandidate;
    const fuzzyCandidate = idMatch || exactMatch ? undefined : fuzzyIndex.get(fKey);
    // Same city guard applied to the fuzzy fallback: without it, a
    // same-title+company-but-different-city job that the exact tier
    // correctly refused to match would still get caught here (its
    // aggressively-normalized key is identical when the names are already
    // identical), silently defeating the guard above for the most common
    // case. `dedup.role-company`'s own match criterion (legal-suffix/token
    // folding) is otherwise unchanged.
    const fuzzyMatch =
      fuzzyCandidate && citiesConflict(job, fuzzyCandidate) ? undefined : fuzzyCandidate;

    const found: { rule: Rule; origin: Origin } | undefined = idMatch
      ? { rule: 'dedup.id', origin: idMatch }
      : exactMatch
        ? { rule: 'dedup.repost', origin: exactMatch }
        : fuzzyMatch
          ? { rule: 'dedup.role-company', origin: fuzzyMatch }
          : undefined;

    if (found) {
      const verdict: Verdict = {
        rule: found.rule,
        severity: 'hard',
        pass: false,
        detail: describeMatch(found.rule, found.origin),
      };
      const jd: JD =
        found.origin.source === 'run'
          ? {
              ...job,
              evaluation: {
                verdicts: [...(job.evaluation?.verdicts ?? []), verdict],
                matchReasons: job.evaluation?.matchReasons ?? [],
                ...(job.evaluation?.score !== undefined
                  ? { score: job.evaluation.score }
                  : {}),
                ...(job.evaluation?.excitement !== undefined
                  ? { excitement: job.evaluation.excitement }
                  : {}),
                duplicateOf: found.origin.jd.identity.id,
              },
            }
          : job;
      dropped.push({ jd, reasons: [verdict] });
      continue;
    }

    kept.push(job);
    idIndex.set(id, { source: 'run', jd: job });
    exactIndex.set(eKey, { source: 'run', jd: job });
    fuzzyIndex.set(fKey, { source: 'run', jd: job });
  }

  return { jobs: kept, dropped };
}
