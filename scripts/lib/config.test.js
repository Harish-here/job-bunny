// scripts/config.test.js — node:test unit tests for a narrow, safe subset of
// scripts/lib/config.js: paths(name), loadProfile(name), listProfiles(). Read-only
// against the real repo (config.json, profiles/harish, profiles/uvashree) — any
// mutation happens only inside a disposable fixture directory that is created
// and removed by this file. Run with:
//   node --test scripts/config.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { paths, loadProfile, listProfiles, ROOT } from "./config.js";

const FIXTURE_NAME = "__test_configjs__";
const FIXTURE_DIR = join(ROOT, "profiles", FIXTURE_NAME);

test("paths(name) returns pure joins under profiles/<name> (profiles mode)", () => {
  const p = paths("some-fixture-profile");
  assert.ok(p.profileDir.endsWith(join("profiles", "some-fixture-profile")));
  assert.equal(p.resume, join(p.profileDir, "resume.json"));
  assert.equal(p.resumeMeta, join(p.profileDir, "resume_meta.json"));
  assert.equal(p.avoid, join(p.profileDir, "avoid.md"));
  assert.equal(p.filterConfig, join(p.profileDir, "filter_config.json"));
  assert.equal(p.searchUrls, join(p.profileDir, "search_urls.md"));
  assert.equal(p.cache, join(p.profileDir, "data", "cache.json"));

  const dataDir = join(p.profileDir, "data");
  assert.equal(p.jobsRawText, join(dataDir, "jobs_raw_text.json"));
  assert.equal(p.structureInput, join(dataDir, "structure_input.md"));
  assert.equal(p.structurePassthrough, join(dataDir, "structure_passthrough.json"));
  assert.equal(p.decisions, join(dataDir, "jobs_raw_decisions.md"));
  assert.equal(p.checkpoint, join(dataDir, "jobs_raw_checkpoint.md"));
  assert.equal(p.jobsRaw, join(dataDir, "jobs_raw.json"));
  assert.equal(p.filteredJobs, join(dataDir, "filtered_jobs.json"));
  assert.equal(p.newJobs, join(dataDir, "new_jobs.json"));

  // Sanity: profileDir really does end with a path separator + the fixture name segment,
  // not just a string suffix coincidence (e.g. "other-profiles/some-fixture-profile").
  assert.ok(p.profileDir.split(sep).pop() === "some-fixture-profile");
});

test("loadProfile(name) throws for a nonexistent profile", () => {
  assert.throws(
    () => loadProfile("__nonexistent_profile_xyz__"),
    /Cannot read\/parse/
  );
});

test("loadProfile(name) — happy path via disposable fixture", async (t) => {
  t.after(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(
    join(FIXTURE_DIR, "profile.json"),
    JSON.stringify({ notion_db_id: "fake-db-id", notion_parent_page_id: "fake-page-id" }),
    "utf8"
  );

  const profile = loadProfile(FIXTURE_NAME);
  assert.equal(profile.name, FIXTURE_NAME);
  assert.equal(profile.notion_db_id, "fake-db-id");
  assert.equal(profile.notion_parent_page_id, "fake-page-id");
});

test("loadProfile(name) throws when notion_db_id is missing", async (t) => {
  t.after(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(
    join(FIXTURE_DIR, "profile.json"),
    JSON.stringify({ notion_parent_page_id: "fake-page-id" }),
    "utf8"
  );

  assert.throws(() => loadProfile(FIXTURE_NAME), /notion_db_id missing/);
});

test("listProfiles() returns a sorted array", () => {
  const result = listProfiles();
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, [...result].sort());
});
