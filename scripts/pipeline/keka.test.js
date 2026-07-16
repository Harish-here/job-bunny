// scripts/pipeline/keka.test.js — node:test unit tests for keka.js's own Keka-specific pure
// helpers: extractPortalGuid, kekaLocation, mapKekaJob. Everything ATS-agnostic
// (tokenCandidates, verifyBoardName, htmlToText, parseWatchlist, formatWatchlistAppend,
// mergeByJobId, runFetchPhase) lives in ats_common.test.js. No network calls — probeCandidate/
// discoverGuid/fetchBoardJobs/main() aren't exercised here. Needs a fixture profile +
// filter_config.json up front because keka.js imports title_filter.js, which reads its config
// synchronously at module load (same pattern as greenhouse.test.js). Run with:
//   node --test scripts/pipeline/keka.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "../lib/config.js";

const FIXTURE_PROFILE = "__test_keka__";
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

const { extractPortalGuid, kekaLocation, mapKekaJob } = await import("./keka.js");

// --- extractPortalGuid -------------------------------------------------

test("extractPortalGuid finds the uuid in a portal-info JSON string", () => {
  const json = JSON.stringify({
    name: "SURVEYSPARROW PRIVATE LIMITED",
    logoPath: "/ats/documents/a1b2c3d4-e5f6-7890-abcd-ef1234567890/careerportal/logo.png",
  });
  assert.equal(extractPortalGuid(json), "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
});

test("extractPortalGuid finds the uuid in HTML", () => {
  const html =
    '<html><body><img src="/ats/documents/11111111-2222-3333-4444-555555555555/careerportal/bg.jpg"></body></html>';
  assert.equal(extractPortalGuid(html), "11111111-2222-3333-4444-555555555555");
});

test("extractPortalGuid returns null when absent", () => {
  assert.equal(extractPortalGuid("<html>no guid here</html>"), null);
  assert.equal(extractPortalGuid(""), null);
  assert.equal(extractPortalGuid(undefined), null);
});

test("extractPortalGuid is case-insensitive", () => {
  const html = "/ats/documents/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE/careerportal/bg.jpg";
  assert.equal(extractPortalGuid(html), "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
});

// --- kekaLocation --------------------------------------------------------

test("kekaLocation joins unique cities", () => {
  const job = { jobLocations: [{ city: "Chennai" }, { city: "Bangalore" }] };
  assert.equal(kekaLocation(job), "Chennai, Bangalore");
});

test("kekaLocation dedups repeated city", () => {
  const job = { jobLocations: [{ city: "Chennai" }, { city: "Chennai" }] };
  assert.equal(kekaLocation(job), "Chennai");
});

test("kekaLocation falls back to .name when city missing", () => {
  const job = { jobLocations: [{ name: "Remote - India" }] };
  assert.equal(kekaLocation(job), "Remote - India");
});

test("kekaLocation returns null for empty or missing jobLocations", () => {
  assert.equal(kekaLocation({ jobLocations: [] }), null);
  assert.equal(kekaLocation({}), null);
  assert.equal(kekaLocation(null), null);
});

// --- mapKekaJob ----------------------------------------------------------

test("mapKekaJob produces the full extract.js record shape with the kk- id prefix", () => {
  const job = {
    id: 98765,
    title: "Staff Backend Engineer",
    description: "<p>Great <b>role</b></p>",
    experience: "3- 5 years",
    jobLocations: [{ city: "Chennai" }],
  };
  const board = { name: "SurveySparrow", token: "surveysparrow" };
  const rec = mapKekaJob(job, board, "2026-07-16");

  assert.deepEqual(rec, {
    job_id: "kk-98765",
    job_url: "https://surveysparrow.keka.com/careers/jobdetails/98765",
    source_query_url: "https://surveysparrow.keka.com/careers",
    raw_text: "Experience: 3- 5 years. Great role",
    date_found: "2026-07-16",
    card_title: "Staff Backend Engineer",
    card_company: "SurveySparrow",
    card_location: "Chennai",
  });
});

test("mapKekaJob omits the experience prefix when experience is an empty string", () => {
  const job = { id: 1, title: "t", description: "text", experience: "", jobLocations: [] };
  const rec = mapKekaJob(job, { name: "Acme", token: "acme" }, "2026-07-16");
  assert.equal(rec.raw_text, "text");
});

test("mapKekaJob omits the experience prefix when experience is null", () => {
  const job = { id: 1, title: "t", description: "text", experience: null, jobLocations: [] };
  const rec = mapKekaJob(job, { name: "Acme", token: "acme" }, "2026-07-16");
  assert.equal(rec.raw_text, "text");
});

test("mapKekaJob trims raw_text to JD_MAX_CHARS after the experience prefix is applied", () => {
  const prevEnv = process.env.JD_MAX_CHARS;
  process.env.JD_MAX_CHARS = "10";
  try {
    const job = { id: 1, title: "t", description: "0123456789ABCDEF", experience: "1- 3 years", jobLocations: [] };
    const rec = mapKekaJob(job, { name: "Acme", token: "acme" }, "2026-07-16");
    // "Experience: 1- 3 years. " is well over 10 chars, so the trim to 10 lands inside the prefix.
    assert.equal(rec.raw_text, "Experience".slice(0, 10));
    assert.equal(rec.raw_text.length, 10);
  } finally {
    if (prevEnv === undefined) delete process.env.JD_MAX_CHARS;
    else process.env.JD_MAX_CHARS = prevEnv;
  }
});

test("mapKekaJob card_location comes from kekaLocation", () => {
  const job = { id: 1, title: "t", description: "text", experience: "", jobLocations: [{ name: "Remote" }] };
  const rec = mapKekaJob(job, { name: "Acme", token: "acme" }, "2026-07-16");
  assert.equal(rec.card_location, "Remote");
});
