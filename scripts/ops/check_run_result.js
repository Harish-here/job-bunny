// scripts/ops/check_run_result.js — deterministic PASS/FAIL check for run_scheduled.sh.
// Usage: node scripts/ops/check_run_result.js <profile> <run_start_epoch_seconds>
// Exits 0 (PASS) only if profiles/<profile>/data/last_run_result.json says "success" AND
// its timestamp is at/after the given run-start time (a small clock-skew allowance is
// applied). Exits 1 (FAIL) if the marker is missing, unparseable, stale (left over from an
// earlier run that crashed before this run ever reached mark_run_result.js), or says "failed".
//
// The staleness check matters: without it, a run that crashes hard before reaching the
// marker-writing step (e.g. doctor red, an uncaught exception) would silently reuse
// yesterday's "success" marker and be misreported as passing.

import { readFile } from "node:fs/promises";
import { paths } from "../lib/config.js";

const [profile, startEpochStr] = process.argv.slice(2);
const startEpoch = Number(startEpochStr);
const CLOCK_SKEW_ALLOWANCE_SECONDS = 5;

try {
  const raw = await readFile(paths(profile).lastRunResult, "utf8");
  const result = JSON.parse(raw);
  const resultEpoch = Date.parse(result.timestamp) / 1000;
  const fresh = Number.isFinite(resultEpoch) && resultEpoch >= startEpoch - CLOCK_SKEW_ALLOWANCE_SECONDS;
  process.exit(result.status === "success" && fresh ? 0 : 1);
} catch {
  process.exit(1);
}
