// scripts/lib/page_actions.test.js — pure-function / stub-based unit tests for page_actions.js.
// No real browser, no network, no child_process. Run with:
//   node --test scripts/lib/page_actions.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { jitterMs, createBudget, gotoWithRetry, withTimeout } from "./page_actions.js";

// --- jitterMs ---------------------------------------------------------------

test("jitterMs with rand=()=>0 returns minMs", () => {
  assert.equal(jitterMs(2000, 5000, () => 0), 2000);
});

test("jitterMs with rand≈1 returns just under maxMs", () => {
  const v = jitterMs(2000, 5000, () => 0.9999999);
  assert.ok(v < 5000, `expected ${v} < 5000`);
  assert.ok(v >= 2000, `expected ${v} >= 2000`);
});

test("jitterMs defaults to 2000/5000 bounds", () => {
  const v = jitterMs(undefined, undefined, () => 0.5);
  assert.ok(v >= 2000 && v < 5000, `expected 2000 <= ${v} < 5000`);
});

// --- createBudget -------------------------------------------------------------

test("createBudget: elapsed/remaining/expired transition with a fake clock", () => {
  let t = 0;
  const budget = createBudget(1000, { now: () => t });
  assert.equal(budget.elapsed(), 0);
  assert.equal(budget.remaining(), 1000);
  assert.equal(budget.expired(), false);

  t = 500;
  assert.equal(budget.elapsed(), 500);
  assert.equal(budget.remaining(), 500);
  assert.equal(budget.expired(), false);

  t = 1000;
  assert.equal(budget.elapsed(), 1000);
  assert.equal(budget.remaining(), 0);
  assert.equal(budget.expired(), true);

  t = 1500;
  assert.equal(budget.remaining(), 0); // never negative
  assert.equal(budget.expired(), true);
});

// --- gotoWithRetry ------------------------------------------------------------

test("gotoWithRetry: exhausts 1+retries attempts then throws the last error", async () => {
  let calls = 0;
  const page = {
    goto: async () => {
      calls++;
      throw new Error("boom");
    },
  };
  await assert.rejects(
    () => gotoWithRetry(page, "https://example.com", { retries: 2, backoffMs: () => 0, log: { warn() {} } }),
    /boom/
  );
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test("gotoWithRetry: succeeds on the second attempt", async () => {
  let calls = 0;
  const page = {
    goto: async (url) => {
      calls++;
      if (calls < 2) throw new Error("boom");
      return { ok: true, url };
    },
  };
  const result = await gotoWithRetry(page, "https://example.com", { retries: 2, backoffMs: () => 0, log: { warn() {} } });
  assert.equal(calls, 2);
  assert.deepEqual(result, { ok: true, url: "https://example.com" });
});

// --- withTimeout ---------------------------------------------------------------

test("withTimeout: passes through a promise that resolves in time", async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000, "fast"), 42);
});

test("withTimeout: passes through a rejection unchanged", async () => {
  await assert.rejects(() => withTimeout(Promise.reject(new Error("boom")), 1000, "x"), /boom/);
});

test("withTimeout: rejects with the label once the deadline passes", async () => {
  const never = new Promise(() => {});
  await assert.rejects(() => withTimeout(never, 20, "wedged evaluate"), /wedged evaluate.*20ms/);
});

test("withTimeout: does not leave the process held open by its timer", async () => {
  // If the timer isn't unref'd/cleared, `node --test` would hang after a passing race.
  await withTimeout(Promise.resolve("ok"), 60_000, "long deadline");
});
