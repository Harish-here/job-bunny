// scripts/pipeline/ats_common.js — shared plumbing for the keyless ATS lanes (greenhouse.js,
// keka.js): pure helpers + the generic probe/fetch phase loops. Per-ATS specifics (board API
// shape, job-id prefix, title gate) are injected by the caller — this module knows nothing
// about Greenhouse or Keka specifically.

import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { normalizeName } from "../lib/util.js";
import { isAvoided } from "./avoid.js";

const PROBE_CAP = 25; // candidates probed per run — bounds a single run's HTTP fan-out
const PROBE_DELAY_MS = 300; // between probe HTTP calls, politeness toward the public API
export const FETCH_TIMEOUT_MS = 10_000;

export const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const today = () => new Date().toISOString().slice(0, 10);

// Read a JSON file we own (companies_seen.json, a lane's probe ledger, its seen file,
// jobs_raw_text.json). Absent file → default. A present-but-corrupt file warns and falls
// back to default too — these are our own perf/state files, not user input worth hard-failing
// the run over (same posture as cache.js's readCache()). `tag` names the calling lane in the
// warn prefix ("greenhouse", "keka", …).
export async function readJsonOr(path, fallback, tag) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`[${tag}] ${path} unreadable (${err.message}) — treating as empty`);
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

// Does an ATS board's own display name plausibly belong to our candidate company?
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

// An ATS job `content` field can arrive HTML-ENTITY-ESCAPED ("&lt;p&gt;…" — verified live for
// Greenhouse), so the order matters: decode first (turning &lt;p&gt; into real tags), THEN strip
// tags, then decode once more for entities the first pass unmasked (e.g. "&amp;nbsp;" →
// "&nbsp;" → " "), then collapse whitespace. Also handles already-unescaped HTML: the first
// decode is a no-op there. Not a general HTML→text library — just enough for JD bodies.
export function htmlToText(html) {
  if (!html) return "";
  let s = decodeEntities(String(html));
  s = s.replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim();
}

// Parse a watchlist file → [{ name, token }], both "## Curated" and "## Auto-discovered"
// merged (callers don't need to know which section a board came from). Blank lines and any
// line starting with "#" (comments AND the "##" section headings) are structural. Any other
// non-conforming line is a hard parse error — doctor.js calls this directly for its preflight
// lint, so a file that passes /doctor never throws here. `filename` names the file in the
// thrown error (e.g. "greenhouse_boards.md").
export function parseWatchlist(text, filename) {
  const boards = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^-\s+(.+)\s+-\s+(\S+)$/);
    if (!m) throw new Error(`${filename} malformed line: "${line}"`);
    boards.push({ name: m[1].trim(), token: m[2].trim() });
  }
  return boards;
}

const AUTO_DISCOVERED_HEADING = "## Auto-discovered";

// Load a lane's watchlist text. When the file exists it is read and validated (fail loud on a
// malformed line, same error shape the fetch phase would throw). When it doesn't — but the
// caller decided the lane is still live (ledger has history) — seed from the lane's template so
// a probe hit this run has a "## Auto-discovered" heading to land under, falling back to a
// bare skeleton if the template is missing too.
export async function loadWatchlistText({ wlExists, path, fileName, templatePath }) {
  if (wlExists) {
    const text = await readFile(path, "utf8");
    try {
      parseWatchlist(text, fileName);
    } catch (err) {
      throw new Error(`Cannot parse ${path}: ${err.message}`);
    }
    return text;
  }
  return readFile(templatePath, "utf8").catch(() => `## Curated\n\n${AUTO_DISCOVERED_HEADING}\n`);
}

// Insert newly-confirmed board entries under the "## Auto-discovered" heading. If the heading
// isn't present in `text` (e.g. a hand-rolled file that skipped the template), append one at
// EOF. Used by the probe phase's auto-add path; also the tool a test round-trips through.
export function formatWatchlistAppend(text, entries) {
  const base = String(text ?? "");
  const lines = entries.map((e) => `- ${e.name} - ${e.token}`).join("\n") + "\n";
  const heading = AUTO_DISCOVERED_HEADING;
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

// Grows a lane's watchlist. `probeCandidate(name, sleepBetween)` is injected per-ATS — it tries
// guessed tokens against the live API and resolves to `{ token, name }` on a confirmed hit or
// null on a miss. This loop owns the candidate list, the ledger bookkeeping, and the shared
// probe-cap/throttle — everything a lane doesn't need to know about the wire format for.
export async function runProbePhase({ companiesSeen, ledger, avoid, probeCandidate }) {
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

// Fetches every board on a lane's watchlist and gates each job through the same seen/cache/
// avoid/title checks as the LinkedIn lane. Per-ATS behavior is injected: `fetchBoardJobs(board)`
// pulls a board's raw job list; `jobIdFor(job)` computes its prefixed id; `mapJob(job, board)`
// maps it into the extract.js record shape; `titlePass(title)` is the title gate. `tag` and
// `capEnvLabel` only affect log prefixes/messages.
export async function runFetchPhase({
  boards,
  seen,
  cacheIds,
  avoid,
  maxNew,
  capEnvLabel,
  tag,
  fetchBoardJobs,
  jobIdFor,
  mapJob,
  titlePass,
}) {
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
      console.warn(`[${tag}] SKIP board "${board.name}" (${board.token}) — ${err.message}`);
      continue;
    }

    for (const job of jobs) {
      const id = jobIdFor(job);
      allLiveIds.add(id);

      if (counts.capHit) continue; // keep counting allLiveIds for pruning even past the cap

      if (Object.prototype.hasOwnProperty.call(seen, id)) {
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
      if (!titlePass(job.title || "")) {
        counts.titleDropped++;
        continue;
      }
      if (counts.emitted >= maxNew) {
        counts.capHit = true;
        console.log(`[${tag}] ${capEnvLabel}=${maxNew} cap hit — stopping (not marking further jobs as seen)`);
        continue;
      }

      emittedRecords.push(mapJob(job, board));
      seen[id] = today();
      counts.emitted++;
    }
  }

  // Prune stale seen entries (job closed / board dropped from the watchlist) — but only when
  // every board was actually fetched this run. A partial run — a board fetch failed, OR the
  // cap broke out of the loop before reaching later boards — doesn't give full visibility into
  // which ids are genuinely gone, so we leave `seen` untouched rather than risk dropping
  // entries for boards we never looked at this time.
  if (boards.length && counts.boardsFetched === boards.length) {
    for (const id of Object.keys(seen)) {
      if (!allLiveIds.has(id)) delete seen[id];
    }
  }

  // The whole-lane-outage verdict lives here, next to the counts it's derived from — lanes
  // just react to it (warn + best-effort notify) instead of re-deriving the condition.
  const allFailed = boards.length > 0 && counts.boardsFetched === 0 && counts.boardsFailed === boards.length;

  return { ...counts, allFailed, emittedRecords };
}
