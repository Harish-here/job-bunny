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
}));

// filter.js has no import.meta guard around its main() — importing it always runs the
// script's file-based pipeline as a side effect. Seed a minimal jobs_raw.json + resume_meta.json
// in the fixture profile's data/ dir so that side-effecting run completes harmlessly (empty
// input → empty output) instead of throwing/exiting; it is not exercised by these unit tests.
const FIXTURE_DATA_DIR = join(FIXTURE_DIR, "data");
await mkdir(FIXTURE_DATA_DIR, { recursive: true });
await writeFile(join(FIXTURE_DATA_DIR, "jobs_raw.json"), "[]");
await writeFile(join(FIXTURE_DIR, "resume_meta.json"), JSON.stringify({ location: "Bengaluru" }));

process.env.JOBBUNNY_PROFILE = FIXTURE_PROFILE;

const { dropReason } = await import("./filter.js");

test("on-site job in a different city is dropped, reason mentions on-site outside + city", () => {
  const job = {
    job_title: "Staff Software Engineer",
    work_type: "On-site",
    location_city: "Mumbai",
  };
  const reason = dropReason(job, "Bengaluru");
  assert.ok(reason, "expected a drop reason");
  assert.match(reason, /on-site outside/);
  assert.match(reason, /Mumbai/);
});

test("on-site job in the same city (different case/whitespace) is not dropped by location rule", () => {
  const job = {
    job_title: "Staff Software Engineer",
    work_type: "On-site",
    location_city: "  bengaluru  ",
  };
  const reason = dropReason(job, "Bengaluru");
  assert.equal(reason, null);
});

test("remote job with explicit incompatible hours is dropped", () => {
  const job = {
    job_title: "Staff Software Engineer",
    work_type: "Remote",
    timezone_incompatible: true,
  };
  const reason = dropReason(job, "Bengaluru");
  assert.equal(reason, "remote with explicit incompatible hours");
});

test("remote job with timezone_incompatible false is not dropped by that rule", () => {
  const job = {
    job_title: "Staff Software Engineer",
    work_type: "Remote",
    timezone_incompatible: false,
  };
  const reason = dropReason(job, "Bengaluru");
  assert.equal(reason, null);
});

test("remote job with timezone_incompatible absent is not dropped by that rule", () => {
  const job = {
    job_title: "Staff Software Engineer",
    work_type: "Remote",
  };
  const reason = dropReason(job, "Bengaluru");
  assert.equal(reason, null);
});

test("job passing location/remote checks but failing title gate returns title-filter's reason", () => {
  const job = {
    job_title: "Intern",
    work_type: "Remote",
  };
  const reason = dropReason(job, "Bengaluru");
  assert.equal(reason, "no seniority match");
});

test("job passing everything returns null", () => {
  const job = {
    job_title: "Staff Software Engineer",
    work_type: "On-site",
    location_city: "Bengaluru",
  };
  const reason = dropReason(job, "Bengaluru");
  assert.equal(reason, null);
});

test("on-site job matching the SECOND city of a multi-city home location is kept", () => {
  const job = {
    job_title: "Staff Software Engineer",
    work_type: "On-site",
    location_city: "Chennai",
  };
  const reason = dropReason(job, ["Bengaluru", "Chennai"]);
  assert.equal(reason, null);
});

test("on-site job outside ALL cities of a multi-city home location is dropped, reason lists all cities", () => {
  const job = {
    job_title: "Staff Software Engineer",
    work_type: "On-site",
    location_city: "Mumbai",
  };
  const reason = dropReason(job, ["Bengaluru", "Chennai"]);
  assert.ok(reason, "expected a drop reason");
  assert.match(reason, /on-site outside Bengaluru\/Chennai/);
  assert.match(reason, /Mumbai/);
});

test.after(async () => {
  delete process.env.JOBBUNNY_PROFILE;
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});
