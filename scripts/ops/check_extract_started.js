// scripts/ops/check_extract_started.js — heartbeat/stall check for run_scheduled.sh's watchdog.
//
// Usage:
//   node scripts/ops/check_extract_started.js <profile> <run_start_epoch_seconds>
//   node scripts/ops/check_extract_started.js <profile> <run_start_epoch_seconds> <stale_after_seconds>
//
// 2-ARG MODE (backward compatible, byte-identical behavior to the pre-stall-detection version):
// Exits 0 if profiles/<profile>/data/extract_started.json exists and is fresh (written at/after
// the given run-start time — a small clock-skew allowance is applied). Exits 1 if missing or
// stale (a leftover marker from a prior run whose /extract never got backgrounded/skipped).
//
// This exists to catch, within minutes rather than the full run timeout, the exact failure
// mode where a headless agent backgrounds /extract against run.md's explicit instruction: the
// turn ends immediately, /extract's process (and therefore this marker) never runs at all.
//
// 3-ARG MODE (stale_after_seconds present and > 0) additionally detects a MID-RUN STALL — a
// run that started fine but has stopped making progress (e.g. a hung page load). Exit codes:
//   0 = healthy
//   1 = never-started (same check as 2-arg mode)
//   2 = started, but its progress file has gone stale
//
// It first applies the exact same extract_started.json freshness check as 2-arg mode; a
// failure there exits 1, same as always. Only once that passes does it look at
// data/extract_progress.json (written by extract.js at every checkpoint — see
// scripts/pipeline/extract/state.js's isProgressStale).
//
// Grace fallback #1 — progress file missing or unparseable (e.g. truncated by a SIGKILL
// mid-write): treated as "no progress data yet" and reported healthy (exit 0). A fresh
// started-marker with no progress file yet must NOT kill a good run — this covers the brief
// window between extract_started.json being written and the first progress checkpoint, as
// well as any partial-deploy state where an older extract.js hasn't been updated to write
// progress at all yet.
//
// Grace fallback #2 — a progress file that isn't from THIS run (isProgressStale's `started:
// false`, i.e. its run_started_at predates run_start_epoch): also reported healthy. The
// started-marker check above already proved the run began; a stale LEFTOVER progress file
// from a prior run must not be used to kill the current one.
//
// A finished run's final checkpoint sets done:true, which isProgressStale always reports as
// not-stale — a completed extract keeps polling healthy until the parent process actually exits.

import { readFile } from "node:fs/promises";
import { paths } from "../lib/config.js";
import { isProgressStale } from "../pipeline/extract/state.js";

const [profile, startEpochStr, staleAfterSecondsStr] = process.argv.slice(2);
const startEpoch = Number(startEpochStr);
const CLOCK_SKEW_ALLOWANCE_SECONDS = 5;
const staleAfterSeconds = Number(staleAfterSecondsStr);
const threeArgMode = Number.isFinite(staleAfterSeconds) && staleAfterSeconds > 0;

async function startedFresh() {
  try {
    const raw = await readFile(paths(profile).extractStarted, "utf8");
    const marker = JSON.parse(raw);
    const markerEpoch = Date.parse(marker.timestamp) / 1000;
    return Number.isFinite(markerEpoch) && markerEpoch >= startEpoch - CLOCK_SKEW_ALLOWANCE_SECONDS;
  } catch {
    return false;
  }
}

const fresh = await startedFresh();

if (!threeArgMode) {
  process.exit(fresh ? 0 : 1);
}

if (!fresh) process.exit(1);

let progress;
try {
  const raw = await readFile(paths(profile).extractProgress, "utf8");
  progress = JSON.parse(raw);
} catch {
  // Missing or unparseable — grace fallback #1, see header comment.
  process.exit(0);
}

const { started, stale } = isProgressStale(progress, {
  nowMs: Date.now(),
  runStartEpochSec: startEpoch,
  staleMs: staleAfterSeconds * 1000,
});

// Grace fallback #2: leftover progress from a prior run doesn't count against this one.
if (!started) process.exit(0);

process.exit(stale ? 2 : 0);
