// scripts/pipeline/extract/state.js — pure state helpers for the extract pipeline: aggregate
// failure detection (moved verbatim from extract.js), per-URL resume bookkeeping, result
// merging, and heartbeat/progress helpers. No fs here — callers own all file I/O.

// Aggregate "every URL failed" detection — a stale/expired LinkedIn session tends to make
// every single group fail (inventory/assertion errors), not just one flaky selector. Group-
// level skips (pushed before the per-URL loop starts, no `url` key) count ALL of that group's
// URLs as failed; URL-level skips (have a `url` key) count just that one URL. A legitimately
// quiet day with zero cards found (but URLs that loaded fine) must NOT trigger this — that's
// exactly the case the "no url key" vs "has url key" distinction protects against.
// resumed-skipped URLs completed successfully earlier the same day, so they're excluded from
// the all-failed denominator; a rerun where every *attempted* URL fails still alerts.
export function computeAggregateFailure(groups, summary) {
  const totalUrls = groups.reduce((sum, g) => sum + g.urls.length, 0);
  let failedUrls = 0;
  for (const g of groups) {
    const groupLevelSkip = summary.skipped.find((s) => s.page === g.page && !("url" in s));
    if (groupLevelSkip) {
      failedUrls += g.urls.length;
    } else {
      failedUrls += summary.skipped.filter((s) => s.page === g.page && "url" in s).length;
    }
  }
  const resumedSkipped = summary.resumed_skipped || 0;
  const attemptedUrls = totalUrls - resumedSkipped;
  return { totalUrls, failedUrls, allFailed: attemptedUrls > 0 && failedUrls === attemptedUrls };
}

// ---------- resume (data/extract_resume.json) ----------

// Decide whether a loaded resume file should be discarded and a fresh one started. Reset is an
// optimization decision only — never a hard failure — so callers should soft-fail an
// unparseable/missing file into `resume: null` and let this function report "missing".
//
// `discardOutput` tells the caller whether today's already-flushed jobs_raw_text.json/
// companies_seen.json are trustworthy. A genuine day rollover (or no resume to compare a day
// against) means that output belongs to a prior day and must be discarded. Every other reset
// reason (fresh-flag/urls-changed/window-changed/already-complete) only means "don't trust which
// URLs are marked done" — the captures themselves are still today's and must survive a crash
// before this run's first successful URL, not just get silently overwritten. Computed
// independently of `reason`'s priority order below so that fresh-flag-on-a-new-day still
// discards (both are true at once).
//
// `urls` (optional): the full list of this run's URLs (post window-override, same shape the
// per-URL loop in extract.js checks against `isUrlCompleted`). When every one is already in
// `resume.completed`, the prior same-day run reached 100% completion — nothing is left to
// resume. This matters for multi-fire schedules (profile.json `schedule.times`, e.g. 5
// fires/day): without this check, the first fire's success made every later same-day fire
// skip all URLs via `isUrlCompleted` and capture zero new postings, defeating the entire
// point of firing more than once a day. A resume that's only *partially* complete (a
// stall/crash) is untouched — the next slot still continues it, per the existing
// crash-recovery design (see the module header comment in extract.js).
export function shouldResetResume(resume, { today, fresh, searchUrlsHash, windowHours, urls }) {
  const missing = !resume || typeof resume !== "object";
  const staleDay = missing || resume.day !== today;
  if (missing) return { reset: true, reason: "missing", discardOutput: true };
  if (fresh) return { reset: true, reason: "fresh-flag", discardOutput: staleDay };
  if (staleDay) return { reset: true, reason: "new-day", discardOutput: true };
  if (resume.search_urls_hash !== searchUrlsHash) return { reset: true, reason: "urls-changed", discardOutput: false };
  if (String(resume.window_hours ?? 0) !== String(windowHours ?? 0)) {
    return { reset: true, reason: "window-changed", discardOutput: false };
  }
  // urls is optional and MUST default to undefined, never []: `[].every(...)` is vacuously
  // true, which would wrongly fire "already-complete" on every call that omits it.
  if (urls && urls.length > 0 && urls.every((u) => isUrlCompleted(resume, u))) {
    return { reset: true, reason: "already-complete", discardOutput: false };
  }
  return { reset: false, reason: null, discardOutput: false };
}

export function newResume({ today, searchUrlsHash, windowHours }) {
  return { day: today, search_urls_hash: searchUrlsHash, window_hours: windowHours ?? 0, completed: [] };
}

export function isUrlCompleted(resume, url) {
  return resume.completed.some((e) => e.url === url);
}

// Idempotent: marking an already-completed URL done again is a no-op (returns the same
// reference) rather than appending a duplicate entry.
export function markUrlDone(resume, { page, url, finishedAt }) {
  if (isUrlCompleted(resume, url)) return resume;
  return {
    ...resume,
    completed: [...resume.completed, { page, url, finished_at: finishedAt }],
  };
}

// Union of two arrays of extract result records. Key = record.job_id when truthy, else
// record.job_url. The EXISTING entry wins on key collision (resume seeds from what's already
// flushed to disk — never let a re-scrape clobber a completed capture). Records with neither
// job_id nor job_url have no key and can't collide — both sides' copies are kept as-is.
export function mergeResults(existing, incoming) {
  const keyOf = (r) => (r.job_id ? `id:${r.job_id}` : r.job_url ? `url:${r.job_url}` : null);
  const seenKeys = new Set();
  const noKeyExisting = [];
  for (const r of existing) {
    const k = keyOf(r);
    if (k) seenKeys.add(k);
    else noKeyExisting.push(r);
  }
  const merged = [...existing];
  for (const r of incoming) {
    const k = keyOf(r);
    if (!k) {
      merged.push(r); // no key → can't collide, keep from both sides
      continue;
    }
    if (seenKeys.has(k)) continue; // existing wins
    seenKeys.add(k);
    merged.push(r);
  }
  return merged;
}

// ---------- heartbeat / progress (data/extract_progress.json) ----------

export function buildProgress({
  pid,
  runStartedAt,
  stage,
  group = null,
  urlIndex = null,
  urlTotal = null,
  url = null,
  cardsCaptured = 0,
  done = false,
}) {
  return {
    pid,
    run_started_at: runStartedAt,
    updated_at: new Date().toISOString(),
    stage,
    group,
    url_index: urlIndex,
    url_total: urlTotal,
    url,
    cards_captured: cardsCaptured,
    done,
  };
}

// Freshness check used by the stall-detecting watchdog. `started` mirrors the same
// run_started_at-vs-runStartEpochSec skew rule check_extract_started.js applies to
// extract_started.json — a progress file left over from a PRIOR run must not read as "started"
// for the current run.
export function isProgressStale(progress, { nowMs, runStartEpochSec, staleMs, skewSec = 5 }) {
  const isParseableObject = progress && typeof progress === "object";
  const startedAtMs = isParseableObject ? Date.parse(progress.run_started_at) : NaN;
  const started = isParseableObject && startedAtMs / 1000 >= runStartEpochSec - skewSec;
  if (!started) return { started: false, stale: false, reason: "not-started" };
  if (progress.done === true) return { started: true, stale: false, reason: "done" };

  const updatedMs = Date.parse(progress.updated_at);
  if (!Number.isFinite(updatedMs)) return { started: true, stale: true, reason: "unparseable-updated-at" };

  const stale = nowMs - updatedMs > staleMs;
  return { started: true, stale, reason: stale ? "stale" : "fresh" };
}
