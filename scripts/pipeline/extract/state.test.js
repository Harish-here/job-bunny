// scripts/pipeline/extract/state.test.js — node:test unit tests for the pure state helpers
// (computeAggregateFailure, resume bookkeeping, mergeResults, progress/heartbeat). No I/O.
// Run with: node --test scripts/pipeline/extract/state.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAggregateFailure,
  shouldResetResume,
  newResume,
  isUrlCompleted,
  markUrlDone,
  mergeResults,
  buildProgress,
  isProgressStale,
} from "./state.js";

// ---------- computeAggregateFailure ----------

test("computeAggregateFailure: all-group-skips → allFailed true", () => {
  const groups = [{ page: "a", urls: [{ url: "u1" }, { url: "u2" }] }];
  const summary = { skipped: [{ page: "a", reason: "boom" }] };
  const r = computeAggregateFailure(groups, summary);
  assert.deepEqual(r, { totalUrls: 2, failedUrls: 2, allFailed: true });
});

test("computeAggregateFailure: url-level skips count individually, no aggregate failure", () => {
  const groups = [{ page: "a", urls: [{ url: "u1" }, { url: "u2" }] }];
  const summary = { skipped: [{ page: "a", url: "u1", reason: "boom" }] };
  const r = computeAggregateFailure(groups, summary);
  assert.deepEqual(r, { totalUrls: 2, failedUrls: 1, allFailed: false });
});

test("computeAggregateFailure: zero skips → allFailed false", () => {
  const groups = [{ page: "a", urls: [{ url: "u1" }] }];
  const summary = { skipped: [] };
  const r = computeAggregateFailure(groups, summary);
  assert.deepEqual(r, { totalUrls: 1, failedUrls: 0, allFailed: false });
});

test("computeAggregateFailure: empty groups → allFailed false (totalUrls 0)", () => {
  const r = computeAggregateFailure([], { skipped: [] });
  assert.deepEqual(r, { totalUrls: 0, failedUrls: 0, allFailed: false });
});

test("computeAggregateFailure: group-level skip counts all of that group's URLs even with unrelated url-level skips in other groups", () => {
  const groups = [
    { page: "a", urls: [{ url: "u1" }, { url: "u2" }] },
    { page: "b", urls: [{ url: "u3" }] },
  ];
  const summary = {
    skipped: [
      { page: "a", reason: "group dead" }, // group-level
      { page: "b", url: "u3", reason: "one-off" }, // url-level, also fails
    ],
  };
  const r = computeAggregateFailure(groups, summary);
  assert.deepEqual(r, { totalUrls: 3, failedUrls: 3, allFailed: true });
});

test("computeAggregateFailure: resume-skipped URLs are excluded from the denominator — all ATTEMPTED URLs failing still alerts", () => {
  const groups = [{ page: "a", urls: [{ url: "u1" }, { url: "u2" }, { url: "u3" }] }];
  const summary = {
    skipped: [
      { page: "a", url: "u2", reason: "boom" },
      { page: "a", url: "u3", reason: "boom" },
    ],
    resumed_skipped: 1, // u1 was already completed earlier today — never attempted this run
  };
  const r = computeAggregateFailure(groups, summary);
  assert.deepEqual(r, { totalUrls: 3, failedUrls: 2, allFailed: true });
});

test("computeAggregateFailure: all URLs resume-skipped, no failures → allFailed false", () => {
  const groups = [{ page: "a", urls: [{ url: "u1" }, { url: "u2" }, { url: "u3" }] }];
  const summary = { skipped: [], resumed_skipped: 3 };
  const r = computeAggregateFailure(groups, summary);
  assert.deepEqual(r, { totalUrls: 3, failedUrls: 0, allFailed: false });
});

// ---------- shouldResetResume ----------

test("shouldResetResume: missing resume discards output — nothing to compare a day against", () => {
  const r = shouldResetResume(null, { today: "2026-07-15", fresh: false, searchUrlsHash: "h", windowHours: 0 });
  assert.deepEqual(r, { reset: true, reason: "missing", discardOutput: true });
});

test("shouldResetResume: non-object resume discards output", () => {
  const r = shouldResetResume("nope", { today: "2026-07-15", fresh: false, searchUrlsHash: "h", windowHours: 0 });
  assert.deepEqual(r, { reset: true, reason: "missing", discardOutput: true });
});

test("shouldResetResume: fresh flag forces reset but keeps today's output — same-day forced rescrape", () => {
  const resume = { day: "2026-07-15", search_urls_hash: "h", window_hours: 0, completed: [] };
  const r = shouldResetResume(resume, { today: "2026-07-15", fresh: true, searchUrlsHash: "h", windowHours: 0 });
  assert.deepEqual(r, { reset: true, reason: "fresh-flag", discardOutput: false });
});

test("shouldResetResume: fresh flag on a new day still discards output — a crash mid-run must not seed from yesterday's file", () => {
  const resume = { day: "2026-07-14", search_urls_hash: "h", window_hours: 0, completed: [] };
  const r = shouldResetResume(resume, { today: "2026-07-15", fresh: true, searchUrlsHash: "h", windowHours: 0 });
  assert.deepEqual(r, { reset: true, reason: "fresh-flag", discardOutput: true });
});

test("shouldResetResume: new day discards output", () => {
  const resume = { day: "2026-07-14", search_urls_hash: "h", window_hours: 0, completed: [] };
  const r = shouldResetResume(resume, { today: "2026-07-15", fresh: false, searchUrlsHash: "h", windowHours: 0 });
  assert.deepEqual(r, { reset: true, reason: "new-day", discardOutput: true });
});

test("shouldResetResume: search_urls hash changed keeps today's output — a same-day rerun must not lose real captures", () => {
  const resume = { day: "2026-07-15", search_urls_hash: "old", window_hours: 0, completed: [] };
  const r = shouldResetResume(resume, { today: "2026-07-15", fresh: false, searchUrlsHash: "new", windowHours: 0 });
  assert.deepEqual(r, { reset: true, reason: "urls-changed", discardOutput: false });
});

test("shouldResetResume: window_hours changed keeps today's output", () => {
  const resume = { day: "2026-07-15", search_urls_hash: "h", window_hours: 0, completed: [] };
  const r = shouldResetResume(resume, { today: "2026-07-15", fresh: false, searchUrlsHash: "h", windowHours: 72 });
  assert.deepEqual(r, { reset: true, reason: "window-changed", discardOutput: false });
});

test("shouldResetResume: everything matches → no reset", () => {
  const resume = { day: "2026-07-15", search_urls_hash: "h", window_hours: 72, completed: [] };
  const r = shouldResetResume(resume, { today: "2026-07-15", fresh: false, searchUrlsHash: "h", windowHours: 72 });
  assert.deepEqual(r, { reset: false, reason: null, discardOutput: false });
});

test("shouldResetResume: window_hours compares loosely (0 vs undefined both stringify to '0')", () => {
  const resume = { day: "2026-07-15", search_urls_hash: "h", window_hours: 0, completed: [] };
  const r = shouldResetResume(resume, { today: "2026-07-15", fresh: false, searchUrlsHash: "h", windowHours: undefined });
  assert.deepEqual(r, { reset: false, reason: null, discardOutput: false });
});

test("shouldResetResume: every URL already completed → reset so a later same-day slot rescans for new postings", () => {
  const resume = {
    day: "2026-07-15",
    search_urls_hash: "h",
    window_hours: 0,
    completed: [
      { page: "p", url: "u1", finished_at: "2026-07-15T09:00:00.000Z" },
      { page: "p", url: "u2", finished_at: "2026-07-15T09:01:00.000Z" },
    ],
  };
  const r = shouldResetResume(resume, {
    today: "2026-07-15",
    fresh: false,
    searchUrlsHash: "h",
    windowHours: 0,
    urls: ["u1", "u2"],
  });
  assert.deepEqual(r, { reset: true, reason: "already-complete", discardOutput: false });
});

test("shouldResetResume: only some URLs completed → no reset (crash/stall-resume continuation is preserved)", () => {
  const resume = {
    day: "2026-07-15",
    search_urls_hash: "h",
    window_hours: 0,
    completed: [{ page: "p", url: "u1", finished_at: "2026-07-15T09:00:00.000Z" }],
  };
  const r = shouldResetResume(resume, {
    today: "2026-07-15",
    fresh: false,
    searchUrlsHash: "h",
    windowHours: 0,
    urls: ["u1", "u2"],
  });
  assert.deepEqual(r, { reset: false, reason: null, discardOutput: false });
});

test("shouldResetResume: omitting urls never triggers already-complete, even if completed looks full", () => {
  const resume = {
    day: "2026-07-15",
    search_urls_hash: "h",
    window_hours: 0,
    completed: [{ page: "p", url: "u1", finished_at: "2026-07-15T09:00:00.000Z" }],
  };
  const r = shouldResetResume(resume, { today: "2026-07-15", fresh: false, searchUrlsHash: "h", windowHours: 0 });
  assert.deepEqual(r, { reset: false, reason: null, discardOutput: false });
});

// ---------- newResume / isUrlCompleted / markUrlDone ----------

test("newResume builds a fresh empty-completed resume", () => {
  const r = newResume({ today: "2026-07-15", searchUrlsHash: "h", windowHours: 72 });
  assert.deepEqual(r, { day: "2026-07-15", search_urls_hash: "h", window_hours: 72, completed: [] });
});

test("newResume defaults window_hours to 0 when omitted", () => {
  const r = newResume({ today: "2026-07-15", searchUrlsHash: "h" });
  assert.equal(r.window_hours, 0);
});

test("markUrlDone appends a new entry and does not mutate the input resume", () => {
  const resume = newResume({ today: "2026-07-15", searchUrlsHash: "h", windowHours: 0 });
  const next = markUrlDone(resume, { page: "jobs-search", url: "https://x/1", finishedAt: "t1" });
  assert.equal(resume.completed.length, 0); // input untouched
  assert.equal(next.completed.length, 1);
  assert.deepEqual(next.completed[0], { page: "jobs-search", url: "https://x/1", finished_at: "t1" });
  assert.equal(isUrlCompleted(next, "https://x/1"), true);
  assert.equal(isUrlCompleted(next, "https://x/2"), false);
});

test("markUrlDone is idempotent — marking an already-completed URL returns the same reference unchanged", () => {
  let resume = newResume({ today: "2026-07-15", searchUrlsHash: "h", windowHours: 0 });
  resume = markUrlDone(resume, { page: "jobs-search", url: "https://x/1", finishedAt: "t1" });
  const again = markUrlDone(resume, { page: "jobs-search", url: "https://x/1", finishedAt: "t2" });
  assert.equal(again, resume); // same reference — no-op
  assert.equal(again.completed.length, 1);
  assert.equal(again.completed[0].finished_at, "t1"); // not overwritten
});

// ---------- mergeResults ----------

test("mergeResults: job_id collision — existing wins", () => {
  const existing = [{ job_id: "1", raw_text: "old" }];
  const incoming = [{ job_id: "1", raw_text: "new" }];
  const merged = mergeResults(existing, incoming);
  assert.deepEqual(merged, [{ job_id: "1", raw_text: "old" }]);
});

test("mergeResults: falls back to job_url as key when job_id is falsy", () => {
  const existing = [{ job_id: null, job_url: "https://x/1", raw_text: "old" }];
  const incoming = [{ job_id: null, job_url: "https://x/1", raw_text: "new" }];
  const merged = mergeResults(existing, incoming);
  assert.deepEqual(merged, [{ job_id: null, job_url: "https://x/1", raw_text: "old" }]);
});

test("mergeResults: records with neither job_id nor job_url are kept from both sides", () => {
  const existing = [{ raw_text: "e1" }];
  const incoming = [{ raw_text: "i1" }];
  const merged = mergeResults(existing, incoming);
  assert.deepEqual(merged, [{ raw_text: "e1" }, { raw_text: "i1" }]);
});

test("mergeResults: order is existing-first then new-keyed incoming", () => {
  const existing = [{ job_id: "1" }, { job_id: "2" }];
  const incoming = [{ job_id: "2" }, { job_id: "3" }];
  const merged = mergeResults(existing, incoming);
  assert.deepEqual(merged.map((r) => r.job_id), ["1", "2", "3"]);
});

// ---------- isProgressStale ----------

const ISO = (epochSec) => new Date(epochSec * 1000).toISOString();

test("isProgressStale: not-started — progress carries an older run's run_started_at", () => {
  const runStartEpochSec = 1000;
  const progress = { run_started_at: ISO(500), updated_at: ISO(900), done: false };
  const r = isProgressStale(progress, { nowMs: 950000, runStartEpochSec, staleMs: 60000 });
  assert.deepEqual(r, { started: false, stale: false, reason: "not-started" });
});

test("isProgressStale: done → never stale", () => {
  const runStartEpochSec = 1000;
  const progress = { run_started_at: ISO(1000), updated_at: ISO(1001), done: true };
  const r = isProgressStale(progress, { nowMs: 999999000, runStartEpochSec, staleMs: 60000 });
  assert.deepEqual(r, { started: true, stale: false, reason: "done" });
});

test("isProgressStale: fresh — updated recently", () => {
  const runStartEpochSec = 1000;
  const progress = { run_started_at: ISO(1000), updated_at: ISO(1050), done: false };
  const r = isProgressStale(progress, { nowMs: 1060000, runStartEpochSec, staleMs: 60000 });
  assert.deepEqual(r, { started: true, stale: false, reason: "fresh" });
});

test("isProgressStale: stale — updated_at too far in the past", () => {
  const runStartEpochSec = 1000;
  const progress = { run_started_at: ISO(1000), updated_at: ISO(1050), done: false };
  const r = isProgressStale(progress, { nowMs: 1200000, runStartEpochSec, staleMs: 60000 });
  assert.deepEqual(r, { started: true, stale: true, reason: "stale" });
});

test("isProgressStale: unparseable updated_at treated as stale", () => {
  const runStartEpochSec = 1000;
  const progress = { run_started_at: ISO(1000), updated_at: "not-a-date", done: false };
  const r = isProgressStale(progress, { nowMs: 1060000, runStartEpochSec, staleMs: 60000 });
  assert.deepEqual(r, { started: true, stale: true, reason: "unparseable-updated-at" });
});

test("isProgressStale: skew boundary — run_started_at exactly skewSec before runStartEpochSec still counts as started", () => {
  const runStartEpochSec = 1000;
  const skewSec = 5;
  const progress = { run_started_at: ISO(995), updated_at: ISO(1050), done: false };
  const r = isProgressStale(progress, { nowMs: 1060000, runStartEpochSec, staleMs: 60000, skewSec });
  assert.equal(r.started, true);
});

// ---------- buildProgress ----------

test("buildProgress sets updated_at and passes through fields", () => {
  const p = buildProgress({
    pid: 123,
    runStartedAt: "2026-07-15T00:00:00.000Z",
    stage: "jd-capture",
    group: "jobs-search",
    urlIndex: 2,
    urlTotal: 5,
    url: "https://x/1",
    cardsCaptured: 17,
    done: false,
  });
  assert.equal(p.pid, 123);
  assert.equal(p.run_started_at, "2026-07-15T00:00:00.000Z");
  assert.equal(p.stage, "jd-capture");
  assert.equal(p.group, "jobs-search");
  assert.equal(p.url_index, 2);
  assert.equal(p.url_total, 5);
  assert.equal(p.url, "https://x/1");
  assert.equal(p.cards_captured, 17);
  assert.equal(p.done, false);
  assert.ok(Number.isFinite(Date.parse(p.updated_at)));
});
