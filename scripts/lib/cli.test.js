// scripts/lib/cli.test.js — node:test unit tests for the shared CLI helpers.
// Run with: node --test scripts/lib/cli.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { isMain, parseFlags } from "./cli.js";

// node:test spawns each test file as its own process entrypoint, so this file's own
// import.meta.url legitimately equals file://argv[1] here — that's the same mechanism
// every guarded script relies on. Test isMain against synthetic URLs instead, so the
// assertions don't depend on the runner's own entrypoint semantics.
test("isMain is true when the given URL matches file://argv[1]", () => {
  assert.equal(isMain(`file://${process.argv[1]}`), true);
});

test("isMain is false for a URL that isn't the process entrypoint", () => {
  assert.equal(isMain("file:///not/the/entrypoint.js"), false);
});

test("parseFlags maps --flag value pairs", () => {
  const { flags, positional } = parseFlags(["--severity", "info", "--title", "t", "--body", "hello world"]);
  assert.deepEqual(flags, { severity: "info", title: "t", body: "hello world" });
  assert.deepEqual(positional, []);
});

test("parseFlags keeps non-flag args as positional", () => {
  const { flags, positional } = parseFlags(["harish", "--status", "success"]);
  assert.deepEqual(flags, { status: "success" });
  assert.deepEqual(positional, ["harish"]);
});

test("parseFlags gives undefined for a trailing flag with no value", () => {
  const { flags } = parseFlags(["--status"]);
  assert.equal("status" in flags, true);
  assert.equal(flags.status, undefined);
});
