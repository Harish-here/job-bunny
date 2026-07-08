// scripts/check_extract_started.js — heartbeat check for run_scheduled.sh's fail-fast
// watchdog. Usage: node scripts/check_extract_started.js <profile> <run_start_epoch_seconds>
// Exits 0 if profiles/<profile>/data/extract_started.json exists and is fresh (written at/after
// the given run-start time — a small clock-skew allowance is applied). Exits 1 if missing or
// stale (a leftover marker from a prior run whose /extract never got backgrounded/skipped).
//
// This exists to catch, within minutes rather than the full run timeout, the exact failure
// mode where a headless agent backgrounds /extract against run.md's explicit instruction: the
// turn ends immediately, /extract's process (and therefore this marker) never runs at all.

import { readFile } from "node:fs/promises";
import { paths } from "./config.js";

const [profile, startEpochStr] = process.argv.slice(2);
const startEpoch = Number(startEpochStr);
const CLOCK_SKEW_ALLOWANCE_SECONDS = 5;

try {
  const raw = await readFile(paths(profile).extractStarted, "utf8");
  const marker = JSON.parse(raw);
  const markerEpoch = Date.parse(marker.timestamp) / 1000;
  const fresh = Number.isFinite(markerEpoch) && markerEpoch >= startEpoch - CLOCK_SKEW_ALLOWANCE_SECONDS;
  process.exit(fresh ? 0 : 1);
} catch {
  process.exit(1);
}
