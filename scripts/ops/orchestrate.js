// scripts/ops/orchestrate.js — the headless pipeline runner. A single node process that spawns
// each existing pipeline stage as a FOREGROUND child, and owns the watchdog + retry +
// failure-capture. Same code path for headless (run_scheduled.sh) and interactive (/run).
// Replaces the old `claude -p "/run <profile>"` single-shot, which auto-backgrounded the
// ~10-min extract stage and truncated the run.
//
// Extract owns Chrome entirely (it launches Chrome detached and kills it on every exit path),
// so orchestrate NEVER launches or kills Chrome; killing extract with SIGTERM makes extract tear
// down Chrome and exit 143. Stages are spawned NON-detached and killed by single pid, so the
// run_scheduled.sh coarse backstop (process-group kill of orchestrate) still reaches them.
//
// Testing division mirrors release.js: only the pure decision helpers below (classifyExit,
// shouldRetry, buildRunResult) are unit-tested (orchestrate.test.js). The spawn/watchdog
// orchestration in runStage()/main() shells out to real tools and is exercised via /verify.

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { isMain, parseFlags } from "../lib/cli.js";
import { paths, resolveProfileName, ROOT } from "../lib/config.js";
import { readJson, writeJson } from "../lib/io.js";
import { isProgressStale } from "../pipeline/extract/state.js";
import { notify } from "../notify/notify.js";

const num = (name, def) => Number(process.env[name] || def);

// ---------- pure decision helpers (unit-tested) ----------

// Classify a finished stage into ok / soft-skip / fail. Stall and timeout are watchdog kills and
// outrank the exit code (meaningless after a SIGKILL). Exit 0 = ok. A non-zero exit is a
// soft-skip on a fail-soft stage (greenhouse/keka) and a hard fail otherwise.
export function classifyExit({ stage, code, signal, timedOut, stalled }) {
  if (stalled) return { status: "fail", reason: "stalled" };
  if (timedOut) return { status: "fail", reason: "timeout" };
  if (code === 0) return { status: "ok", reason: "" };
  if (stage.fatal === false) return { status: "soft-skip", reason: `exit ${code}` };
  return { status: "fail", reason: `exit ${code}` };
}

// Retry iff the stage declares a retry budget, it isn't spent, the outcome is a hard fail, and
// the failure isn't a stall — stalls are never retried (matches the old run_scheduled.sh rule:
// scraping already began, per-URL resume recovers it on the next slot).
export function shouldRetry({ stage, outcome, attempt }) {
  return (
    stage.retry != null &&
    attempt < stage.retry &&
    outcome.status === "fail" &&
    outcome.reason !== "stalled"
  );
}

// Shape written to last_run_result.json. Message is '' on success, '<stage>: <reason>' on fail.
export function buildRunResult({ status, stage, reason }) {
  return {
    status,
    timestamp: new Date().toISOString(),
    message: status === "success" ? "" : `${stage}: ${reason}`,
  };
}
