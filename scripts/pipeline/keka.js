// scripts/pipeline/keka.js — the /keka lane. A second, browser-less discovery channel alongside
// LinkedIn and Greenhouse: no login, no CDP, just Keka's public keyless careers API — the
// dominant ATS among Indian startups. Two phases, both driven by the profile's keka_boards.md:
//
//   Probe  — grows the watchlist. Companies seen by /extract (data/companies_seen.json,
//            written even for cards later dropped by the title filter) that aren't already
//            avoided or in the probe ledger get their tenant subdomain guessed and confirmed
//            against the API. Confirmed hits are appended under "## Auto-discovered"; misses
//            are recorded in keka_probe_ledger.json so they're never re-probed.
//   Fetch  — for every board on the (possibly just-grown) watchlist, resolves its portal guid,
//            pulls open positions, applies the same seen/cache/avoid/title gates as the
//            LinkedIn lane, and appends survivors to jobs_raw_text.json in the exact extract.js
//            record shape — downstream stages (compress → /structure → …) never need to know
//            which channel a job came from.
//
// Fail-soft by design: a single board failing to fetch is skipped and logged, not fatal. If
// EVERY board fails, this is reported via notify() (best-effort) but still exits 0 — an API
// outage on this optional lane must never hard-abort /run. The only hard failure is a
// malformed keka_boards.md (a real contract error, same as /doctor's own check).
//
// Shared probe/fetch phase logic and ATS-agnostic helpers live in ats_common.js (also used by
// the Greenhouse lane); this file keeps only what's genuinely Keka-specific.

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

const kekaBase = (tenant) => `https://${tenant}.keka.com`;

// Pull the first Keka portal guid out of a blob of text — the portal-info JSON (stringified) or
// the /careers/ HTML both embed it in an /ats/documents/<guid>/ asset path.
export function extractPortalGuid(str) {
  const m = String(str ?? "").match(
    /\/ats\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i
  );
  return m ? m[1] : null;
}

// Unique job locations, city preferred over name per entry, joined for display. null when a job
// carries no location data at all (consumed as a hint column by /structure, not matched
// directly by filter.js).
export function kekaLocation(job) {
  const locs = job?.jobLocations;
  if (!Array.isArray(locs) || locs.length === 0) return null;
  const names = [...new Set(locs.map((l) => l?.city || l?.name).filter(Boolean))];
  return names.length ? names.join(", ") : null;
}

// Map a Keka job + its board into the extract.js record shape (see extract.js ~437).
// `todayStr` is injectable for deterministic tests; defaults to the real date.
// Note: source_query_url deviates from the other lanes here — the embedjobs API URL requires a
// guid the mapper isn't handed, so we point at the human-meaningful /careers lane URL instead.
export function mapKekaJob(job, board, todayStr = today()) {
  const max = parseInt(process.env.JD_MAX_CHARS || "2500", 10);
  const experience = typeof job.experience === "string" && job.experience ? `Experience: ${job.experience}. ` : "";
  return {
    job_id: `kk-${job.id}`,
    job_url: `${kekaBase(board.token)}/careers/jobdetails/${job.id}`,
    source_query_url: `${kekaBase(board.token)}/careers`,
    raw_text: (experience + htmlToText(job.description)).slice(0, max),
    date_found: todayStr,
    card_title: job.title,
    card_company: board.name,
    card_location: kekaLocation(job),
  };
}

// ---------- probe phase ----------

// Try each tenant guess for one candidate against the live API; first confirmed match wins.
// Every HTTP call (not just every candidate) is politeness-throttled by the caller.
async function probeCandidate(name, sleepBetween) {
  const guesses = tokenCandidates(name);
  for (const token of guesses) {
    await sleepBetween();
    try {
      const res = await fetch(`${kekaBase(token)}/careers/api/organization/default/careerportalinfo`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.log(`[keka] probe miss: "${name}" guess "${token}" — HTTP ${res.status}`);
        continue;
      }
      let data;
      try {
        data = await res.json();
      } catch {
        console.log(`[keka] probe miss: "${name}" guess "${token}" — not a Keka tenant`);
        continue;
      }
      if (verifyBoardName(name, data?.name)) {
        console.log(`[keka] probe hit: "${name}" → "${token}" (${data.name})`);
        return { token, name: data.name };
      }
      console.log(`[keka] probe miss: "${name}" guess "${token}" — name mismatch ("${data?.name}")`);
    } catch (err) {
      console.log(`[keka] probe miss: "${name}" guess "${token}" — ${err.message}`);
    }
  }
  return null;
}

// ---------- fetch phase ----------

// Resolve a tenant's portal guid: try the portal-info JSON first, fall back to scraping it out
// of the /careers/ HTML. Throws if neither source yields one — the caller (fetchBoardJobs)
// treats that as a per-board failure, same as any other fetch error.
async function discoverGuid(tenant) {
  const res = await fetch(`${kekaBase(tenant)}/careers/api/organization/default/careerportalinfo`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.ok) {
    try {
      const data = await res.json();
      const guid = extractPortalGuid(JSON.stringify(data));
      if (guid) return guid;
    } catch {
      // not JSON — fall through to the HTML fallback below
    }
  }
  const htmlRes = await fetch(`${kekaBase(tenant)}/careers/`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const html = await htmlRes.text();
  const guid = extractPortalGuid(html);
  if (!guid) throw new Error("no portal guid found");
  return guid;
}

async function fetchBoardJobs(board) {
  const guid = await discoverGuid(board.token);
  const res = await fetch(`${kekaBase(board.token)}/careers/api/embedjobs/default/active/${guid}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ---------- main ----------

async function main() {
  console.log(`[keka] profile=${resolveProfileName()}`);

  const P = paths();
  const wlExists = await exists(P.kekaBoards);
  const ledger = await readJsonOr(P.kekaProbeLedger, {}, "keka");
  const ledgerEmpty = Object.keys(ledger).length === 0;

  if (!wlExists && ledgerEmpty) {
    console.log("[keka] no keka_boards.md — lane disabled");
    return;
  }

  let watchlistText = await loadWatchlistText({
    wlExists,
    path: P.kekaBoards,
    fileName: "keka_boards.md",
    templatePath: join(ROOT, "templates", "keka_boards.md"),
  });

  const avoid = await loadAvoid();
  const companiesSeen = await readJsonOr(P.companiesSeen, [], "keka");

  // --- probe phase ---
  const { probed, hits } = await runProbePhase({ companiesSeen, ledger, avoid, probeCandidate });
  const candidatesRun = probed > 0;
  if (candidatesRun) {
    await writeJson(P.kekaProbeLedger, ledger);
  }
  if (hits.length) {
    watchlistText = formatWatchlistAppend(watchlistText, hits);
    await writeFile(P.kekaBoards, watchlistText);
    console.log(`[keka] watchlist +${hits.length}: ${hits.map((h) => h.name).join(", ")}`);
  }

  // --- fetch phase ---
  let boards;
  try {
    boards = parseWatchlist(watchlistText, "keka_boards.md");
  } catch (err) {
    throw new Error(`Cannot parse generated ${P.kekaBoards}: ${err.message}`);
  }

  const kekaSeen = await readJsonOr(P.kekaSeen, {}, "keka");
  const cache = await readCache();
  const cacheIds = new Set(cache.jobs.map((j) => j.job_id).filter(Boolean));
  const maxNew = parseInt(process.env.KEKA_MAX_NEW || "40", 10);

  const fetchResult = await runFetchPhase({
    boards,
    seen: kekaSeen,
    cacheIds,
    avoid,
    maxNew,
    capEnvLabel: "KEKA_MAX_NEW",
    tag: "keka",
    fetchBoardJobs,
    jobIdFor: (job) => `kk-${job.id}`,
    mapJob: mapKekaJob,
    titlePass: (t) => filterByTitle(t).pass,
  });

  if (fetchResult.allFailed) {
    console.warn(`[keka] all ${boards.length} board(s) failed — lane skipped this run`);
    await notify({
      severity: "info",
      title: "Keka lane skipped",
      body: `All ${boards.length} Keka board(s) failed to fetch this run (${resolveProfileName()}).`,
    });
  }

  await writeJson(P.kekaSeen, kekaSeen);

  const existingRaw = await readJsonOr(P.jobsRawText, [], "keka");
  const merged = mergeByJobId(existingRaw, fetchResult.emittedRecords);
  await writeJson(P.jobsRawText, merged);

  console.log(
    `[keka] boards_fetched=${fetchResult.boardsFetched} boards_failed=${fetchResult.boardsFailed} ` +
      `probed=${probed} watchlist_adds=${hits.length} seen_skipped=${fetchResult.seenSkipped} ` +
      `cache_skipped=${fetchResult.cacheSkipped} title_dropped=${fetchResult.titleDropped} ` +
      `avoid_dropped=${fetchResult.avoidDropped} emitted=${fetchResult.emitted} merged_total=${merged.length}`
  );
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[keka] FAILED: ${err.message}`);
    process.exit(1);
  });
}
