// scripts/pipeline/ats_common.test.js — node:test unit tests for the shared ATS-lane plumbing
// in ats_common.js (tokenCandidates, verifyBoardName, htmlToText, parseWatchlist,
// formatWatchlistAppend, mergeByJobId, runFetchPhase). No network calls — runProbePhase and any
// real fetchBoardJobs/probeCandidate implementations aren't exercised here; runFetchPhase is
// driven entirely through injected fakes. Run with:
//   node --test scripts/pipeline/ats_common.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  tokenCandidates,
  verifyBoardName,
  htmlToText,
  parseWatchlist,
  formatWatchlistAppend,
  mergeByJobId,
  runFetchPhase,
} from "./ats_common.js";
import { normalizeName } from "../lib/util.js";

// --- tokenCandidates ---------------------------------------------------------

test("tokenCandidates squashes a multi-word name and offers a hyphenated variant", () => {
  const guesses = tokenCandidates("Acme Robotics");
  assert.ok(guesses.includes("acmerobotics"));
  assert.ok(guesses.includes("acme-robotics"));
});

test("tokenCandidates strips a legal suffix for the normalized guesses but keeps a raw-squash guess too", () => {
  const guesses = tokenCandidates("Acme Inc");
  assert.ok(guesses.includes("acme")); // suffix-stripped, squashed/hyphenated collapse to the same thing
  assert.ok(guesses.includes("acmeinc")); // raw (pre-normalize) squash retains the suffix
});

test("tokenCandidates dedupes identical guesses for an already-clean single-word name", () => {
  const guesses = tokenCandidates("Acme");
  assert.deepEqual(guesses, ["acme"]);
});

test("tokenCandidates dedupes when squashed/hyphenated/raw all coincide (no suffix, no spaces)", () => {
  const guesses = tokenCandidates("data-corp");
  assert.deepEqual(new Set(guesses).size, guesses.length);
  assert.ok(guesses.every((g) => g.includes("data") && g.includes("corp")));
});

test("tokenCandidates handles falsy input without throwing", () => {
  assert.deepEqual(tokenCandidates(""), []);
});

// --- verifyBoardName ---------------------------------------------------------

test("verifyBoardName confirms an exact normalized match", () => {
  assert.equal(verifyBoardName("Acme Robotics", "Acme Robotics"), true);
});

test("verifyBoardName confirms when the board name contains the candidate", () => {
  assert.equal(verifyBoardName("Acme", "Acme Robotics Pvt Ltd"), true);
});

test("verifyBoardName confirms when the candidate contains the board name", () => {
  assert.equal(verifyBoardName("Acme Robotics Global", "Acme Robotics"), true);
});

test("verifyBoardName rejects an unrelated name", () => {
  assert.equal(verifyBoardName("Acme Robotics", "Widget Co"), false);
});

test("verifyBoardName rejects when either side is empty/missing", () => {
  assert.equal(verifyBoardName("Acme", ""), false);
  assert.equal(verifyBoardName("", "Acme"), false);
  assert.equal(verifyBoardName("Acme", undefined), false);
});

// --- htmlToText ---------------------------------------------------------

test("htmlToText strips tags", () => {
  assert.equal(htmlToText("<p>Hello <b>World</b></p>"), "Hello World");
});

test("htmlToText decodes &amp;, &#39;, and &nbsp;", () => {
  assert.equal(htmlToText("Tom &amp; Jerry&nbsp;&#39;s place"), "Tom & Jerry 's place");
});

test("htmlToText decodes numeric entities (decimal and hex)", () => {
  assert.equal(htmlToText("caf&#233; &#x2013; nice"), "café – nice");
});

test("htmlToText collapses whitespace, including across stripped tags/newlines", () => {
  assert.equal(htmlToText("<div>Line one</div>\n\n  <div>Line   two</div>"), "Line one Line two");
});

test("htmlToText handles Greenhouse's entity-ESCAPED content (decode → strip → decode remnants)", () => {
  // The boards API returns `content` HTML-escaped (verified live): tags arrive as &lt;p&gt;
  // and a literal nbsp arrives double-escaped as &amp;nbsp;.
  assert.equal(
    htmlToText("&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;About&amp;nbsp;Agoda&lt;/p&gt;&lt;/div&gt;"),
    "About Agoda",
  );
});

test("htmlToText returns empty string for falsy input", () => {
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText(null), "");
  assert.equal(htmlToText(undefined), "");
});

// --- parseWatchlist ---------------------------------------------------------

test("parseWatchlist merges Curated and Auto-discovered into one flat array", () => {
  const text = [
    "# comment header",
    "## Curated",
    "- Acme Corp - acme",
    "",
    "## Auto-discovered",
    "- Widget Co - widgetco",
  ].join("\n");
  assert.deepEqual(parseWatchlist(text, "greenhouse_boards.md"), [
    { name: "Acme Corp", token: "acme" },
    { name: "Widget Co", token: "widgetco" },
  ]);
});

test("parseWatchlist ignores comments, blank lines, and headings", () => {
  const text = "# a comment\n\n## Curated\n\n## Auto-discovered\n";
  assert.deepEqual(parseWatchlist(text, "greenhouse_boards.md"), []);
});

test("parseWatchlist throws on a malformed non-comment line", () => {
  assert.throws(
    () => parseWatchlist("## Curated\nnot a valid line\n", "greenhouse_boards.md"),
    /greenhouse_boards\.md malformed line/,
  );
});

test("parseWatchlist throws on a bullet missing the token half", () => {
  assert.throws(
    () => parseWatchlist("- Acme Corp\n", "greenhouse_boards.md"),
    /greenhouse_boards\.md malformed line/,
  );
});

test("parseWatchlist's error message names the passed-in filename", () => {
  assert.throws(() => parseWatchlist("not a valid line\n", "keka_boards.md"), /keka_boards\.md malformed line/);
});

// --- formatWatchlistAppend + parseWatchlist round-trip ---------------------------------------------------------

test("formatWatchlistAppend inserts a new entry under Auto-discovered, and it re-parses correctly", () => {
  const template = "# header\n\n## Curated\n- Acme Corp - acme\n\n## Auto-discovered\n";
  const updated = formatWatchlistAppend(template, [{ name: "Widget Co", token: "widgetco" }]);

  const parsed = parseWatchlist(updated, "greenhouse_boards.md");
  assert.deepEqual(parsed, [
    { name: "Acme Corp", token: "acme" },
    { name: "Widget Co", token: "widgetco" },
  ]);
});

test("formatWatchlistAppend appends its own Auto-discovered heading when none exists", () => {
  const updated = formatWatchlistAppend("## Curated\n- Acme Corp - acme\n", [{ name: "Widget Co", token: "widgetco" }]);
  const parsed = parseWatchlist(updated, "greenhouse_boards.md");
  assert.deepEqual(parsed, [
    { name: "Acme Corp", token: "acme" },
    { name: "Widget Co", token: "widgetco" },
  ]);
});

// --- mergeByJobId ---------------------------------------------------------

test("mergeByJobId appends only genuinely new job_ids", () => {
  const existing = [{ job_id: "gh-1", card_title: "A" }];
  const incoming = [{ job_id: "gh-1", card_title: "A-dup" }, { job_id: "gh-2", card_title: "B" }];
  const merged = mergeByJobId(existing, incoming);
  assert.deepEqual(merged, [
    { job_id: "gh-1", card_title: "A" },
    { job_id: "gh-2", card_title: "B" },
  ]);
});

test("mergeByJobId is idempotent on a re-merge of the same incoming batch", () => {
  const existing = [{ job_id: "gh-1" }];
  const incoming = [{ job_id: "gh-2" }];
  const once = mergeByJobId(existing, incoming);
  const twice = mergeByJobId(once, incoming);
  assert.deepEqual(twice, once);
  assert.equal(twice.length, 2);
});

// --- runFetchPhase ---------------------------------------------------------

// Shared fakes for runFetchPhase tests: one board, injected fetchBoardJobs/jobIdFor/mapJob.
const board = { name: "Acme Robotics", token: "acme" };
const jobIdFor = (job) => `x-${job.id}`;
const mapJob = (job, b) => ({ job_id: `x-${job.id}`, card_title: job.title, card_company: b.name });
const alwaysPass = () => true;
const noAvoid = { companies: new Set(), aliases: new Map() };
const avoidBoard = { companies: new Set([normalizeName("Acme Robotics")]), aliases: new Map() };

function makeFetcher(jobsByToken) {
  return async (b) => {
    if (Object.prototype.hasOwnProperty.call(jobsByToken, b.token) === false) throw new Error("no such board");
    const jobs = jobsByToken[b.token];
    if (jobs instanceof Error) throw jobs;
    return jobs;
  };
}

test("runFetchPhase gate: a job already in seen is skipped", async () => {
  const seen = { "x-1": "2026-07-01" };
  const result = await runFetchPhase({
    boards: [board],
    seen,
    cacheIds: new Set(),
    avoid: noAvoid,
    maxNew: 10,
    capEnvLabel: "X_MAX_NEW",
    tag: "test",
    fetchBoardJobs: makeFetcher({ acme: [{ id: 1, title: "Engineer" }] }),
    jobIdFor,
    mapJob,
    titlePass: alwaysPass,
  });
  assert.equal(result.seenSkipped, 1);
  assert.equal(result.emitted, 0);
  assert.deepEqual(result.emittedRecords, []);
});

test("runFetchPhase gate: a job whose id is in cacheIds is skipped", async () => {
  const result = await runFetchPhase({
    boards: [board],
    seen: {},
    cacheIds: new Set(["x-1"]),
    avoid: noAvoid,
    maxNew: 10,
    capEnvLabel: "X_MAX_NEW",
    tag: "test",
    fetchBoardJobs: makeFetcher({ acme: [{ id: 1, title: "Engineer" }] }),
    jobIdFor,
    mapJob,
    titlePass: alwaysPass,
  });
  assert.equal(result.cacheSkipped, 1);
  assert.equal(result.emitted, 0);
});

test("runFetchPhase gate: jobs from an avoided board are counted avoidDropped", async () => {
  const result = await runFetchPhase({
    boards: [board],
    seen: {},
    cacheIds: new Set(),
    avoid: avoidBoard,
    maxNew: 10,
    capEnvLabel: "X_MAX_NEW",
    tag: "test",
    fetchBoardJobs: makeFetcher({ acme: [{ id: 1, title: "Engineer" }] }),
    jobIdFor,
    mapJob,
    titlePass: alwaysPass,
  });
  assert.equal(result.avoidDropped, 1);
  assert.equal(result.emitted, 0);
});

test("runFetchPhase gate: titlePass=false is counted titleDropped", async () => {
  const result = await runFetchPhase({
    boards: [board],
    seen: {},
    cacheIds: new Set(),
    avoid: noAvoid,
    maxNew: 10,
    capEnvLabel: "X_MAX_NEW",
    tag: "test",
    fetchBoardJobs: makeFetcher({ acme: [{ id: 1, title: "Intern" }] }),
    jobIdFor,
    mapJob,
    titlePass: () => false,
  });
  assert.equal(result.titleDropped, 1);
  assert.equal(result.emitted, 0);
});

test("runFetchPhase cap: with maxNew=1 and 2 fresh jobs, emitted=1, capHit=true, second job not added to seen", async () => {
  const seen = {};
  const result = await runFetchPhase({
    boards: [board],
    seen,
    cacheIds: new Set(),
    avoid: noAvoid,
    maxNew: 1,
    capEnvLabel: "X_MAX_NEW",
    tag: "test",
    fetchBoardJobs: makeFetcher({
      acme: [
        { id: 1, title: "Engineer" },
        { id: 2, title: "Engineer" },
      ],
    }),
    jobIdFor,
    mapJob,
    titlePass: alwaysPass,
  });
  assert.equal(result.emitted, 1);
  assert.equal(result.capHit, true);
  assert.ok(Object.prototype.hasOwnProperty.call(seen, "x-1"));
  assert.ok(!Object.prototype.hasOwnProperty.call(seen, "x-2"));
});

test("runFetchPhase prune: a stale id in seen is removed when every board is fetched", async () => {
  const seen = { "x-99": "2026-06-01" };
  await runFetchPhase({
    boards: [board],
    seen,
    cacheIds: new Set(),
    avoid: noAvoid,
    maxNew: 10,
    capEnvLabel: "X_MAX_NEW",
    tag: "test",
    fetchBoardJobs: makeFetcher({ acme: [{ id: 1, title: "Engineer" }] }),
    jobIdFor,
    mapJob,
    titlePass: alwaysPass,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(seen, "x-99"));
});

test("runFetchPhase prune: a stale id in seen is retained when one board's fetch throws", async () => {
  const seen = { "x-99": "2026-06-01" };
  const otherBoard = { name: "Widget Co", token: "widgetco" };
  await runFetchPhase({
    boards: [board, otherBoard],
    seen,
    cacheIds: new Set(),
    avoid: noAvoid,
    maxNew: 10,
    capEnvLabel: "X_MAX_NEW",
    tag: "test",
    fetchBoardJobs: makeFetcher({ acme: [{ id: 1, title: "Engineer" }] }), // widgetco throws (not in map)
    jobIdFor,
    mapJob,
    titlePass: alwaysPass,
  });
  assert.ok(Object.prototype.hasOwnProperty.call(seen, "x-99"));
});
