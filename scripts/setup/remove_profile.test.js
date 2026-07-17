// scripts/setup/remove_profile.test.js — node:test unit tests for the pure
// stripProfilePermissions helper (no I/O). main() and real file I/O are out of scope. Run with:
//   node --test scripts/setup/remove_profile.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripProfilePermissions } from "./remove_profile.js";

test("stripProfilePermissions strips a matching entry", () => {
  const allow = [
    "Bash(node *)",
    "Bash(JOBBUNNY_PROFILE=uvashree node *)",
  ];
  const kept = stripProfilePermissions(allow, "uvashree");
  assert.deepEqual(kept, ["Bash(node *)"]);
});

test("stripProfilePermissions leaves entries for other profiles/unrelated entries untouched", () => {
  const allow = [
    "Bash(node *)",
    "Bash(JOBBUNNY_PROFILE=uvashree node *)",
    "Bash(JOBBUNNY_PROFILE=harish node *)",
    "Bash(git checkout *)",
  ];
  const kept = stripProfilePermissions(allow, "uvashree");
  assert.deepEqual(kept, [
    "Bash(node *)",
    "Bash(JOBBUNNY_PROFILE=harish node *)",
    "Bash(git checkout *)",
  ]);
});

test("stripProfilePermissions is a no-op when nothing matches", () => {
  const allow = ["Bash(node *)", "Bash(git checkout *)"];
  const kept = stripProfilePermissions(allow, "uvashree");
  assert.deepEqual(kept, allow);
});

test("stripProfilePermissions handles an empty array", () => {
  assert.deepEqual(stripProfilePermissions([], "uvashree"), []);
});

test("stripProfilePermissions handles a missing/undefined allow list", () => {
  assert.deepEqual(stripProfilePermissions(undefined, "uvashree"), []);
});
