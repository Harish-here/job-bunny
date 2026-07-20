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

// ---------- stage config ----------

// Stage order IS the pipeline. `fatal:false` (greenhouse/keka) → a non-zero exit is logged and
// swallowed. `stall:true` (extract) → the progress-file stall watchdog runs. structure is the
// only claude -p stage: its exit code is unreliable, so `verify:true` re-checks the output file.
export function buildStages(profile) {
  return [
    { name: "doctor", cmd: ["node", "scripts/ops/doctor.js"], fatal: true },
    { name: "reconcile", cmd: ["node", "scripts/notion/cache.js"], fatal: true },
    { name: "extract", cmd: ["node", "scripts/pipeline/extract.js"], fatal: true, retry: 1, stall: true },
    { name: "greenhouse", cmd: ["node", "scripts/pipeline/greenhouse.js"], fatal: false },
    { name: "keka", cmd: ["node", "scripts/pipeline/keka.js"], fatal: false },
    { name: "compress", cmd: ["node", "scripts/pipeline/compress.js"], fatal: true },
    {
      name: "structure",
      cmd: ["claude", "-p", `/structure ${profile}`, "--dangerously-skip-permissions"],
      fatal: true,
      retry: 1,
      timeoutSec: num("JOBBUNNY_STRUCTURE_TIMEOUT_SECONDS", 900),
      verify: true,
    },
    { name: "assemble", cmd: ["node", "scripts/pipeline/assemble.js"], fatal: true },
    { name: "filter", cmd: ["node", "scripts/pipeline/filter.js"], fatal: true },
    { name: "dedup", cmd: ["node", "scripts/pipeline/dedup.js"], fatal: true },
    { name: "rank", cmd: ["node", "scripts/pipeline/rank.js"], fatal: true },
    { name: "sync", cmd: ["node", "scripts/notion/notion_sync.js"], fatal: true },
  ];
}

// ---------- spawn / watchdog ----------

const HEARTBEAT_SECONDS = num("JOBBUNNY_EXTRACT_HEARTBEAT_SECONDS", 300);
const STALL_SECONDS = num("JOBBUNNY_EXTRACT_STALL_SECONDS", 600);

// The stage child currently running, so the run-cap timer can kill it before exit.
let currentChild = null;

// Single-pid signal (never the -pid group form). extract's own SIGTERM handler closes Chrome;
// stages are non-detached so run_scheduled.sh's coarse group-kill backstop reaches them too.
function killChild(child, sig) {
  try {
    child.kill(sig);
  } catch {
    // already exited
  }
}

// SIGTERM, wait 20s for a graceful teardown (extract's SIGTERM handler closes Chrome — a shorter
// grace guillotined it mid-teardown and leaked Chrome), then SIGKILL.
async function terminateChild(child, sleep) {
  killChild(child, "SIGTERM");
  await sleep(20000);
  killChild(child, "SIGKILL");
}

// Spawn one stage in the foreground, enforce its per-stage timeout and (for extract) the
// progress-file stall watchdog, and return a classified outcome. Watchdogs are fire-and-forget
// and self-cancel once the child exits (cleared timers + `finished`) so a fast stage never
// blocks on a pending sleep.
async function runStage(stage, { profile, runStartEpochSec }) {
  const [bin, ...args] = stage.cmd;
  const child = spawn(bin, args, {
    cwd: ROOT,
    stdio: "inherit",
    detached: false,
    env: { ...process.env, JOBBUNNY_PROFILE: profile },
  });
  currentChild = child;

  let finished = false;
  let timedOut = false;
  let stalled = false;
  const timers = new Set();
  const sleep = (ms) =>
    new Promise((res) => {
      const t = setTimeout(() => {
        timers.delete(t);
        res();
      }, ms);
      timers.add(t);
    });
  const alive = () => !finished && child.exitCode === null && child.signalCode === null;

  // Per-stage hard timeout (structure only, via timeoutSec).
  if (stage.timeoutSec) {
    (async () => {
      await sleep(stage.timeoutSec * 1000);
      if (alive()) {
        timedOut = true;
        await terminateChild(child, sleep);
      }
    })();
  }

  // Extract stall watchdog: after a grace window, poll the progress file every 60s and kill on a
  // stale heartbeat. isProgressStale also rejects a progress file left by a PRIOR run, and treats
  // an absent/not-yet-written progress file as "not started" (keep waiting), not stale.
  if (stage.stall) {
    (async () => {
      await sleep(HEARTBEAT_SECONDS * 1000);
      while (alive()) {
        let progress = null;
        try {
          progress = await readJson(paths(profile).extractProgress);
        } catch {
          progress = null;
        }
        const r = isProgressStale(progress, {
          nowMs: Date.now(),
          runStartEpochSec,
          staleMs: STALL_SECONDS * 1000,
          skewSec: 5,
        });
        if (r.stale) {
          stalled = true;
          await terminateChild(child, sleep);
          return;
        }
        await sleep(60000);
      }
    })();
  }

  const { code, signal } = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => {
      console.error(`[orchestrate] ${stage.name}: spawn error: ${err.message}`);
      resolve({ code: 1, signal: null });
    });
  });

  finished = true;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  currentChild = null;

  return classifyExit({ stage, code, signal, timedOut, stalled });
}

// Structure seam: `claude -p` exit code is unreliable, so after the structure stage confirm the
// decisions file exists AND is at least as new as the input it was generated from. paths()
// exposes jobs_raw_decisions.md as `.decisions` (there is no `.jobsRawDecisions` key).
async function verifyStructure(profile) {
  const p = paths(profile);
  try {
    const [decisions, input] = await Promise.all([stat(p.decisions), stat(p.structureInput)]);
    return decisions.mtimeMs >= input.mtimeMs;
  } catch {
    return false;
  }
}

// Build + print the `## Run Summary` block and RETURN it (also used as the notify body). The
// marker line is printed verbatim so the block stays greppable in the log for debugging.
async function emitSummary(profile, { ran, softSkipped }) {
  let count = "n/a";
  try {
    const jobs = await readJson(paths(profile).newJobs);
    if (Array.isArray(jobs)) count = String(jobs.length);
  } catch {
    // new_jobs.json absent → leave n/a
  }
  const summary = [
    "",
    `## Run Summary — profile: ${profile}`,
    "",
    `- **Stages run:** ${ran.join(", ")}`,
    `- **Soft-skipped:** ${softSkipped.length ? softSkipped.join(", ") : "none"}`,
    `- **New jobs:** ${count}`,
  ].join("\n");
  console.log(summary);
  return summary;
}

// ---------- main ----------

async function main() {
  const { flags } = parseFlags();
  const profile = flags.profile || resolveProfileName();
  process.env.JOBBUNNY_PROFILE = profile;
  console.log(`[orchestrate] profile=${profile}`);

  const p = paths(profile);
  await mkdir(p.dataDir, { recursive: true });

  const runStartEpochSec = Math.floor(Date.now() / 1000);

  // Coarse total-run cap — a backstop across the whole sequence, above the per-stage
  // timeout/stall guards. On expiry, kill the current stage, record the failure, exit 1.
  const runCap = setTimeout(async () => {
    if (currentChild) killChild(currentChild, "SIGKILL");
    await writeJson(p.lastRunResult, buildRunResult({ status: "failed", stage: "run", reason: "run-timeout" }));
    console.log(`[orchestrate] FAILED — run: run-timeout`);
    await notify({ severity: "blocking", title: "Run timed out", body: `${profile}: run-timeout` });
    process.exit(1);
  }, num("JOBBUNNY_RUN_TIMEOUT_SECONDS", 1800) * 1000);
  runCap.unref();

  const stages = buildStages(profile);
  const ran = [];
  const softSkipped = [];

  for (const stage of stages) {
    let outcome;
    for (let attempt = 0; ; attempt++) {
      outcome = await runStage(stage, { profile, runStartEpochSec });
      if (outcome.status === "ok" && stage.verify && !(await verifyStructure(profile))) {
        outcome = { status: "fail", reason: "verify: decisions not refreshed" };
      }
      if (outcome.status === "fail" && shouldRetry({ stage, outcome, attempt })) {
        console.log(`[orchestrate] ${stage.name} failed (${outcome.reason}) — retry ${attempt + 1}/${stage.retry}`);
        continue;
      }
      break;
    }

    if (outcome.status === "soft-skip") {
      console.log(`[orchestrate] ${stage.name} soft-failed (${outcome.reason}) — continuing`);
      softSkipped.push(stage.name);
      continue;
    }
    if (outcome.status === "fail") {
      clearTimeout(runCap);
      const result = buildRunResult({ status: "failed", stage: stage.name, reason: outcome.reason });
      await writeJson(p.lastRunResult, result);
      console.log(`[orchestrate] FAILED — ${stage.name}: ${outcome.reason}`);
      await notify({ severity: "blocking", title: "Run failed", body: `${profile}: ${result.message}` });
      process.exit(1);
    }
    ran.push(stage.name);
  }

  clearTimeout(runCap);
  await writeJson(p.lastRunResult, buildRunResult({ status: "success" }));
  const summary = await emitSummary(profile, { ran, softSkipped });
  await notify({ severity: "success", body: summary });
  process.exit(0);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[orchestrate] FAILED: ${err.message}`);
    process.exit(1);
  });
}
