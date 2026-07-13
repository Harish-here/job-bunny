// scripts/lib/env_file.test.js — node:test unit tests for the shared .env helpers.
// Uses a temp file, never touches the real .env. Run with:
//   node --test scripts/lib/env_file.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFile, writeEnvKey } from "./env_file.js";

const DIR = await mkdtemp(join(tmpdir(), "jobbunny-env-"));

test("readEnvFile returns {} for a missing file", async () => {
  const p = join(DIR, "missing.env");
  assert.deepEqual(await readEnvFile(p), {});
});

test("writeEnvKey appends a new key to an empty/missing file", async () => {
  const p = join(DIR, "append.env");
  await writeEnvKey("NOTION_TOKEN", "abc123", p);
  const env = await readEnvFile(p);
  assert.equal(env.NOTION_TOKEN, "abc123");
});

test("writeEnvKey replaces an existing key in place rather than duplicating it", async () => {
  const p = join(DIR, "replace.env");
  await writeEnvKey("NOTION_TOKEN", "first", p);
  await writeEnvKey("TELEGRAM_BOT_TOKEN", "shared", p);
  await writeEnvKey("NOTION_TOKEN", "second", p);
  const env = await readEnvFile(p);
  assert.equal(env.NOTION_TOKEN, "second");
  assert.equal(env.TELEGRAM_BOT_TOKEN, "shared");
  const raw = await readFile(p, "utf8");
  assert.equal((raw.match(/^NOTION_TOKEN=/gm) || []).length, 1);
});

test.after(async () => {
  await rm(DIR, { recursive: true, force: true });
});
