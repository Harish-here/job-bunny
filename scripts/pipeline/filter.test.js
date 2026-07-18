// scripts/pipeline/filter.test.js — node:test unit tests for filter.js's contribution: mapping a
// structured job record (assemble.js shape) into the jd_filter.js canonical model, then running
// it through the real engine (loadFilterContext() + evaluate()). Rule internals (avoid/title/
// location/remote_country/remote_timezone/core_skill) are exhaustively covered by
// jd_filter.test.js — these tests exist to prove the Stage B field mapping is correct and that
// the classic Stage B scenarios (on-site outside home, remote tz-incompatible, title gate) still
// drop when routed through filter.js's own mapping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "../lib/config.js";

const FIXTURE_PROFILE = "__test_filterjs__";
const FIXTURE_DIR = join(ROOT, "profiles", FIXTURE_PROFILE);

await mkdir(FIXTURE_DIR, { recursive: true });
// Deliberately permissive title-filter config so titles used in this file's location/remote
// tests always pass the title gate — the title-gate itself is covered by title_filter.test.js.
await writeFile(join(FIXTURE_DIR, "filter_config.json"), JSON.stringify({
  title_filter: {
    seniority: ["staff", "senior", "lead"],
    domain: ["engineer", "engineering"],
    function: { allow: [], block: [] },
  },
  locations: [
    { city: "Bengaluru", country: "India", accept: ["On-site", "Hybrid"] },
    { city: "Chennai", country: "India", accept: ["On-site", "Hybrid"] },
  ],
  home_country: "India",
  remote: {
    eligible_countries: ["India"],
    timezones: { acceptable: ["APAC"], borderline: ["EMEA"] },
  },
}));
await writeFile(join(FIXTURE_DIR, "avoid.md"), "");
await writeFile(join(FIXTURE_DIR, "resume_meta.json"), JSON.stringify({
  location: ["Bengaluru", "Chennai"],
  core_skills: ["React"],
  secondary_skills: [],
}));

// filter.js has an import.meta guard around main() (isMain) — importing it is side-effect-free
// under node --test. A minimal jobs_raw.json is still seeded for parity with other pipeline
// fixture profiles, though it is not read by these unit tests.
const FIXTURE_DATA_DIR = join(FIXTURE_DIR, "data");
await mkdir(FIXTURE_DATA_DIR, { recursive: true });
await writeFile(join(FIXTURE_DATA_DIR, "jobs_raw.json"), "[]");

process.env.JOBBUNNY_PROFILE = FIXTURE_PROFILE;

const { toCanonicalJd } = await import("./filter.js");
const { loadFilterContext, evaluate } = await import("./jd_filter.js");

const ctx = await loadFilterContext();

const job = (over = {}) => ({
  job_title: "Staff Software Engineer",
  company_name: "Acme Inc",
  key_skills: [],
  work_type: "On-site",
  location_city: "Bengaluru",
  country: "India",
  timezone_compatibility: null,
  timezone_incompatible: false,
  ...over,
});

// --- field mapping --------------------------------------------------------------------------

test("toCanonicalJd maps every structured-job field to the jd_filter canonical model", () => {
  const jd = toCanonicalJd(job({
    job_title: "Staff Frontend Engineer",
    company_name: "Globex",
    key_skills: ["React", "TypeScript"],
    work_type: "Remote",
    location_city: "Mumbai",
    country: "United States",
    timezone_compatibility: "APAC",
    timezone_incompatible: true,
  }));
  assert.deepEqual(jd, {
    title: "Staff Frontend Engineer",
    company: "Globex",
    skills: ["React", "TypeScript"],
    work_type: "Remote",
    city: "Mumbai",
    country: "United States",
    timezone: "APAC",
    tz_bad: true,
  });
});

// --- classic Stage B scenarios, now routed through the engine -------------------------------

test("on-site job in a non-home city is dropped, reason mentions On-site + city", () => {
  const jd = toCanonicalJd(job({ work_type: "On-site", location_city: "Mumbai", country: "India" }));
  const { drop, reasons } = evaluate(jd, ctx, { severity: "normal" });
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /On-site in Mumbai/);
});

test("on-site job in a home city (second entry of a multi-city home location) is kept", () => {
  const jd = toCanonicalJd(job({ work_type: "On-site", location_city: "Chennai", country: "India" }));
  const { drop } = evaluate(jd, ctx, { severity: "normal" });
  assert.equal(drop, false);
});

test("remote job with explicit incompatible hours (tz_bad) is dropped", () => {
  const jd = toCanonicalJd(job({ work_type: "Remote", timezone_incompatible: true }));
  const { drop, reasons } = evaluate(jd, ctx, { severity: "normal" });
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /tz_bad/);
});

test("remote job with timezone_incompatible false and no timezone is not dropped by the timezone rule", () => {
  const jd = toCanonicalJd(job({ work_type: "Remote", timezone_incompatible: false }));
  const { drop, reasons } = evaluate(jd, ctx, { severity: "normal" });
  assert.equal(drop, false);
  assert.deepEqual(reasons, []);
});

test("job passing location/remote checks but failing the title gate is dropped with title-filter's reason", () => {
  const jd = toCanonicalJd(job({ job_title: "Intern", work_type: "On-site", location_city: "Bengaluru" }));
  const { drop, reasons } = evaluate(jd, ctx, { severity: "normal" });
  assert.equal(drop, true);
  assert.match(reasons.join(" "), /no seniority match/);
});

test("job passing every rule is kept with an empty flags array", () => {
  const jd = toCanonicalJd(job({ work_type: "On-site", location_city: "Bengaluru" }));
  const { drop, flags } = evaluate(jd, ctx, { severity: "normal" });
  assert.equal(drop, false);
  assert.deepEqual(flags, []);
});

test.after(async () => {
  delete process.env.JOBBUNNY_PROFILE;
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});
