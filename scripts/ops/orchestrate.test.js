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
