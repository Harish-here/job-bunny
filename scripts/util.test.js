// scripts/util.test.js — node:test unit tests for the pure helpers in util.js
// (no I/O, no network — fast, deterministic). Run with:
//   node --test scripts/util.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, extractJobId, dedupKey } from "./util.js";

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
