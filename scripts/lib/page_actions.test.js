// scripts/lib/page_actions.test.js — pure-function / stub-based unit tests for page_actions.js.
// No real browser, no network, no child_process. Run with:
//   node --test scripts/lib/page_actions.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { jitterMs, createBudget, gotoWithRetry, safeText, safeAttr } from "./page_actions.js";

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

// --- safeText / safeAttr -------------------------------------------------------

// Fake Locator chain: scope.locator(sel).first().innerText(opts) / .getAttribute(attr, opts).
function fakeScope({ innerText = async () => "", getAttribute = async () => null } = {}) {
  const locator = { innerText, getAttribute, nth: () => locator, first: () => locator };
  return { locator: () => locator };
}

test("safeText: defaults to a 2000ms locator timeout when none is given", async () => {
  let seenOpts;
  const scope = fakeScope({ innerText: async (opts) => { seenOpts = opts; return "Staff Engineer"; } });
  const text = await safeText(scope, ".title");
  assert.equal(text, "Staff Engineer");
  assert.deepEqual(seenOpts, { timeout: 2000 });
});

test("safeText: threads a custom timeoutMs through to innerText", async () => {
  let seenOpts;
  const scope = fakeScope({ innerText: async (opts) => { seenOpts = opts; return "x"; } });
  await safeText(scope, ".title", { timeoutMs: 500 });
  assert.deepEqual(seenOpts, { timeout: 500 });
});

test("safeText: a timed-out locator resolves empty rather than throwing", async () => {
  const scope = fakeScope({ innerText: async () => { throw new Error("Timeout 2000ms exceeded"); } });
  assert.equal(await safeText(scope, ".title"), "");
});

test("safeAttr: defaults to a 2000ms locator timeout when none is given", async () => {
  let seenAttr, seenOpts;
  const scope = fakeScope({ getAttribute: async (attr, opts) => { seenAttr = attr; seenOpts = opts; return "href-value"; } });
  const href = await safeAttr(scope, "a.link", "href");
  assert.equal(href, "href-value");
  assert.equal(seenAttr, "href");
  assert.deepEqual(seenOpts, { timeout: 2000 });
});

test("safeAttr: threads a custom timeoutMs through to getAttribute", async () => {
  let seenOpts;
  const scope = fakeScope({ getAttribute: async (attr, opts) => { seenOpts = opts; return null; } });
  await safeAttr(scope, "a.link", "href", { timeoutMs: 500 });
  assert.deepEqual(seenOpts, { timeout: 500 });
});

test("safeAttr: a timed-out locator resolves null rather than throwing", async () => {
  const scope = fakeScope({ getAttribute: async () => { throw new Error("Timeout 2000ms exceeded"); } });
  assert.equal(await safeAttr(scope, "a.link", "href"), null);
});
