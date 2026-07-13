// scripts/lib/io.test.js — node:test unit tests for the shared JSON helpers. Uses a
// temp dir, no profile required. Run with: node --test scripts/lib/io.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "./io.js";

const DIR = await mkdtemp(join(tmpdir(), "jobbunny-io-"));

test("writeJson → readJson round-trips and writes 2-space + trailing newline", async () => {
  const p = join(DIR, "roundtrip.json");
  const data = { a: 1, b: ["x", "y"], c: { nested: true } };
  await writeJson(p, data);
  const raw = await readFile(p, "utf8");
  assert.equal(raw, JSON.stringify(data, null, 2) + "\n");
  assert.deepEqual(await readJson(p), data);
});

test("readJson throws Cannot read/parse for a missing file", async () => {
  const p = join(DIR, "missing.json");
  await assert.rejects(() => readJson(p), new RegExp(`Cannot read/parse ${p.replaceAll("/", "\\/")}:`));
});

test("readJson throws Cannot read/parse for invalid JSON", async () => {
  const p = join(DIR, "invalid.json");
  await writeFile(p, "{ not json");
  await assert.rejects(() => readJson(p), /Cannot read\/parse .*invalid\.json:/);
});

test("readJson includes the context hint in parentheses", async () => {
  const p = join(DIR, "ctx.json");
  await assert.rejects(() => readJson(p, "run generate_meta.js first"), /\(run generate_meta\.js first\):/);
});

test.after(async () => {
  await rm(DIR, { recursive: true, force: true });
});
