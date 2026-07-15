// scripts/lib/browser.test.js — pure-function unit tests for browser.js (no real Chrome, no
// network, no child_process). Run with: node --test scripts/lib/browser.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEtimeToMs, decideChromeAction, CHROME_MAX_AGE_MS } from "./browser.js";

// --- parseEtimeToMs --------------------------------------------------------

test("parseEtimeToMs parses bare seconds", () => {
  assert.equal(parseEtimeToMs("45"), 45_000);
});

test("parseEtimeToMs parses MM:SS", () => {
  assert.equal(parseEtimeToMs("12:34"), (12 * 60 + 34) * 1000);
});

test("parseEtimeToMs parses HH:MM:SS", () => {
  assert.equal(parseEtimeToMs("1:02:03"), ((1 * 60 + 2) * 60 + 3) * 1000);
});

test("parseEtimeToMs parses DD-HH:MM:SS", () => {
  assert.equal(parseEtimeToMs("2-03:04:05"), (((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1000);
});

// --- decideChromeAction -----------------------------------------------------

test("decideChromeAction: unreachable → launch", () => {
  assert.equal(decideChromeAction({ reachable: false, ageMs: null }), "launch");
  assert.equal(decideChromeAction({ reachable: false, ageMs: 1000 }), "launch");
});

test("decideChromeAction: reachable + ageMs null → reuse", () => {
  assert.equal(decideChromeAction({ reachable: true, ageMs: null }), "reuse");
});

test("decideChromeAction: reachable + young → reuse", () => {
  assert.equal(decideChromeAction({ reachable: true, ageMs: 1000 }), "reuse");
  assert.equal(decideChromeAction({ reachable: true, ageMs: CHROME_MAX_AGE_MS }), "reuse");
});

test("decideChromeAction: reachable + old → recycle", () => {
  assert.equal(decideChromeAction({ reachable: true, ageMs: CHROME_MAX_AGE_MS + 1 }), "recycle");
});

test("decideChromeAction: respects a custom maxAgeMs override", () => {
  assert.equal(decideChromeAction({ reachable: true, ageMs: 5000, maxAgeMs: 1000 }), "recycle");
  assert.equal(decideChromeAction({ reachable: true, ageMs: 500, maxAgeMs: 1000 }), "reuse");
});
