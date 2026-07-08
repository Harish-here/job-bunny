// scripts/greenhouse.test.js — node:test unit tests for the pure helpers in greenhouse.js
// (tokenCandidates, verifyBoardName, htmlToText, mapGhJob, parseWatchlist,
// formatWatchlistAppend, mergeByJobId). No network calls — probeCandidate/main() aren't
// exercised here. Needs a fixture profile + filter_config.json up front because greenhouse.js
// imports title_filter.js, which reads its config synchronously at module load (same pattern
// as scripts/title_filter.test.js). Run with:
//   node --test scripts/greenhouse.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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

const {
  tokenCandidates,
  verifyBoardName,
  htmlToText,
  mapGhJob,
  parseWatchlist,
  formatWatchlistAppend,
  mergeByJobId,
} = await import("./greenhouse.js");

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
  assert.deepEqual(parseWatchlist(text), [
    { name: "Acme Corp", token: "acme" },
    { name: "Widget Co", token: "widgetco" },
  ]);
});

test("parseWatchlist ignores comments, blank lines, and headings", () => {
  const text = "# a comment\n\n## Curated\n\n## Auto-discovered\n";
  assert.deepEqual(parseWatchlist(text), []);
});

test("parseWatchlist throws on a malformed non-comment line", () => {
  assert.throws(() => parseWatchlist("## Curated\nnot a valid line\n"), /malformed line/);
});

test("parseWatchlist throws on a bullet missing the token half", () => {
  assert.throws(() => parseWatchlist("- Acme Corp\n"), /malformed line/);
});

// --- formatWatchlistAppend + parseWatchlist round-trip ---------------------------------------------------------

test("formatWatchlistAppend inserts a new entry under Auto-discovered, and it re-parses correctly", () => {
  const template = "# header\n\n## Curated\n- Acme Corp - acme\n\n## Auto-discovered\n";
  const updated = formatWatchlistAppend(template, [{ name: "Widget Co", token: "widgetco" }]);

  const parsed = parseWatchlist(updated);
  assert.deepEqual(parsed, [
    { name: "Acme Corp", token: "acme" },
    { name: "Widget Co", token: "widgetco" },
  ]);
});

test("formatWatchlistAppend appends its own Auto-discovered heading when none exists", () => {
  const updated = formatWatchlistAppend("## Curated\n- Acme Corp - acme\n", [{ name: "Widget Co", token: "widgetco" }]);
  const parsed = parseWatchlist(updated);
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
