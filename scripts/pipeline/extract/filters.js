// scripts/pipeline/extract/filters.js — pure pre-JD card filter pipeline. Applies, in order,
// the avoid-list drop, cache-skip, run-dedup, and title-filter gates, plus the CARD_CAP slice.
// The avoid/title drop decisions are delegated to the shared filter engine (jd_filter.js)'s
// evaluate(), scoped via `only` to just the one rule each gate needs — this keeps both gates in
// sync with the engine used everywhere else (filter.js, the ATS lanes) without collapsing their
// distinct pipeline positions (a companiesSeen capture step sits between them). Log lines are
// injected (not console.log directly) so the pipeline is unit-testable.

import { evaluate } from "../jd_filter.js";

// Applies a predicate, logs the drop count via msgFn(n), and accumulates into summary[summaryKey].
export function stageFilter(cards, pred, msgFn, summaryKey, summary, log = console.log) {
  const before = cards.length;
  const out = cards.filter(pred);
  const n = before - out.length;
  if (summaryKey) summary[summaryKey] += n;
  if (n) log(msgFn(n));
  return out;
}

// Applies, in this exact order, the pre-JD card gates (mirrors extract.js main()):
//   1. avoid-drop     — drop cards whose company is on the avoid list (engine, only:['avoid'])
//   2. companiesSeen capture — BEFORE the cache/title gates: a title-dropped company is still
//      Greenhouse-probe-worthy, so it must be captured ahead of those filters, not after them.
//   3. cache-skip     — drop cards whose job_id is already known (Notion cache)
//   4. run-dedup      — drop cards whose job_id was already captured earlier this run
//   5. title-filter   — drop cards whose title doesn't pass the engine (only:['title'])
//   6. CARD_CAP slice — applied last, after all filters, so it caps genuinely-new candidates
export function applyCardGates(
  cards,
  { ctx, cachedIds, seenIds, cardCap = 0, debug = false, summary, companiesSeen, log = console.log }
) {
  cards = stageFilter(
    cards,
    (c) => !evaluate({ company: c.company }, ctx, { severity: "lenient", only: ["avoid"] }).drop,
    (n) => `Stage A: dropped ${n} avoid-list card(s) pre-JD`,
    "avoided",
    summary,
    log
  );

  for (const c of cards) if (c.company) companiesSeen.add(c.company.trim());

  cards = stageFilter(
    cards,
    (c) => !c.job_id || !cachedIds.has(c.job_id),
    (n) => `cache: skipped ${n} already-known card(s)`,
    "cache_skipped",
    summary,
    log
  );

  cards = stageFilter(
    cards,
    (c) => {
      if (!c.job_id) return true;
      if (seenIds.has(c.job_id)) return false;
      seenIds.add(c.job_id);
      return true;
    },
    (n) => `run-dedup: dropped ${n} duplicate card(s) (already captured from an earlier search URL this run)`,
    "run_deduped",
    summary,
    log
  );

  cards = stageFilter(
    cards,
    (c) => {
      const result = evaluate({ title: c.title }, ctx, { severity: "lenient", only: ["title"] });
      if (result.drop && debug) log(`[title-filter] DROP — ${result.reasons.join(", ")} — ${c.title}`);
      return !result.drop;
    },
    (n) => `title-filter: dropped ${n} card(s) pre-JD`,
    "title_dropped",
    summary,
    log
  );

  // Cap applied after all pre-filters so it limits genuinely-new JD-fetch candidates.
  if (cardCap > 0 && cards.length > cardCap) cards = cards.slice(0, cardCap);

  return cards;
}
