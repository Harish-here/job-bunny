// scripts/pipeline/extract/filters.test.js — node:test unit tests for the pure pre-JD card
// filter pipeline (stageFilter, applyCardGates). Uses the REAL isAvoided/filterByTitle against a
// fixture profile (filter_config.json) so gate behavior matches production, not a fake stand-in.
// Run with: node --test scripts/pipeline/extract/filters.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "../../lib/config.js";
import { parseAvoid } from "../avoid.js";

// title_filter.js reads filter_config.json at MODULE LOAD time (see title_filter.test.js) — set
// up a fixture profile and point JOBBUNNY_PROFILE at it before dynamically importing filters.js
// (which imports title_filter.js transitively).
const FIXTURE_PROFILE = "__test_extract_filters__";
const FIXTURE_DIR = join(ROOT, "profiles", FIXTURE_PROFILE);

await mkdir(FIXTURE_DIR, { recursive: true });
await writeFile(
  join(FIXTURE_DIR, "filter_config.json"),
  JSON.stringify({
    title_filter: {
      seniority: ["senior"],
      domain: ["backend"],
      function: { allow: ["engineer"], block: ["intern"] },
    },
  })
);
process.env.JOBBUNNY_PROFILE = FIXTURE_PROFILE;

const { stageFilter, applyCardGates } = await import("./filters.js");

// A title that passes seniority+domain+function gates under the fixture config above.
const GOOD_TITLE = "Senior Backend Engineer";
// A title missing a seniority term — dropped at the title-filter gate.
const BAD_TITLE = "Backend Manager";

const avoid = parseAvoid(["- AvoidCo"].join("\n"));

function freshSummary() {
  return { avoided: 0, cache_skipped: 0, run_deduped: 0, title_dropped: 0 };
}

test("stageFilter filters, counts drops into summary, and logs via the injected log fn", () => {
  const lines = [];
  const summary = { dropped: 0 };
  const out = stageFilter(
    [{ v: 1 }, { v: 2 }, { v: 3 }],
    (c) => c.v !== 2,
    (n) => `dropped ${n}`,
    "dropped",
    summary,
    (l) => lines.push(l)
  );
  assert.deepEqual(out, [{ v: 1 }, { v: 3 }]);
  assert.equal(summary.dropped, 1);
  assert.deepEqual(lines, ["dropped 1"]);
});

test("stageFilter does not log when nothing was dropped", () => {
  const lines = [];
  const summary = { dropped: 0 };
  stageFilter([{ v: 1 }], () => true, (n) => `dropped ${n}`, "dropped", summary, (l) => lines.push(l));
  assert.deepEqual(lines, []);
});

test("applyCardGates: gate order — avoided company never reaches companiesSeen; cache-skipped and title-dropped companies DO reach it", () => {
  const cards = [
    { job_id: "a1", title: GOOD_TITLE, company: "AvoidCo" }, // dropped at avoid gate
    { job_id: "a2", title: GOOD_TITLE, company: "CacheCo" }, // survives avoid, dropped at cache gate
    { job_id: "a3", title: BAD_TITLE, company: "TitleDropCo" }, // survives avoid+cache+dedup, dropped at title gate
  ];
  const summary = freshSummary();
  const companiesSeen = new Set();
  const cachedIds = new Set(["a2"]);
  const seenIds = new Set();

  const result = applyCardGates(cards, {
    avoid,
    cachedIds,
    seenIds,
    cardCap: 0,
    debug: false,
    summary,
    companiesSeen,
    log: () => {},
  });

  assert.deepEqual(result, []);
  assert.equal(companiesSeen.has("AvoidCo"), false);
  assert.equal(companiesSeen.has("CacheCo"), true);
  assert.equal(companiesSeen.has("TitleDropCo"), true);
  assert.deepEqual(summary, { avoided: 1, cache_skipped: 1, run_deduped: 0, title_dropped: 1 });
});

test("applyCardGates: run-dedup drops the second occurrence of a job_id; cards without job_id always pass that gate", () => {
  const cards = [
    { job_id: "b1", title: GOOD_TITLE, company: "GoodCo" },
    { job_id: "b1", title: GOOD_TITLE, company: "GoodCo" }, // duplicate — dropped by run-dedup
    { job_id: null, title: GOOD_TITLE, company: "GoodCo" }, // no job_id — always passes cache/dedup gates
  ];
  const summary = freshSummary();
  const companiesSeen = new Set();
  const cachedIds = new Set();
  const seenIds = new Set();

  const result = applyCardGates(cards, {
    avoid,
    cachedIds,
    seenIds,
    cardCap: 0,
    debug: false,
    summary,
    companiesSeen,
    log: () => {},
  });

  assert.equal(result.length, 2);
  assert.equal(summary.run_deduped, 1);
  assert.equal(seenIds.has("b1"), true);
});

test("applyCardGates: DEBUG mode logs a drop line per title-filter rejection with the drop reason", () => {
  const cards = [{ job_id: "c1", title: BAD_TITLE, company: "GoodCo" }];
  const lines = [];
  applyCardGates(cards, {
    avoid,
    cachedIds: new Set(),
    seenIds: new Set(),
    cardCap: 0,
    debug: true,
    summary: freshSummary(),
    companiesSeen: new Set(),
    log: (l) => lines.push(l),
  });
  assert.ok(lines.some((l) => l.startsWith("[title-filter] DROP") && l.includes(BAD_TITLE)));
});

test("applyCardGates: cardCap slices AFTER all filters — the avoided card doesn't consume a cap slot", () => {
  const cards = [
    { job_id: "d0", title: GOOD_TITLE, company: "AvoidCo" }, // dropped pre-cap
    { job_id: "d1", title: GOOD_TITLE, company: "GoodCo" },
    { job_id: "d2", title: GOOD_TITLE, company: "GoodCo" },
    { job_id: "d3", title: GOOD_TITLE, company: "GoodCo" },
  ];
  const summary = freshSummary();
  const result = applyCardGates(cards, {
    avoid,
    cachedIds: new Set(),
    seenIds: new Set(),
    cardCap: 2,
    debug: false,
    summary,
    companiesSeen: new Set(),
    log: () => {},
  });
  assert.deepEqual(result.map((c) => c.job_id), ["d1", "d2"]);
  assert.equal(summary.avoided, 1);
});

test.after(async () => {
  delete process.env.JOBBUNNY_PROFILE;
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});
