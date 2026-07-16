// scripts/lib/util.test.js — node:test unit tests for the pure helpers in util.js
// (no I/O, no network — fast, deterministic). Run with:
//   node --test scripts/util.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, extractJobId, dedupKey, repostKey, homeLocations, isHomeCity } from "./util.js";

// --- normalizeName ---------------------------------------------------------

test("normalizeName returns empty string for falsy input", () => {
  assert.equal(normalizeName(undefined), "");
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName(""), "");
});

test("normalizeName strips a single trailing suffix", () => {
  assert.equal(normalizeName("Acme Inc"), "acme");
});

test("normalizeName repeatedly strips multiple stackable suffixes in one call", () => {
  // "software" and "solutions" are both entries in SUFFIXES. On the first inner pass
  // only the trailing "solutions" matches (s currently ends with " solutions", not
  // " software"); stripping it exposes a new trailing "software", which the next pass
  // (the while-loop repeating because changed=true) then strips too — all within this
  // single normalizeName() call.
  assert.equal(normalizeName("Acme Software Solutions"), "acme");
});

test("normalizeName strips the whole string when it IS only a suffix word (s === suf branch)", () => {
  assert.equal(normalizeName("Ltd"), "");
});

test("normalizeName replaces periods and commas with spaces before collapsing whitespace", () => {
  assert.equal(normalizeName("Acme, Inc."), "acme");
});

test("normalizeName leaves an already-normalized name with no suffix unchanged", () => {
  assert.equal(normalizeName("acme robotics"), "acme robotics");
});

// --- extractJobId ------------------------------------------------------------

test("extractJobId returns null for falsy/undefined url", () => {
  assert.equal(extractJobId(undefined), null);
  assert.equal(extractJobId(null), null);
  assert.equal(extractJobId(""), null);
});

test("extractJobId captures a plain numeric id", () => {
  assert.equal(extractJobId("https://www.linkedin.com/jobs/view/1234567890/"), "1234567890");
});

test("extractJobId stops the capture at a trailing query string", () => {
  assert.equal(
    extractJobId("https://www.linkedin.com/jobs/view/1234567890/?refId=abc&trk=xyz"),
    "1234567890",
  );
});

test("extractJobId stops the capture at a trailing fragment", () => {
  assert.equal(
    extractJobId("https://www.linkedin.com/jobs/view/987654321#section-header"),
    "987654321",
  );
});

test("extractJobId returns null when the url has no /jobs/view/ segment", () => {
  assert.equal(
    extractJobId("https://www.linkedin.com/jobs/collections/recommended/"),
    null,
  );
});

test("extractJobId parses a Keka jobdetails URL as kk-<id>", () => {
  assert.equal(
    extractJobId("https://surveysparrow.keka.com/careers/jobdetails/31541"),
    "kk-31541",
  );
  assert.equal(
    extractJobId("https://acme.keka.com/careers/jobdetails/123?src=x"),
    "kk-123",
  );
});

test("extractJobId returns null for a keka.com URL without a jobdetails id", () => {
  assert.equal(extractJobId("https://surveysparrow.keka.com/careers/"), null);
});

test("extractJobId parses a Greenhouse-hosted board URL as gh-<id>", () => {
  assert.equal(
    extractJobId("https://job-boards.greenhouse.io/agoda/jobs/6161339"),
    "gh-6161339",
  );
});

test("extractJobId parses an embedded-board gh_jid param as gh-<id>", () => {
  assert.equal(
    extractJobId("https://www.netskope.com/company/careers/open-positions/?gh_jid=7597616"),
    "gh-7597616",
  );
  // gh_jid wins even when the path also carries the numeric id
  assert.equal(
    extractJobId("https://www.coinbase.com/careers/positions/7366208?gh_jid=7366208"),
    "gh-7366208",
  );
});

test("extractJobId does NOT treat a non-greenhouse /jobs/<n> path as a Greenhouse id", () => {
  assert.equal(extractJobId("https://example.com/company/jobs/12345"), null);
});

// --- dedupKey ------------------------------------------------------------

test("dedupKey uses job_id directly when present", () => {
  assert.equal(dedupKey({ job_id: "555", job_url: "ignored", job_title: "x", company_name: "y" }), "id:555");
});

test("dedupKey falls back to extractJobId(job_url) when job_id is absent", () => {
  assert.equal(
    dedupKey({ job_url: "https://www.linkedin.com/jobs/view/42424242/", job_title: "x", company_name: "y" }),
    "id:42424242",
  );
});

test("dedupKey falls back to normalized role+company when neither job_id nor a parseable job_url is present", () => {
  assert.equal(
    dedupKey({ job_title: "Senior Backend Engineer", company_name: "Acme Inc" }),
    "rc:senior backend engineer::acme",
  );
});

// --- repostKey ------------------------------------------------------------

test("repostKey ignores job_id — same role+company+city yields the same key across fresh ids", () => {
  const a = { job_id: "111", job_title: "Staff Engineer", company_name: "Acme Inc", location_city: "Chennai" };
  const b = { job_id: "222", job_title: "Staff Engineer", company_name: "Acme Inc", location_city: "Chennai" };
  assert.equal(repostKey(a), repostKey(b));
});

test("repostKey normalizes case, punctuation, and legal suffixes on every part", () => {
  assert.equal(
    repostKey({ job_title: "Staff Engineer", company_name: "Acme, Inc.", location_city: "Chennai" }),
    repostKey({ job_title: "STAFF ENGINEER", company_name: "acme", location_city: "chennai" }),
  );
});

test("repostKey differs when only the city differs — two openings, not a repost", () => {
  const chennai = { job_title: "Staff Engineer", company_name: "Acme", location_city: "Chennai" };
  const bangalore = { job_title: "Staff Engineer", company_name: "Acme", location_city: "Bangalore" };
  assert.notEqual(repostKey(chennai), repostKey(bangalore));
});

test("repostKey treats null and empty location_city as the same (both normalize to empty)", () => {
  assert.equal(
    repostKey({ job_title: "Staff Engineer", company_name: "Acme", location_city: null }),
    repostKey({ job_title: "Staff Engineer", company_name: "Acme", location_city: "" }),
  );
});

// --- homeLocations / isHomeCity ------------------------------------------------

test("homeLocations wraps a single string into a one-element array", () => {
  assert.deepEqual(homeLocations("Bengaluru"), ["Bengaluru"]);
});

test("homeLocations passes through an array of strings unchanged", () => {
  assert.deepEqual(homeLocations(["Bengaluru", "Chennai"]), ["Bengaluru", "Chennai"]);
});

test("homeLocations throws for undefined/null/missing location", () => {
  assert.throws(() => homeLocations(undefined), /non-empty string or a non-empty array/);
  assert.throws(() => homeLocations(null), /non-empty string or a non-empty array/);
});

test("homeLocations throws for an empty string", () => {
  assert.throws(() => homeLocations(""), /non-empty string or a non-empty array/);
});

test("homeLocations throws for an empty array", () => {
  assert.throws(() => homeLocations([]), /non-empty string or a non-empty array/);
});

test("homeLocations throws for an array containing a non-string", () => {
  assert.throws(() => homeLocations(["Bengaluru", 42]), /non-empty string or a non-empty array/);
});

test("homeLocations throws for an array containing an empty string", () => {
  assert.throws(() => homeLocations(["Bengaluru", ""]), /non-empty string or a non-empty array/);
});

test("homeLocations throws for a non-string, non-array value (e.g. a number or object)", () => {
  assert.throws(() => homeLocations(42), /non-empty string or a non-empty array/);
  assert.throws(() => homeLocations({ city: "Bengaluru" }), /non-empty string or a non-empty array/);
});

test("isHomeCity matches a single-string home location, case/whitespace-insensitive", () => {
  assert.equal(isHomeCity("bengaluru ", "Bengaluru"), true);
  assert.equal(isHomeCity("Chennai", "Bengaluru"), false);
});

test("isHomeCity matches ANY city in a multi-city home location array", () => {
  const home = ["Bengaluru", "Chennai"];
  assert.equal(isHomeCity("Chennai", home), true);
  assert.equal(isHomeCity("Bengaluru", home), true);
  assert.equal(isHomeCity("Pune", home), false);
});

test("isHomeCity propagates homeLocations' shape error for an invalid location", () => {
  assert.throws(() => isHomeCity("Bengaluru", ["Bengaluru", 42]), /non-empty string or a non-empty array/);
});
