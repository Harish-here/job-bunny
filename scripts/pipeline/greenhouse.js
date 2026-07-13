// scripts/pipeline/greenhouse.js — the /greenhouse lane. A second, browser-less discovery channel
// alongside LinkedIn: no login, no CDP, just Greenhouse's public keyless boards API
// (boards-api.greenhouse.io). Two phases, both driven by the profile's greenhouse_boards.md:
//
//   Probe  — grows the watchlist. Companies seen by /extract (data/companies_seen.json,
//            written even for cards later dropped by the title filter) that aren't already
//            avoided or in the probe ledger get their board token guessed and confirmed
//            against the API. Confirmed hits are appended under "## Auto-discovered"; misses
//            are recorded in gh_probe_ledger.json so they're never re-probed.
//   Fetch  — for every board on the (possibly just-grown) watchlist, pulls open positions,
//            applies the same seen/cache/avoid/title gates as the LinkedIn lane, and appends
//            survivors to jobs_raw_text.json in the exact extract.js record shape — downstream
//            stages (compress → /structure → …) never need to know which channel a job came
//            from.
//
// Fail-soft by design: a single board failing to fetch is skipped and logged, not fatal. If
// EVERY board fails, this is reported via notify() (best-effort) but still exits 0 — an API
// outage on this optional lane must never hard-abort /run. The only hard failure is a
// malformed greenhouse_boards.md (a real contract error, same as /doctor's own check).

import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { normalizeName } from "../lib/util.js";
import { loadAvoid, isAvoided } from "./avoid.js";
import { filterByTitle } from "./title_filter.js";
import { readCache } from "../notion/cache.js";
import { paths, resolveProfileName, ROOT } from "../lib/config.js";
import { notify } from "../notify/notify.js";

const BOARDS_API = "https://boards-api.greenhouse.io/v1/boards";
const PROBE_CAP = 25; // candidates probed per run — bounds a single run's HTTP fan-out
const PROBE_DELAY_MS = 300; // between probe HTTP calls, politeness toward the public API
const FETCH_TIMEOUT_MS = 10_000;

const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

// Read a JSON file we own (companies_seen.json, gh_probe_ledger.json, gh_seen.json,
// jobs_raw_text.json). Absent file → default. A present-but-corrupt file warns and falls
// back to default too — these are our own perf/state files, not user input worth hard-failing
// the run over (same posture as cache.js's readCache()).
async function readJsonOr(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`[greenhouse] ${path} unreadable (${err.message}) — treating as empty`);
    return fallback;
  }
}

// ---------- pure helpers (exported for tests; no I/O, no network) ----------

// Generate board-token guesses for a company name. Three shapes, deduped:
//   1. normalizeName(name) with spaces squashed out         ("Acme Robotics" → "acmerobotics")
//   2. normalizeName(name) with spaces hyphenated           ("Acme Robotics" → "acme-robotics")
//   3. the raw (pre-normalize) lowercased name, squashed     ("Acme Inc" → "acmeinc")
// normalizeName() already strips legal suffixes (Inc, Ltd, Technologies, …), so guess 1 is
// usually already the bare name; guess 3 exists specifically to catch boards whose token still
// carries the suffix (e.g. a real-world token like "acmeinc").
export function tokenCandidates(companyName) {
  const norm = normalizeName(companyName);
  const raw = String(companyName || "").toLowerCase().trim();

  const guesses = [
    norm.replace(/\s+/g, ""),
    norm.replace(/\s+/g, "-"),
    raw.replace(/[^a-z0-9]+/g, ""),
  ].filter(Boolean);

  return [...new Set(guesses)];
}

// Does a Greenhouse board's own display name plausibly belong to our candidate company?
// Normalizes both sides; accepts an exact match or either containing the other (a board named
// "Acme Robotics Pvt Ltd" should confirm a candidate normalized to "acme robotics", and vice
// versa for a shorter board name).
export function verifyBoardName(candidateCompany, boardName) {
  const a = normalizeName(candidateCompany);
  const b = normalizeName(boardName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// Decode the HTML entities that actually show up in JD copy. Not exhaustive — just enough.
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

// Greenhouse job `content` arrives HTML-ENTITY-ESCAPED ("&lt;p&gt;…" — verified live), so the
// order matters: decode first (turning &lt;p&gt; into real tags), THEN strip tags, then decode
// once more for entities the first pass unmasked (e.g. "&amp;nbsp;" → "&nbsp;" → " "), then
// collapse whitespace. Also handles already-unescaped HTML: the first decode is a no-op there.
// Not a general HTML→text library — just enough for JD bodies.
export function htmlToText(html) {
  if (!html) return "";
  let s = decodeEntities(String(html));
  s = s.replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim();
}

// Map a Greenhouse job + its board into the extract.js record shape (see extract.js ~437).
// `todayStr` is injectable for deterministic tests; defaults to the real date.
export function mapGhJob(job, board, todayStr = today()) {
  const max = parseInt(process.env.JD_MAX_CHARS || "2500", 10);
  return {
    job_id: `gh-${job.id}`,
    job_url: job.absolute_url,
    source_query_url: `${BOARDS_API}/${board.token}/jobs`,
    raw_text: htmlToText(job.content).slice(0, max),
    date_found: todayStr,
    card_title: job.title,
    card_company: board.name,
    card_location: job.location?.name ?? null,
  };
}

// Parse greenhouse_boards.md → [{ name, token }], both "## Curated" and "## Auto-discovered"
// merged (callers don't need to know which section a board came from). Blank lines and any
// line starting with "#" (comments AND the "##" section headings) are structural. Any other
// non-conforming line is a hard parse error — mirrors doctor.js's own lenient-file/strict-line
// check byte-for-byte (same regex) so a file that passes /doctor never throws here.
export function parseWatchlist(text) {
  const boards = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^-\s+(.+)\s+-\s+(\S+)$/);
    if (!m) throw new Error(`greenhouse_boards.md malformed line: "${line}"`);
    boards.push({ name: m[1].trim(), token: m[2].trim() });
  }
  return boards;
}

// Insert newly-confirmed board entries under the "## Auto-discovered" heading. If the heading
// isn't present in `text` (e.g. a hand-rolled file that skipped the template), append one at
// EOF. Used by the probe phase's auto-add path; also the tool a test round-trips through.
export function formatWatchlistAppend(text, entries) {
  const base = String(text ?? "");
  const lines = entries.map((e) => `- ${e.name} - ${e.token}`).join("\n") + "\n";
  const heading = "## Auto-discovered";
  const idx = base.indexOf(heading);

  if (idx === -1) {
    const sep = base === "" || base.endsWith("\n") ? "" : "\n";
    return `${base}${sep}\n${heading}\n${lines}`;
  }

  const headingEnd = idx + heading.length;
  const nl = base.indexOf("\n", headingEnd);
  const insertAt = nl === -1 ? base.length : nl + 1;
  return base.slice(0, insertAt) + lines + base.slice(insertAt);
}

// Dedup by job_id: keep every existing record, append only incoming records whose job_id isn't
// already present. Idempotent — re-merging the same `incoming` a second time is a no-op.
export function mergeByJobId(existing, incoming) {
  const seen = new Set(existing.map((j) => j.job_id));
  const merged = [...existing];
  for (const job of incoming) {
    if (seen.has(job.job_id)) continue;
    seen.add(job.job_id);
    merged.push(job);
  }
  return merged;
}

// ---------- probe phase ----------

// Try each token guess for one candidate against the live API; first confirmed match wins.
// Every HTTP call (not just every candidate) is politeness-throttled by the caller.
async function probeCandidate(name, sleepBetween) {
  const guesses = tokenCandidates(name);
  for (const token of guesses) {
    await sleepBetween();
    try {
      const res = await fetch(`${BOARDS_API}/${token}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        console.log(`[greenhouse] probe miss: "${name}" guess "${token}" — HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (verifyBoardName(name, data?.name)) {
        console.log(`[greenhouse] probe hit: "${name}" → "${token}" (${data.name})`);
        return { token, name: data.name };
      }
      console.log(`[greenhouse] probe miss: "${name}" guess "${token}" — name mismatch ("${data?.name}")`);
    } catch (err) {
      console.log(`[greenhouse] probe miss: "${name}" guess "${token}" — ${err.message}`);
    }
  }
  return null;
}

async function runProbePhase({ companiesSeen, ledger, avoid }) {
  const candidates = companiesSeen
    .filter((name) => !isAvoided(name, avoid))
    .filter((name) => !(normalizeName(name) in ledger))
    .slice(0, PROBE_CAP);

  const hits = [];
  let first = true;
  const sleepBetween = async () => {
    if (first) {
      first = false;
      return;
    }
    await sleep(PROBE_DELAY_MS);
  };

  for (const name of candidates) {
    const confirmed = await probeCandidate(name, sleepBetween);
    const norm = normalizeName(name);
    ledger[norm] = confirmed
      ? { token: confirmed.token, probed: today(), name: confirmed.name }
      : { token: null, probed: today() };
    if (confirmed) hits.push({ name: confirmed.name, token: confirmed.token });
  }

  return { probed: candidates.length, hits };
}

// ---------- fetch phase ----------

async function fetchBoardJobs(board) {
  const res = await fetch(`${BOARDS_API}/${board.token}/jobs?content=true`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

async function runFetchPhase({ boards, ghSeen, cacheIds, avoid, maxNew }) {
  const counts = {
    boardsFetched: 0,
    boardsFailed: 0,
    seenSkipped: 0,
    cacheSkipped: 0,
    avoidDropped: 0,
    titleDropped: 0,
    emitted: 0,
    capHit: false,
  };
  const emittedRecords = [];
  const allLiveIds = new Set();

  for (const board of boards) {
    if (counts.capHit) break;

    let jobs;
    try {
      jobs = await fetchBoardJobs(board);
      counts.boardsFetched++;
    } catch (err) {
      counts.boardsFailed++;
      console.warn(`[greenhouse] SKIP board "${board.name}" (${board.token}) — ${err.message}`);
      continue;
    }

    for (const job of jobs) {
      const id = `gh-${job.id}`;
      allLiveIds.add(id);

      if (counts.capHit) continue; // keep counting allLiveIds for pruning even past the cap

      if (Object.prototype.hasOwnProperty.call(ghSeen, id)) {
        counts.seenSkipped++;
        continue;
      }
      if (cacheIds.has(id)) {
        counts.cacheSkipped++;
        continue;
      }
      if (isAvoided(board.name, avoid)) {
        counts.avoidDropped++;
        continue;
      }
      if (!filterByTitle(job.title || "").pass) {
        counts.titleDropped++;
        continue;
      }
      if (counts.emitted >= maxNew) {
        counts.capHit = true;
        console.log(`[greenhouse] GH_MAX_NEW=${maxNew} cap hit — stopping (not marking further jobs as seen)`);
        continue;
      }

      emittedRecords.push(mapGhJob(job, board));
      ghSeen[id] = today();
      counts.emitted++;
    }
  }

  // Prune stale gh_seen entries (job closed / board dropped from the watchlist) — but only
  // when every board was actually fetched this run. A partial run — a board fetch failed, OR
  // the GH_MAX_NEW cap broke out of the loop before reaching later boards — doesn't give full
  // visibility into which ids are genuinely gone, so we leave gh_seen untouched rather than
  // risk dropping entries for boards we never looked at this time.
  if (boards.length && counts.boardsFetched === boards.length) {
    for (const id of Object.keys(ghSeen)) {
      if (!allLiveIds.has(id)) delete ghSeen[id];
    }
  }

  return { ...counts, emittedRecords };
}

// ---------- main ----------

async function main() {
  console.log(`[greenhouse] profile=${resolveProfileName()}`);

  const P = paths();
  const wlExists = await exists(P.greenhouseBoards);
  const ledger = await readJsonOr(P.ghProbeLedger, {});
  const ledgerEmpty = Object.keys(ledger).length === 0;

  if (!wlExists && ledgerEmpty) {
    console.log("[greenhouse] no greenhouse_boards.md — lane disabled");
    return;
  }

  let watchlistText;
  if (wlExists) {
    watchlistText = await readFile(P.greenhouseBoards, "utf8");
    try {
      parseWatchlist(watchlistText); // fail loud on a malformed existing file
    } catch (err) {
      throw new Error(`Cannot parse ${P.greenhouseBoards}: ${err.message}`);
    }
  } else {
    // No file yet, but the ledger has history — seed from the template so a probe hit this
    // run has a "## Auto-discovered" heading to land under.
    watchlistText = await readFile(join(ROOT, "templates", "greenhouse_boards.md"), "utf8").catch(
      () => "## Curated\n\n## Auto-discovered\n"
    );
  }

  const avoid = await loadAvoid();
  const companiesSeen = await readJsonOr(P.companiesSeen, []);

  // --- probe phase ---
  const { probed, hits } = await runProbePhase({ companiesSeen, ledger, avoid });
  const candidatesRun = probed > 0;
  if (candidatesRun) {
    await writeFile(P.ghProbeLedger, JSON.stringify(ledger, null, 2) + "\n");
  }
  if (hits.length) {
    watchlistText = formatWatchlistAppend(watchlistText, hits);
    await writeFile(P.greenhouseBoards, watchlistText);
    console.log(`[greenhouse] watchlist +${hits.length}: ${hits.map((h) => h.name).join(", ")}`);
  }

  // --- fetch phase ---
  let boards;
  try {
    boards = parseWatchlist(watchlistText);
  } catch (err) {
    throw new Error(`Cannot parse generated ${P.greenhouseBoards}: ${err.message}`);
  }

  const ghSeen = await readJsonOr(P.ghSeen, {});
  const cache = await readCache();
  const cacheIds = new Set(cache.jobs.map((j) => j.job_id).filter(Boolean));
  const maxNew = parseInt(process.env.GH_MAX_NEW || "40", 10);

  const fetchResult = await runFetchPhase({ boards, ghSeen, cacheIds, avoid, maxNew });

  if (boards.length > 0 && fetchResult.boardsFetched === 0 && fetchResult.boardsFailed === boards.length) {
    console.warn(`[greenhouse] all ${boards.length} board(s) failed — lane skipped this run`);
    await notify({
      severity: "info",
      title: "Greenhouse lane skipped",
      body: `All ${boards.length} Greenhouse board(s) failed to fetch this run (${resolveProfileName()}).`,
    });
  }

  await writeFile(P.ghSeen, JSON.stringify(ghSeen, null, 2) + "\n");

  const existingRaw = await readJsonOr(P.jobsRawText, []);
  const merged = mergeByJobId(existingRaw, fetchResult.emittedRecords);
  await writeFile(P.jobsRawText, JSON.stringify(merged, null, 2) + "\n");

  console.log(
    `[greenhouse] boards_fetched=${fetchResult.boardsFetched} boards_failed=${fetchResult.boardsFailed} ` +
      `probed=${probed} watchlist_adds=${hits.length} seen_skipped=${fetchResult.seenSkipped} ` +
      `cache_skipped=${fetchResult.cacheSkipped} title_dropped=${fetchResult.titleDropped} ` +
      `avoid_dropped=${fetchResult.avoidDropped} emitted=${fetchResult.emitted} merged_total=${merged.length}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[greenhouse] FAILED: ${err.message}`);
    process.exit(1);
  });
}
