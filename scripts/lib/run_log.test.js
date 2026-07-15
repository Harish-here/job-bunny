// scripts/lib/run_log.test.js — formatLine (pure) + createRunLog console-mirror/child behavior.
// No fs writes (filePath left null throughout), no real browser/network. Run with:
//   node --test scripts/lib/run_log.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLine, createRunLog } from "./run_log.js";

// --- formatLine ---------------------------------------------------------------

test("formatLine renders ts, tag, and msg with no stage/ctx", () => {
  const line = formatLine({ ts: "2026-07-15T00:00:00.000Z", tag: "extract", msg: "hello" });
  assert.equal(line, "2026-07-15T00:00:00.000Z [extract] hello");
});

test("formatLine omits the level word for info but upper-cases warn/error", () => {
  const info = formatLine({ ts: "T", tag: "x", level: "info", msg: "m" });
  const warn = formatLine({ ts: "T", tag: "x", level: "warn", msg: "m" });
  const error = formatLine({ ts: "T", tag: "x", level: "error", msg: "m" });
  assert.equal(info, "T [x] m");
  assert.equal(warn, "T [x] WARN m");
  assert.equal(error, "T [x] ERROR m");
});

test("formatLine includes stage when present", () => {
  const line = formatLine({ ts: "T", tag: "extract", stage: "collect-cards", msg: "go" });
  assert.equal(line, "T [extract] collect-cards go");
});

test("formatLine renders ctx k=v pairs in insertion order, skipping null/undefined", () => {
  const line = formatLine({
    ts: "T",
    tag: "extract",
    ctx: { url_index: 2, url_total: 5, dropped: null, missing: undefined, group: "linkedin" },
    msg: "progress",
  });
  assert.equal(line, "T [extract] url_index=2 url_total=5 group=linkedin progress");
});

test("formatLine combines level, stage, ctx and msg in the documented order", () => {
  const line = formatLine({
    ts: "T",
    tag: "extract",
    level: "warn",
    stage: "jd-capture",
    ctx: { job_id: "123" },
    msg: "empty JD, retrying",
  });
  assert.equal(line, "T [extract] WARN jd-capture job_id=123 empty JD, retrying");
});

test("formatLine trims a trailing space when msg is empty", () => {
  const line = formatLine({ ts: "T", tag: "extract", stage: "teardown", ctx: { reason: "success" } });
  assert.equal(line, "T [extract] teardown reason=success");
});

// --- createRunLog -------------------------------------------------------------

function captureConsole() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => lines.push(["log", args.join(" ")]);
  console.warn = (...args) => lines.push(["warn", args.join(" ")]);
  console.error = (...args) => lines.push(["error", args.join(" ")]);
  return {
    lines,
    restore() {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    },
  };
}

test("createRunLog: info/warn/error mirror to console with the right level, filePath:null does not throw", async () => {
  const cap = captureConsole();
  try {
    const log = createRunLog({ tag: "extract", filePath: null, baseCtx: { profile: "p1" } });
    await log.info("hello", { a: 1 });
    await log.warn("careful", { a: 2 });
    await log.error("boom", { a: 3 });
    assert.equal(cap.lines.length, 3);
    assert.equal(cap.lines[0][0], "log");
    assert.match(cap.lines[0][1], /\[extract\] profile=p1 a=1 hello/);
    assert.equal(cap.lines[1][0], "warn");
    assert.match(cap.lines[1][1], /WARN profile=p1 a=2 careful/);
    assert.equal(cap.lines[2][0], "error");
    assert.match(cap.lines[2][1], /ERROR profile=p1 a=3 boom/);
  } finally {
    cap.restore();
  }
});

test("createRunLog: checkpoint logs stage + CHECKPOINT msg and invokes onCheckpoint with merged ctx", async () => {
  const cap = captureConsole();
  const seen = [];
  try {
    const log = createRunLog({
      tag: "extract",
      filePath: null,
      baseCtx: { profile: "p1" },
      onCheckpoint: async (stage, ctx) => seen.push({ stage, ctx }),
    });
    await log.checkpoint("collect-cards", { cards_captured: 17 });
    assert.equal(cap.lines.length, 1);
    assert.match(cap.lines[0][1], /\[extract\] collect-cards profile=p1 cards_captured=17 CHECKPOINT/);
    assert.deepEqual(seen, [{ stage: "collect-cards", ctx: { profile: "p1", cards_captured: 17 } }]);
  } finally {
    cap.restore();
  }
});

test("createRunLog: checkpoint never throws even if onCheckpoint's hook throws", async () => {
  const log = createRunLog({
    tag: "extract",
    filePath: null,
    onCheckpoint: async () => {
      throw new Error("progress writer exploded");
    },
  });
  await assert.doesNotReject(() => log.checkpoint("teardown", { reason: "success" }));
});

test("createRunLog: child() merges baseCtx and shares tag/onCheckpoint", async () => {
  const cap = captureConsole();
  try {
    const parent = createRunLog({ tag: "extract", filePath: null, baseCtx: { profile: "p1" } });
    const kid = parent.child({ group: "linkedin__jobs-search" });
    await kid.info("child log line");
    assert.equal(cap.lines.length, 1);
    assert.match(cap.lines[0][1], /\[extract\] profile=p1 group=linkedin__jobs-search child log line/);
  } finally {
    cap.restore();
  }
});
