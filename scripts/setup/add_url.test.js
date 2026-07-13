// scripts/setup/add_url.test.js — node:test unit tests for the pure URL helpers
// (no I/O — fast, deterministic). main() is out of scope (real file I/O). Run with:
//   node --test scripts/add_url.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripEphemerals, resolvePage } from "./add_url.js";

test("stripEphemerals removes all ephemeral params when several are present", () => {
  const raw =
    "https://www.linkedin.com/jobs/search/?keywords=engineer" +
    "&currentJobId=123&referralSearchId=abc&origin=JOB_SEARCH_PAGE" +
    "&originToLandingJobPostings=456&savedSearchId=789&alertAction=viewjob" +
    "&trackingId=xyz&refId=def&eBP=ghi&start=25";
  const u = stripEphemerals(raw);
  for (const p of [
    "currentJobId", "referralSearchId", "origin", "originToLandingJobPostings",
    "savedSearchId", "alertAction", "trackingId", "refId", "eBP", "start",
  ]) {
    assert.equal(u.searchParams.has(p), false, `expected ${p} to be stripped`);
  }
  assert.equal(u.searchParams.get("keywords"), "engineer");
});

test("stripEphemerals deletes an absolute f_TPR anchor (a<epoch>-)", () => {
  const u = stripEphemerals("https://www.linkedin.com/jobs/search/?f_TPR=a1700000000-&keywords=engineer");
  assert.equal(u.searchParams.has("f_TPR"), false);
  assert.equal(u.searchParams.get("keywords"), "engineer");
});

test("stripEphemerals keeps a relative f_TPR window (r<seconds>) unchanged", () => {
  const u = stripEphemerals("https://www.linkedin.com/jobs/search/?f_TPR=r86400&keywords=engineer");
  assert.equal(u.searchParams.get("f_TPR"), "r86400");
});

test("stripEphemerals leaves stable/non-ephemeral params untouched", () => {
  const u = stripEphemerals("https://www.linkedin.com/jobs/search/?keywords=engineer&location=Remote&f_WT=2");
  assert.equal(u.searchParams.get("keywords"), "engineer");
  assert.equal(u.searchParams.get("location"), "Remote");
  assert.equal(u.searchParams.get("f_WT"), "2");
});

test("stripEphemerals does not throw and returns the URL essentially unchanged when no ephemeral params present", () => {
  const raw = "https://www.linkedin.com/jobs/search/?keywords=engineer&location=Remote";
  let u;
  assert.doesNotThrow(() => { u = stripEphemerals(raw); });
  assert.equal(u.searchParams.get("keywords"), "engineer");
  assert.equal(u.searchParams.get("location"), "Remote");
  assert.equal(u.searchParams.toString(), new URL(raw).searchParams.toString());
});

test("resolvePage maps /jobs/search and /jobs/search/ to linkedin__jobs-search", () => {
  assert.deepEqual(resolvePage(new URL("https://www.linkedin.com/jobs/search")), {
    channel: "linkedin",
    page: "linkedin__jobs-search",
  });
  assert.deepEqual(resolvePage(new URL("https://www.linkedin.com/jobs/search/")), {
    channel: "linkedin",
    page: "linkedin__jobs-search",
  });
});

test("resolvePage maps anything starting with /jobs/collections/ to linkedin__jobs-search", () => {
  assert.deepEqual(resolvePage(new URL("https://www.linkedin.com/jobs/collections/recommended")), {
    channel: "linkedin",
    page: "linkedin__jobs-search",
  });
});

test("resolvePage maps /jobs/search-results and /jobs/search-results/ to linkedin__jobs-search-results", () => {
  assert.deepEqual(resolvePage(new URL("https://www.linkedin.com/jobs/search-results")), {
    channel: "linkedin",
    page: "linkedin__jobs-search-results",
  });
  assert.deepEqual(resolvePage(new URL("https://www.linkedin.com/jobs/search-results/")), {
    channel: "linkedin",
    page: "linkedin__jobs-search-results",
  });
});

test("resolvePage throws for a non-linkedin hostname", () => {
  assert.throws(() => resolvePage(new URL("https://www.indeed.com/jobs/search")));
});

test("resolvePage throws for an unrecognized linkedin path", () => {
  assert.throws(() => resolvePage(new URL("https://www.linkedin.com/feed/")));
});
