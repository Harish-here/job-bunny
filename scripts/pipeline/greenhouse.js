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
//
// Shared probe/fetch phase logic and ATS-agnostic helpers live in ats_common.js (also used by
// the Keka lane); this file keeps only what's genuinely Greenhouse-specific.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMain } from "../lib/cli.js";
import { writeJson } from "../lib/io.js";
import { loadAvoid } from "./avoid.js";
import { filterByTitle } from "./title_filter.js";
import { readCache } from "../notion/cache.js";
import { paths, resolveProfileName, ROOT } from "../lib/config.js";
import { notify } from "../notify/notify.js";
import {
  FETCH_TIMEOUT_MS,
  exists,
  readJsonOr,
  tokenCandidates,
  verifyBoardName,
  htmlToText,
  parseWatchlist,
  loadWatchlistText,
  formatWatchlistAppend,
  mergeByJobId,
  today,
  runProbePhase,
  runFetchPhase,
} from "./ats_common.js";

const BOARDS_API = "https://boards-api.greenhouse.io/v1/boards";

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

// ---------- fetch phase ----------

async function fetchBoardJobs(board) {
  const res = await fetch(`${BOARDS_API}/${board.token}/jobs?content=true`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

// ---------- main ----------

async function main() {
  console.log(`[greenhouse] profile=${resolveProfileName()}`);

  const P = paths();
  const wlExists = await exists(P.greenhouseBoards);
  const ledger = await readJsonOr(P.ghProbeLedger, {}, "greenhouse");
  const ledgerEmpty = Object.keys(ledger).length === 0;

  if (!wlExists && ledgerEmpty) {
    console.log("[greenhouse] no greenhouse_boards.md — lane disabled");
    return;
  }

  let watchlistText = await loadWatchlistText({
    wlExists,
    path: P.greenhouseBoards,
    fileName: "greenhouse_boards.md",
    templatePath: join(ROOT, "templates", "greenhouse_boards.md"),
  });

  const avoid = await loadAvoid();
  const companiesSeen = await readJsonOr(P.companiesSeen, [], "greenhouse");

  // --- probe phase ---
  const { probed, hits } = await runProbePhase({ companiesSeen, ledger, avoid, probeCandidate });
  const candidatesRun = probed > 0;
  if (candidatesRun) {
    await writeJson(P.ghProbeLedger, ledger);
  }
  if (hits.length) {
    watchlistText = formatWatchlistAppend(watchlistText, hits);
    await writeFile(P.greenhouseBoards, watchlistText);
    console.log(`[greenhouse] watchlist +${hits.length}: ${hits.map((h) => h.name).join(", ")}`);
  }

  // --- fetch phase ---
  let boards;
  try {
    boards = parseWatchlist(watchlistText, "greenhouse_boards.md");
  } catch (err) {
    throw new Error(`Cannot parse generated ${P.greenhouseBoards}: ${err.message}`);
  }

  const ghSeen = await readJsonOr(P.ghSeen, {}, "greenhouse");
  const cache = await readCache();
  const cacheIds = new Set(cache.jobs.map((j) => j.job_id).filter(Boolean));
  const maxNew = parseInt(process.env.GH_MAX_NEW || "40", 10);

  const fetchResult = await runFetchPhase({
    boards,
    seen: ghSeen,
    cacheIds,
    avoid,
    maxNew,
    capEnvLabel: "GH_MAX_NEW",
    tag: "greenhouse",
    fetchBoardJobs,
    jobIdFor: (job) => `gh-${job.id}`,
    mapJob: mapGhJob,
    titlePass: (t) => filterByTitle(t).pass,
  });

  if (fetchResult.allFailed) {
    console.warn(`[greenhouse] all ${boards.length} board(s) failed — lane skipped this run`);
    await notify({
      severity: "info",
      title: "Greenhouse lane skipped",
      body: `All ${boards.length} Greenhouse board(s) failed to fetch this run (${resolveProfileName()}).`,
    });
  }

  await writeJson(P.ghSeen, ghSeen);

  const existingRaw = await readJsonOr(P.jobsRawText, [], "greenhouse");
  const merged = mergeByJobId(existingRaw, fetchResult.emittedRecords);
  await writeJson(P.jobsRawText, merged);

  console.log(
    `[greenhouse] boards_fetched=${fetchResult.boardsFetched} boards_failed=${fetchResult.boardsFailed} ` +
      `probed=${probed} watchlist_adds=${hits.length} seen_skipped=${fetchResult.seenSkipped} ` +
      `cache_skipped=${fetchResult.cacheSkipped} title_dropped=${fetchResult.titleDropped} ` +
      `avoid_dropped=${fetchResult.avoidDropped} emitted=${fetchResult.emitted} merged_total=${merged.length}`
  );
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[greenhouse] FAILED: ${err.message}`);
    process.exit(1);
  });
}
