# orchestrate.js — Headless Pipeline Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `run_scheduled.sh → claude -p "/run <profile>"` single-shot with a plain node process (`scripts/ops/orchestrate.js`) that spawns each pipeline stage as a foreground child and owns the watchdog, retry, and failure-capture.

**Architecture:** One node process is the pipeline. It walks an ordered STAGES array, spawning each existing stage script (`node scripts/*.js`) as a blocking child; the one LLM stage (`/structure`) is spawned as `claude -p`. Because the long extract stage now runs in a normal OS process — never inside a Claude turn — it can no longer be auto-backgrounded and truncated. Interactive `/run` and headless `run_scheduled.sh` share this single code path.

**Tech Stack:** Node ≥20 ESM, `node:child_process` `spawn`, `node:test`. Reuses `scripts/lib/{cli,config,io}.js` and `isProgressStale` from `scripts/pipeline/extract/state.js`.

## Context

Today's scheduled runs failed because the headless `claude -p "/run harish"` single-shot **auto-backgrounded the ~10-minute extract stage** ("auto-backgrounded due to its length"), the turn exited, and the run truncated mid-extract — no summary, no `mark_run_result.js` call. `run_scheduled.sh` then read a **stale** `last_run_result.json` (from days earlier), marked the run FAILED, and closed Chrome (which happened to be parked on the "Staff Frontend Engineer – Chennai" search — the coincidental symptom the user witnessed). CLAUDE.md's prose rule "never background extract" can't hold when the harness itself backgrounds long Bash calls in a single-shot.

The fix is structural and sets up a **maturity ladder**: the deterministic pipeline becomes a self-contained process (`orchestrate.js`) that Claude *wraps* rather than *contains*. Phase 1 (now): Claude is still the harness for the one LLM stage (`/structure`, spawned as `claude -p`). Phase 2 (when structure is automated): flip that one STAGES row from `claude -p` to `node …`, and Claude drops out of the headless path entirely — `run_scheduled.sh` runs `orchestrate.js` with no Claude at all. Removability is one line in an array.

## Global Constraints

- ESM only; `.js` on all local imports; `node:` prefix on builtins.
- `orchestrate.js` imports: `{ isMain, parseFlags }` from `../lib/cli.js`; `{ paths, resolveProfileName, ROOT }` from `../lib/config.js`; `{ readJson, writeJson }` from `../lib/io.js`; `{ isProgressStale }` from `../pipeline/extract/state.js`; `{ notify }` from `../notify/notify.js` (best-effort, `isMain`-guarded — safe to import, never throws); `{ spawn }` from `node:child_process`; `{ mkdir, stat }` from `node:fs/promises`.
- **Spawn opts for every stage:** `{ cwd: ROOT, stdio: "inherit", detached: false, env: { ...process.env, JOBBUNNY_PROFILE: profile } }`. Kill via single-pid `child.kill(sig)` — **never** the negative-pid group form. Rationale: extract launches Chrome `detached:true` (browser.js:126), so Chrome is already in its own group; the only reliable Chrome cleanup is extract's own SIGTERM→teardown→`killChrome()`. Keeping stages non-detached also lets `run_scheduled.sh`'s coarse backstop (`kill -- -$orchestrate_pid`) reach them.
- Never launch/kill Chrome from orchestrate. SIGTERM to extract → extract tears down Chrome, exits 143.
- **`paths()` key names (verified in config.js):** decisions file is `paths().decisions` (there is **no** `jobsRawDecisions` key); also `structureInput`, `extractProgress`, `newJobs`, `lastRunResult`, `dataDir`. Reuse these — no config.js edit.
- Tests **never** spawn/mock `child_process` (repo convention — see `scripts/ops/release.test.js` header). Only the three pure helpers are unit-tested. `isProgressStale` is imported-and-reused, already covered by `state.test.js` — do **not** retest it.
- `## Run Summary — profile: <name>` printed verbatim on success (log/interactive visibility). **orchestrate.js sends this same block as the Telegram digest via `notify()`** — success and failure notifications are sent by orchestrate, the single sender; `run_scheduled.sh` no longer sends Telegram (no double-notify, no `JOBBUNNY_HEADLESS` guard).
- Env knobs via `Number(process.env[X] || default)`: `JOBBUNNY_STRUCTURE_TIMEOUT_SECONDS`=900, `JOBBUNNY_EXTRACT_HEARTBEAT_SECONDS`=300, `JOBBUNNY_EXTRACT_STALL_SECONDS`=600, `JOBBUNNY_RUN_TIMEOUT_SECONDS`=1800 (orchestrate's own run cap).
- `main` is protected — work on `feat/orchestrate-runner`; land via PR with the `test` check green. Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- **Create** `scripts/ops/orchestrate.js` — the runner (pure helpers + spawn/watchdog + main).
- **Create** `scripts/ops/orchestrate.test.js` — unit tests for the pure helpers only.
- **Modify** `scripts/ops/run_scheduled.sh` — invoke orchestrate; strip the heartbeat/stall/retry watchdogs; keep caffeinate, a coarse backstop timeout, osascript, Telegram digest, Chrome backstop-close.
- **Rewrite** `.claude/commands/run.md` — thin wrapper over orchestrate.
- **Modify** `CLAUDE.md` — lines 59 (hard rule), 63 (scheduling), 65 (outcome contract).
- **Delete** `scripts/ops/{check_extract_started,check_run_result,mark_run_result}.js` — superseded (conditional on a clean grep).

---

## Task 1 — Pure decision helpers (unit-testable)

**Files:**
- Create: `scripts/ops/orchestrate.js` (header + imports + 3 exported pure helpers only)
- Test: `scripts/ops/orchestrate.test.js`

**Interfaces:**
- Produces `classifyExit({ stage, code, signal, timedOut, stalled }) → { status:'ok'|'soft-skip'|'fail', reason }`
- Produces `shouldRetry({ stage, outcome, attempt }) → boolean`
- Produces `buildRunResult({ status, stage, reason }) → { status, timestamp, message }`

- [ ] **Step 1.1: Write the failing test** — create `scripts/ops/orchestrate.test.js`:

```js
// scripts/ops/orchestrate.test.js — node:test unit tests for orchestrate.js's pure decision
// helpers (classifyExit, shouldRetry, buildRunResult). No child_process spawning, no I/O —
// same division as release.test.js: main()'s spawn/watchdog orchestration is intentionally left
// uncovered here. isProgressStale is imported-and-reused by orchestrate.js and is already
// covered by extract/state.test.js — not retested here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyExit, shouldRetry, buildRunResult } from "./orchestrate.js";

const fatal = { name: "extract", fatal: true, retry: 1 };
const soft = { name: "greenhouse", fatal: false };

test("classifyExit: stalled outranks everything → fail/stalled", () => {
  assert.deepEqual(
    classifyExit({ stage: fatal, code: 0, signal: null, timedOut: false, stalled: true }),
    { status: "fail", reason: "stalled" }
  );
});

test("classifyExit: timedOut → fail/timeout", () => {
  assert.deepEqual(
    classifyExit({ stage: fatal, code: null, signal: "SIGKILL", timedOut: true, stalled: false }),
    { status: "fail", reason: "timeout" }
  );
});

test("classifyExit: clean exit 0 → ok", () => {
  assert.deepEqual(
    classifyExit({ stage: fatal, code: 0, signal: null, timedOut: false, stalled: false }),
    { status: "ok", reason: "" }
  );
});

test("classifyExit: non-zero on a fail-soft stage → soft-skip", () => {
  assert.deepEqual(
    classifyExit({ stage: soft, code: 1, signal: null, timedOut: false, stalled: false }),
    { status: "soft-skip", reason: "exit 1" }
  );
});

test("classifyExit: non-zero on a fatal stage → fail/exit N", () => {
  assert.deepEqual(
    classifyExit({ stage: fatal, code: 2, signal: null, timedOut: false, stalled: false }),
    { status: "fail", reason: "exit 2" }
  );
});

test("shouldRetry: true on first fatal exit-failure with retry budget left", () => {
  assert.equal(shouldRetry({ stage: fatal, outcome: { status: "fail", reason: "exit 1" }, attempt: 0 }), true);
});

test("shouldRetry: false once the retry budget is spent", () => {
  assert.equal(shouldRetry({ stage: fatal, outcome: { status: "fail", reason: "exit 1" }, attempt: 1 }), false);
});

test("shouldRetry: never retries a stall", () => {
  assert.equal(shouldRetry({ stage: fatal, outcome: { status: "fail", reason: "stalled" }, attempt: 0 }), false);
});

test("shouldRetry: false when the stage has no retry key", () => {
  assert.equal(shouldRetry({ stage: soft, outcome: { status: "fail", reason: "exit 1" }, attempt: 0 }), false);
});

test("shouldRetry: false when the outcome isn't a fail", () => {
  assert.equal(shouldRetry({ stage: fatal, outcome: { status: "ok", reason: "" }, attempt: 0 }), false);
});

test("buildRunResult: success has empty message and an ISO timestamp", () => {
  const r = buildRunResult({ status: "success" });
  assert.equal(r.status, "success");
  assert.equal(r.message, "");
  assert.match(r.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("buildRunResult: failure message is '<stage>: <reason>'", () => {
  const r = buildRunResult({ status: "failed", stage: "extract", reason: "stalled" });
  assert.equal(r.status, "failed");
  assert.equal(r.message, "extract: stalled");
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `node --test scripts/ops/orchestrate.test.js`
Expected: FAIL — `Cannot find module './orchestrate.js'`.

- [ ] **Step 1.3: Write minimal implementation** — create `scripts/ops/orchestrate.js`:

```js
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
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `node --test scripts/ops/orchestrate.test.js`
Expected: PASS — 12 tests.

- [ ] **Step 1.5: Commit**

```bash
git checkout -b feat/orchestrate-runner
git add scripts/ops/orchestrate.js scripts/ops/orchestrate.test.js
git commit -m "$(printf 'feat(orchestrate): pure decision helpers for the pipeline runner\n\nclassifyExit/shouldRetry/buildRunResult, unit-tested like release.js.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 2 — Spawn/watchdog runner + main wiring

**Files:**
- Modify: `scripts/ops/orchestrate.js` (append stages config, `runStage`, watchdogs, `verifyStructure`, `printSummary`, `main`, isMain guard)
- (No new tests — spawn path is intentionally uncovered, same as `release.js` main.)

**Interfaces:**
- Consumes: Task-1 helpers; `spawn`; `paths().{dataDir,extractProgress,decisions,structureInput,newJobs,lastRunResult}`; `resolveProfileName()`; `ROOT`; `readJson`/`writeJson`; `isProgressStale(progress, { nowMs, runStartEpochSec, staleMs, skewSec })`.
- Produces (module-internal): `buildStages(profile)`, `runStage(stage, { profile, runStartEpochSec })`, `verifyStructure(profile)`, `emitSummary(profile, { ran, softSkipped }) → string`, `main()`. Calls `notify()` on success (severity `success`, body = summary) and on failure (severity `blocking`).

- [ ] **Step 2.1: Append runner + main** to `scripts/ops/orchestrate.js`:

```js
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
```

- [ ] **Step 2.2: Verify no regression + syntax**

Run: `node --check scripts/ops/orchestrate.js && node --test scripts/ops/orchestrate.test.js && npm test`
Expected: `node --check` silent (exit 0); orchestrate unit tests still 12/12 (import runs no top-level side effects — everything is behind `isMain`); full suite green.

- [ ] **Step 2.3: Commit**

```bash
git add scripts/ops/orchestrate.js
git commit -m "$(printf 'feat(orchestrate): spawn/watchdog stage runner + main wiring\n\nForeground non-detached spawn per stage with single-pid kill, per-stage\ntimeout, extract stall poll (isProgressStale), structure output verify,\nretry, fail-soft, run cap, the verbatim Run Summary block, and\nbest-effort Telegram notify on success and failure.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 3 — `run_scheduled.sh`: invoke orchestrate, strip the old watchdogs

**Files:**
- Modify: `scripts/ops/run_scheduled.sh`

**Interfaces:**
- Consumes: `node scripts/ops/orchestrate.js --profile <p>` exit code (0=PASSED else FAILED).
- Produces: osascript desktop ping + Chrome backstop-close unchanged. **Telegram is no longer sent here** — orchestrate.js sends it (success + failure).

Not TDD (shell). Deliverable = clean `bash -n` + a real `/verify` run.

- [ ] **Step 3.1: Replace `run_attempt()`** (current L62–155) with a body that launches orchestrate and keeps only the coarse-timeout backstop. **The backstop deadline must sit above orchestrate's own run cap** so orchestrate cleans up its (non-detached) children first:

```bash
# Runs one attempt of orchestrate.js, tee'd to $2, with a single coarse-timeout backstop in case
# orchestrate itself hangs (its own per-stage timeout/stall guards + run cap are the primary
# defense). BACKSTOP_SECONDS is set above orchestrate's JOBBUNNY_RUN_TIMEOUT_SECONDS so
# orchestrate's own cap fires first and tears down the current stage. Sets ATTEMPT_EXIT_CODE,
# ATTEMPT_TIMED_OUT as globals for the caller.
run_attempt() {
  local profile="$1" log_file="$2"
  local orchestrate_pid timeout_watchdog_pid caffeinate_pid timed_out_flag
  local backstop_seconds=$(( ${JOBBUNNY_RUN_TIMEOUT_SECONDS:-1800} + 300 ))

  timed_out_flag="$(mktemp)"; rm -f "$timed_out_flag"

  # orchestrate.js IS the pipeline runner now — it spawns each stage as a foreground child and
  # owns retry/stall/timeout/failure-capture. --dangerously-skip-permissions is no longer passed
  # here: orchestrate spawns `claude -p /structure ... --dangerously-skip-permissions` itself.
  JOBBUNNY_PROFILE="$profile" node "$ROOT/scripts/ops/orchestrate.js" --profile "$profile" \
    > >(tee "$log_file") 2>&1 &
  orchestrate_pid=$!

  # Keep the machine awake for the run (launchd does not); -w releases on the pid's exit.
  caffeinate -i -s -w "$orchestrate_pid" &
  caffeinate_pid=$!

  # Coarse backstop only: if orchestrate is still alive past the deadline, group-kill it (stages
  # are non-detached, so they share its group and get the signal too).
  (
    sleep "$backstop_seconds"
    if kill -0 "$orchestrate_pid" 2>/dev/null; then
      touch "$timed_out_flag"
      kill -TERM -- "-$orchestrate_pid" 2>/dev/null
      sleep 20
      kill -KILL -- "-$orchestrate_pid" 2>/dev/null
    fi
  ) &
  timeout_watchdog_pid=$!

  wait "$orchestrate_pid" 2>/dev/null
  ATTEMPT_EXIT_CODE=$?

  kill "$timeout_watchdog_pid" 2>/dev/null; wait "$timeout_watchdog_pid" 2>/dev/null
  kill "$caffeinate_pid" 2>/dev/null; wait "$caffeinate_pid" 2>/dev/null

  sleep 1  # let the tee subshell flush before anyone greps the log

  if [ -f "$timed_out_flag" ]; then ATTEMPT_TIMED_OUT=1; else ATTEMPT_TIMED_OUT=0; fi
  rm -f "$timed_out_flag"
}
```

Also drop the now-obsolete `HEARTBEAT_SECONDS`/`STALL_SECONDS` shell vars (current L37–55) — orchestrate.js owns them. Keep `TIMEOUT_SECONDS` only if still referenced elsewhere; otherwise remove it (the backstop now derives from `JOBBUNNY_RUN_TIMEOUT_SECONDS`).

- [ ] **Step 3.2: Replace `determine_status()`** (current L157–202) — status is now purely orchestrate's exit code + the coarse timeout flag:

```bash
# Turns the ATTEMPT_* globals into STATUS/REASON/MESSAGE. Outcome = orchestrate's exit code
# (0=PASSED else FAILED); orchestrate has already written last_run_result.json. The old
# check_run_result.js / check_extract_started.js probes are gone.
determine_status() {
  local profile="$1" log_file="$2"

  if [ "$ATTEMPT_TIMED_OUT" -eq 1 ]; then
    STATUS="FAILED"
    REASON="timeout"
    MESSAGE="Job Bunny run TIMED OUT for $profile (backstop killed orchestrate) — check log: $log_file"
  elif [ "$ATTEMPT_EXIT_CODE" -eq 0 ]; then
    STATUS="PASSED"
    REASON="passed"
    MESSAGE="Job Bunny run completed successfully for $profile. Log: $log_file"
  else
    STATUS="FAILED"
    REASON="other"
    MESSAGE="Job Bunny run failed for $profile. Check log: $log_file"
  fi
}
```

- [ ] **Step 3.3: Delete the retry-once block** (current L216–249) — the whole `retry=0 … determine_status` block and its comment. The loop body becomes: `run_attempt` → `determine_status` → notify. Retry now lives in orchestrate.js per-stage.

- [ ] **Step 3.4: Remove the Telegram notify.js calls** (current L254–274). orchestrate.js now sends the Telegram digest itself (success + failure), so the shell must NOT also send it (that would double-notify). Delete the entire `if [ "$STATUS" = "PASSED" ] … node "$ROOT/scripts/notify/notify.js" … fi` chain, including its `sed -n '/## Run Summary/,$p'` body extraction. **Keep** the `osascript` desktop ping (current L252) — it's a local macOS notification, orthogonal to Telegram — and keep the `for profile` loop, `mkdir -p .../logs`, `set -m`/`set -uo pipefail`, and the Chrome backstop-close block (current L279–309) unchanged.

- [ ] **Step 3.5: Verify + commit**

```bash
bash -n scripts/ops/run_scheduled.sh
git add scripts/ops/run_scheduled.sh
git commit -m "$(printf 'refactor(run_scheduled): invoke orchestrate.js; drop shell watchdogs\n\nReplace the claude -p "/run" single-shot + heartbeat/stall/retry logic\nwith node orchestrate.js --profile. Status = orchestrate exit code.\nKeep caffeinate, a coarse timeout backstop (above orchestrate run cap),\nosascript, and the Chrome backstop-close. Telegram digest now sent by\norchestrate.js, not the shell.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 4 — `.claude/commands/run.md`: thin wrapper

**Files:**
- Modify: `.claude/commands/run.md` (full body rewrite; keep frontmatter accurate)

- [ ] **Step 4.1: Replace the file** with:

```md
---
description: Run the full v0 pipeline end-to-end for a profile. Thin wrapper over scripts/ops/orchestrate.js, which spawns every stage (doctor → sync) as a blocking child and owns watchdog/retry/failure-capture.
---

Run the daily pipeline for a profile. This command is a thin wrapper: the whole pipeline —
doctor, reconcile, extract, greenhouse, keka, compress, structure, assemble, filter, dedup,
rank, sync — is run by `scripts/ops/orchestrate.js`, a single node process that spawns each stage
as a foreground child and owns the watchdog, retry, stall-detection, and failure-capture.
`/structure` is spawned by orchestrate as `claude -p`, not invoked inline here.

**Step 0 — resolve the profile.** If `$ARGUMENTS` names a profile, use it. Otherwise read
`default_profile` from `config.json` (no `config.json` = not set up — stop and point at
`/setup`). State which profile the run is for before starting.

**Step 1 — run the orchestrator in the FOREGROUND.** One blocking process — do NOT background it
(no `run_in_background`), do not wrap it, do not re-implement any stage:

    JOBBUNNY_PROFILE=<profile> node scripts/ops/orchestrate.js --profile <profile>

orchestrate writes `profiles/<profile>/data/last_run_result.json`, and on success prints a
`## Run Summary — profile: <profile>` block on stdout. Its exit code is the outcome (0 = passed,
non-zero = failed).

**Step 2 — relay the result.** Relay orchestrate's `## Run Summary` block verbatim on success. On
a non-zero exit, report the failure line orchestrate printed (`[orchestrate] FAILED — …`) rather
than inventing a summary. Do not call `mark_run_result.js` and do not send Telegram from here —
orchestrate owns the result file and sends the Telegram digest itself (success and failure).
```

- [ ] **Step 4.2: Commit**

```bash
git add .claude/commands/run.md
git commit -m "$(printf 'docs(run): rewrite /run as a thin orchestrate.js wrapper\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 5 — `CLAUDE.md`: update lines 59, 63, 65

**Files:**
- Modify: `CLAUDE.md`

Three targeted replacements (keep surrounding markdown/table style byte-accurate).

- [ ] **Step 5.1: Line 59 (hard rule)** — replace:
  > - **Never background a pipeline stage** (no `run_in_background`), especially extract. Headless runs execute via a single-shot `claude -p "/run <profile>"` — a backgrounded stage's completion notification can never arrive and silently truncates the run.

  with:
  > - **The pipeline runs as one orchestrator process.** `scripts/ops/orchestrate.js` spawns every stage (doctor → sync) as a blocking foreground child and owns retry/stall/timeout/failure-capture; `/structure` is spawned as `claude -p`. Headless and interactive `/run` share this one code path — no stage is ever backgrounded.

- [ ] **Step 5.2: Line 63 (scheduling)** — replace the `claude -p "/run <profile>"` sentence with:
  > Each job runs `scripts/ops/run_scheduled.sh`, which runs profiles strictly sequentially (they share one Chrome/CDP session) and invokes `node scripts/ops/orchestrate.js --profile <profile>` per profile. The per-stage watchdog (extract stall, per-stage timeout, run cap) lives inside orchestrate.js; the shell keeps only a coarse backstop timeout above that cap.

- [ ] **Step 5.3: Line 65 (outcome contract)** — replace:
  > Run outcome is communicated by file, not by parsing output: `/run` must always end with `scripts/ops/mark_run_result.js --status success|failed`, which `run_scheduled.sh` reads via `check_run_result.js`. Telegram digests are sent by `run_scheduled.sh` for headless runs and by `/run` itself only when `JOBBUNNY_HEADLESS` is unset — never both.

  with:
  > Run outcome is orchestrate.js's exit code (0 = passed, non-zero = failed); orchestrate also writes `profiles/<profile>/data/last_run_result.json` and sends the Telegram digest itself (success and failure) via `notify()` — the single sender, so there is no double-notify and no `JOBBUNNY_HEADLESS` guard. `run_scheduled.sh` only reads the exit code (and keeps its local osascript ping).

- [ ] **Step 5.4: Commit**

```bash
git add CLAUDE.md
git commit -m "$(printf 'docs(claude): document orchestrate.js pipeline runner & outcome contract\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 6 — Remove the three retired scripts (conditional)

**Files:**
- Delete: `scripts/ops/check_extract_started.js`, `scripts/ops/check_run_result.js`, `scripts/ops/mark_run_result.js`

- [ ] **Step 6.1: Re-grep for live references**

```bash
grep -rn "check_extract_started\|check_run_result\|mark_run_result" scripts .claude CLAUDE.md README.md
```

Expected after Tasks 3–5: only **code-comment** mentions remain (e.g. `scripts/pipeline/extract/state.js`, `scripts/lib/cli.js`), no `node …/<script>.js` invocation and no `import`. If any **executable** reference remains, STOP, leave the scripts, and report which file still calls them.

- [ ] **Step 6.2: Delete + verify + commit**

```bash
git rm scripts/ops/check_extract_started.js scripts/ops/check_run_result.js scripts/ops/mark_run_result.js
npm test
git commit -m "$(printf 'chore(ops): remove retired run-result/heartbeat probe scripts\n\nSuperseded by orchestrate.js (exit code + last_run_result.json); the\nshell no longer calls them.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Verification (end-to-end, before PR)

Gate for this change (per the user's instruction, overriding the default §Before any PR gate): **`npm test` → `/verify` only** — no `/simplify`, no `/code-review`. PR off `feat/orchestrate-runner` with the `test` check green.

1. **Unit:** `npm test` — orchestrate.test.js (12) + full suite green.
2. **Syntax:** `node --check scripts/ops/orchestrate.js` and `bash -n scripts/ops/run_scheduled.sh`.
3. **Runtime (fixture profile only — never harish/uvashree):** drive the committed synthetic profile `profiles/rajni/` per the `/verify` skill:
   - `JOBBUNNY_PROFILE=rajni node scripts/ops/orchestrate.js --profile rajni` — confirm it walks the stages, and that on the first hard failure it writes `profiles/rajni/data/last_run_result.json` with `status:"failed"` and exits non-zero; on a full green pass it prints `## Run Summary — profile: rajni` and exits 0. (rajni has no Notion IDs, so expect a controlled failure at reconcile/sync — verify the failure is *captured* correctly, i.e. `last_run_result.json` + exit 1 + the `[orchestrate] FAILED — <stage>` line.)
   - Confirm `claude` resolves on PATH in the run context (the structure stage spawns `claude -p`); if a launchd run can't find `claude`, that's a PATH issue to surface, not an orchestrate bug.
4. **Headless smoke:** run `scripts/ops/run_scheduled.sh rajni` once and confirm: it launches orchestrate, waits, reads the exit code, and does the osascript ping + Chrome backstop-close. orchestrate's own `notify()` call is best-effort — with Telegram disabled for rajni it no-ops cleanly (never throws); confirm the shell makes no `notify.js` call of its own.

## Risks / known behavioral changes

- **Launch-hang detection is coarser.** The stall watchdog fires only once extract has written a *fresh* progress file; an extract that hangs *before* writing any progress (e.g. wedged during initial Chrome/login load) is caught only by the run cap (~1800s), not the old ~300s+stall path. Acceptable because the new architecture makes the *common* failure (Claude backgrounding extract) structurally impossible; if launch-hangs recur, add a modest `timeoutSec` to the extract stage.
- **Interactive `/run` spawns a nested `claude -p` for structure** (single code path, as chosen). Slightly redundant when already inside Claude, but keeps one pipeline definition and makes Phase-2 removal a one-line STAGES edit.
- **`claude -p` exit code is not trusted** — the structure stage relies on the `verifyStructure` mtime check, not the exit code.
- **Telegram notify moved into orchestrate.js** (single sender, success + failure). The shell no longer sends Telegram, eliminating the old double-notify / `JOBBUNNY_HEADLESS` guard. `notify()` is best-effort (never throws, no-ops when the channel is disabled), so a notify failure can never fail the run.
