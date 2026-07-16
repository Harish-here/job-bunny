// scripts/pipeline/greenhouse.test.js — node:test unit tests for greenhouse.js's own
// Greenhouse-specific pure helper, mapGhJob. Everything ATS-agnostic (tokenCandidates,
// verifyBoardName, htmlToText, parseWatchlist, formatWatchlistAppend, mergeByJobId,
// runFetchPhase) now lives in ats_common.test.js. No network calls — probeCandidate/main()
// aren't exercised here. Needs a fixture profile + filter_config.json up front because
// greenhouse.js imports title_filter.js, which reads its config synchronously at module load
// (same pattern as scripts/title_filter.test.js). Run with:
//   node --test scripts/pipeline/greenhouse.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "../lib/config.js";

const FIXTURE_PROFILE = "__test_greenhouse__";
const FIXTURE_DIR = join(ROOT, "profiles", FIXTURE_PROFILE);

await mkdir(FIXTURE_DIR, { recursive: true });
await writeFile(
  join(FIXTURE_DIR, "filter_config.json"),
  JSON.stringify({
    title_filter: {
      seniority: ["staff", "lead", "senior"],
      domain: ["frontend", "backend", "full stack"],
      function: { allow: ["engineer", "architect"], block: ["intern", "sales"] },
    },
  })
);
process.env.JOBBUNNY_PROFILE = FIXTURE_PROFILE;

test.after(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

const { mapGhJob } = await import("./greenhouse.js");

// --- mapGhJob ---------------------------------------------------------

test("mapGhJob produces the full extract.js record shape with the gh- id prefix", () => {
  const job = {
    id: 12345,
    absolute_url: "https://boards.greenhouse.io/acme/jobs/12345",
    content: "<p>Great <b>role</b></p>",
    title: "Staff Backend Engineer",
    location: { name: "Chennai, India" },
  };
  const board = { name: "Acme Robotics", token: "acme" };
  const rec = mapGhJob(job, board, "2026-07-07");

  assert.deepEqual(rec, {
    job_id: "gh-12345",
    job_url: "https://boards.greenhouse.io/acme/jobs/12345",
    source_query_url: "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
    raw_text: "Great role",
    date_found: "2026-07-07",
    card_title: "Staff Backend Engineer",
    card_company: "Acme Robotics",
    card_location: "Chennai, India",
  });
});

test("mapGhJob maps a missing location to null", () => {
  const job = { id: 1, absolute_url: "https://x", content: "text", title: "t", location: null };
  const rec = mapGhJob(job, { name: "Acme", token: "acme" }, "2026-07-07");
  assert.equal(rec.card_location, null);
});

test("mapGhJob trims raw_text to JD_MAX_CHARS", () => {
  const prevEnv = process.env.JD_MAX_CHARS;
  process.env.JD_MAX_CHARS = "10";
  try {
    const job = { id: 1, absolute_url: "https://x", content: "0123456789ABCDEF", title: "t", location: null };
    const rec = mapGhJob(job, { name: "Acme", token: "acme" }, "2026-07-07");
    assert.equal(rec.raw_text, "0123456789");
  } finally {
    if (prevEnv === undefined) delete process.env.JD_MAX_CHARS;
    else process.env.JD_MAX_CHARS = prevEnv;
  }
});
