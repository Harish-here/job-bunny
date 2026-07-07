import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PROFILE = "__test_titlefilter__";
const FIXTURE_DIR = join(ROOT, "profiles", FIXTURE_PROFILE);

await mkdir(FIXTURE_DIR, { recursive: true });
await writeFile(join(FIXTURE_DIR, "filter_config.json"), JSON.stringify({
  title_filter: {
    seniority: ["staff", "lead", "senior"],
    domain: ["frontend", "backend", "full stack"],
    function: { allow: ["engineer", "architect"], block: ["intern", "sales"] },
  },
}));
process.env.JOBBUNNY_PROFILE = FIXTURE_PROFILE;

const { filterByTitle } = await import("./title_filter.js");

test("rejects a title with a function.block term regardless of other matches", () => {
  const { pass, reason } = filterByTitle("Senior Backend Sales Engineer");
  assert.equal(pass, false);
  assert.match(reason, /blocked function: sales/);
});

test("rejects a title with no seniority term", () => {
  const { pass, reason } = filterByTitle("Backend Engineer");
  assert.equal(pass, false);
  assert.equal(reason, "no seniority match");
});

test("rejects a title with seniority but no domain term", () => {
  const { pass, reason } = filterByTitle("Senior Engineer");
  assert.equal(pass, false);
  assert.equal(reason, "no domain match");
});

test("passes a title with seniority + domain + function.allow, reason includes all three", () => {
  const { pass, reason } = filterByTitle("Senior Backend Engineer");
  assert.equal(pass, true);
  assert.equal(reason, "seniority: senior, domain: backend, function: engineer");
});

test("passes a title with seniority + domain but no function.allow term, omitting the function part", () => {
  const { pass, reason } = filterByTitle("Senior Backend Manager");
  assert.equal(pass, true);
  assert.equal(reason, "seniority: senior, domain: backend");
  assert.doesNotMatch(reason, /function/);
});

test("matches a hyphenated multi-word title against a space-separated config domain term", () => {
  const { pass, reason } = filterByTitle("Staff Full-Stack Architect");
  assert.equal(pass, true);
  assert.match(reason, /domain: full stack/);
});

test("matching is case-insensitive", () => {
  const { pass, reason } = filterByTitle("STAFF FRONTEND ARCHITECT");
  assert.equal(pass, true);
  assert.equal(reason, "seniority: staff, domain: frontend, function: architect");
});

test.after(async () => {
  delete process.env.JOBBUNNY_PROFILE;
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});
