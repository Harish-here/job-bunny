// scripts/dedup.test.js — node:test unit tests for the pure dedup core (dedupJobs).
// No I/O: cache rows are passed in directly, drop logs go to a capture array. Run with:
//   node --test scripts/dedup.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupJobs } from "./dedup.js";

const job = (over = {}) => ({
  job_id: "100",
  job_title: "Staff Frontend Engineer",
  company_name: "Acme Inc",
  location_city: "Chennai",
  ...over,
});

const noLog = () => {};

test("dedupJobs keeps a genuinely new job", () => {
  const r = dedupJobs([job()], [], noLog);
  assert.equal(r.kept.length, 1);
  assert.deepEqual([r.dupCache, r.dupBatch, r.reposts], [0, 0, 0]);
});

test("dedupJobs drops an exact job_id match against the cache", () => {
  const r = dedupJobs([job()], [job()], noLog);
  assert.equal(r.kept.length, 0);
  assert.equal(r.dupCache, 1);
});

test("dedupJobs drops an intra-batch duplicate and counts it separately from cache dups", () => {
  const r = dedupJobs([job(), job()], [], noLog);
  assert.equal(r.kept.length, 1);
  assert.deepEqual([r.dupCache, r.dupBatch], [0, 1]);
});

test("dedupJobs drops a fresh-id repost of a cache row", () => {
  const r = dedupJobs([job({ job_id: "999" })], [job()], noLog);
  assert.equal(r.kept.length, 0);
  assert.equal(r.reposts, 1);
  assert.equal(r.dupCache, 0);
});

test("dedupJobs drops a fresh-id repost of an earlier job in the same batch", () => {
  const r = dedupJobs([job(), job({ job_id: "999" })], [], noLog);
  assert.equal(r.kept.length, 1);
  assert.equal(r.reposts, 1);
});

test("dedupJobs keeps same title+company in a DIFFERENT city — two openings, not a repost", () => {
  const r = dedupJobs([job({ job_id: "999", location_city: "Bangalore" })], [job()], noLog);
  assert.equal(r.kept.length, 1);
  assert.equal(r.reposts, 0);
});

test("dedupJobs repost check normalizes company suffixes/case", () => {
  const cached = job({ company_name: "Acme Software Solutions" });
  const fresh = job({ job_id: "999", company_name: "ACME" });
  const r = dedupJobs([fresh], [cached], noLog);
  assert.equal(r.kept.length, 0);
  assert.equal(r.reposts, 1);
});

test("dedupJobs no-job_id fallback path is unchanged (rc: key dup vs cache)", () => {
  const noId = { job_title: "Staff Frontend Engineer", company_name: "Acme Inc", location_city: "Chennai" };
  const r = dedupJobs([{ ...noId }], [{ ...noId }], noLog);
  assert.equal(r.kept.length, 0);
  assert.equal(r.dupCache, 1);
});

test("dedupJobs logs the repost drop with its own reason", () => {
  const lines = [];
  dedupJobs([job({ job_id: "999" })], [job()], (l) => lines.push(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /repost of an existing row \(fresh job_id 999\)/);
});

test("dedupJobs counts a mixed batch correctly", () => {
  const cache = [job()];
  const batch = [
    job(), // dupCache
    job({ job_id: "200", job_title: "Backend Engineer" }), // new
    job({ job_id: "200", job_title: "Backend Engineer" }), // dupBatch
    job({ job_id: "999" }), // repost of cache row
    job({ job_id: "300", location_city: "Bangalore" }), // new — different city
  ];
  const r = dedupJobs(batch, cache, noLog);
  assert.equal(r.kept.length, 2);
  assert.deepEqual([r.dupCache, r.dupBatch, r.reposts], [1, 1, 1]);
});
