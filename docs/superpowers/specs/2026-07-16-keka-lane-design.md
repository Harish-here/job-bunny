# Keka lane (v1.5.0 "Chennai coverage") — design

2026-07-16. Replaces the roadmapped Lever + Ashby lanes for v1.5.0.

## Why Keka, not Lever/Ashby

Live validation (this session) before building:

- **Lever + Ashby: zero Chennai yield.** The whole roadmap seed set (Kissflow, SurveySparrow, Facilio, Hippo Video, Uniphore, Yubi, Vue.ai, plus Chargebee, Freshworks, CloudSEK, GoFrugal, …) 404s on both APIs. Only dead boards exist (Freshworks' empty legacy Lever board; an empty Ashby board for Hippo Video's parent).
- **Where they actually are:** SurveySparrow → Keka · Hippo Video → Freshteam · Yubi → Zoho Recruit · Vue.ai → Darwinbox · Uniphore → Workday · Freshworks → SmartRecruiters · Kissflow/Chargebee/Facilio → custom pages · CloudSEK → Greenhouse (already coverable).
- **Keka has a keyless public JSON API** (verified live against SurveySparrow), and is the dominant Indian startup HR platform — the auto-probe tail is the real payoff, not just the one seed hit.

## Keka API contract (all keyless, verified 2026-07-16)

- `https://<tenant>.keka.com/careers/api/organization/default/careerportalinfo` → JSON with `name` (org display name, e.g. `"SURVEYSPARROW PRIVATE LIMITED"`) and asset paths (`careersBackgroundPath`, `logoPath`) of the form `/ats/documents/<org-guid>/…`. Non-existent tenants resolve to an HTML error page (TenantNotFound/403) — JSON parse failure ⇒ miss.
- `https://<tenant>.keka.com/careers/api/embedjobs/default/active/<org-guid>` → array of jobs: `id`, `title`, `description` (HTML), `jobLocations[] {city, state, countryCode, name}`, `experience` (string, e.g. `"1- 3 years"`), `jobType`, `skillNames[]`, `publishedOn`.
- Job detail page: `https://<tenant>.keka.com/careers/jobdetails/<id>` (returns 200).
- GUID fallback: `https://<tenant>.keka.com/careers/` HTML embeds the same `/ats/documents/<guid>/` path.

## Architecture — sibling script + shared helpers (user-chosen)

`greenhouse.js` stays a standalone lane; a new sibling `scripts/pipeline/keka.js` mirrors its two-phase shape. Genuinely shared logic moves to a new `scripts/pipeline/ats_common.js` (second concrete caller now exists):

- **Pure helpers, moved verbatim:** `tokenCandidates`, `verifyBoardName`, `htmlToText` (+ private `decodeEntities`), `formatWatchlistAppend`, `mergeByJobId`.
- **`parseWatchlist(text, filename)`** — gains a filename param so error messages name the right file.
- **`readJsonOr(path, fallback, tag)`** — the soft-fail state-file reader, with a log-prefix tag (`greenhouse`/`keka`). Stays out of `lib/io.js` deliberately (io.js is the fail-loud contract).
- **`runProbePhase({ companiesSeen, ledger, avoid, probeCandidate })`** — the candidate-selection + throttle + ledger loop; the per-ATS `probeCandidate(name, sleepBetween)` is injected.
- **`runFetchPhase({ boards, seen, cacheIds, avoid, maxNew, capEnvLabel, fetchBoardJobs, jobIdFor, mapJob })`** — the gate loop (seen/cache/avoid/title, cap, stale-seen prune) with the three per-ATS functions injected. Counts and prune semantics unchanged from greenhouse.js.

Tests for moved helpers move to `ats_common.test.js`; `greenhouse.test.js` keeps `mapGhJob` (and gh imports update). Constants (`PROBE_CAP=25`, `PROBE_DELAY_MS=300`, `FETCH_TIMEOUT_MS=10s`) move to ats_common.

## keka.js specifics

- **Probe:** tenant guesses from `tokenCandidates(name)` (all guesses are valid subdomain chars already). For each: GET `careerportalinfo`; JSON with a `name` that passes `verifyBoardName` ⇒ hit `{ tenant, name }` (containment match absorbs "PRIVATE LIMITED" suffixes). Ledger: `keka_probe_ledger.json`, same shape as gh (`{ token: tenant|null, probed, name? }`).
- **Fetch:** per board — GET `careerportalinfo`, extract GUID via exported pure helper `extractPortalGuid(str)` (regex `/ats\/documents/<uuid>/` over the JSON text; caller falls back to the `/careers/` HTML). No GUID or fetch error ⇒ board counted failed, skipped (fail-soft). Then GET `embedjobs/default/active/<guid>`.
- **Map (`mapKekaJob(job, board, tenant, todayStr)`):**
  - `job_id: kk-<id>` · `job_url: https://<tenant>.keka.com/careers/jobdetails/<id>` · `source_query_url`: the embedjobs API URL.
  - `raw_text`: `htmlToText(description)`, prefixed with `Experience: <experience>. ` when `experience` is a non-empty string (direct YoE signal for /structure), sliced to `JD_MAX_CHARS` (default 2500).
  - `card_location`: unique `jobLocations[].city` (fallback `.name`) joined `", "`, else null. (Consumed as a hint column by /structure, not matched directly by filter.js.)
  - `card_company`: board display name · `card_title`: `job.title` · `date_found`: today.
- **Watchlist:** `profiles/<p>/keka_boards.md`, identical `- Name - tenant` format, `## Curated` / `## Auto-discovered` sections. Template at `templates/keka_boards.md`. Absent watchlist + empty ledger ⇒ lane disabled, exit 0.
- **State:** `data/keka_probe_ledger.json`, `data/keka_seen.json` (kk-id → date, pruned only after a complete fetch of every board — same rule as gh).
- **Cap:** `KEKA_MAX_NEW` (default 40).
- **Fail-soft:** identical to greenhouse.js — single board failure logged + skipped; all-boards-failed notifies (best-effort) and exits 0; only a malformed watchlist is a hard error.

## Wiring

- `lib/config.js` `paths()`: + `kekaBoards`, `kekaProbeLedger`, `kekaSeen`.
- `ops/doctor.js`: generalize `checkGreenhouse()` into one watchlist-lint helper called for both `greenhouse_boards.md` and `keka_boards.md` (absent file = "optional — lane disabled" pass).
- `.claude/commands/keka.md`: new, mirrors greenhouse.md (adjusted names/ids/recovery file).
- `.claude/commands/run.md`: new step 5 `/keka` between `/greenhouse` and `compress` (renumber; same fail-soft language).
- `CLAUDE.md`: extend the `/greenhouse` special-case bullet to cover both ATS lanes; add `/keka` to the stage-command list.
- Profile seed (local, untracked): `keka_boards.md` for harish + uvashree with `- SurveySparrow - surveysparrow` under Curated.

## Testing

- `ats_common.test.js`: moved helper tests + `parseWatchlist` filename-in-error + `readJsonOr` + `runFetchPhase` gates/cap/prune via injected fakes (pure, no network).
- `keka.test.js`: `mapKekaJob` (shape, kk- prefix, experience prefix, JD_MAX_CHARS trim, location join/fallback/null), `extractPortalGuid` (portal-info JSON, HTML, no-match).
- `greenhouse.test.js`: mapGhJob tests remain; moved tests deleted here.
- Live verification pre-PR: run keka.js against a scratch profile watchlisted to SurveySparrow; confirm probe hit path + emitted record shape end-to-end; `npm test` green.

## Out of scope (explicit)

- Lever/Ashby lanes (no yield — revisit only with evidence), Zoho Recruit/Freshteam/Darwinbox adapters, shared multi-ATS probe ledger (re-raised if ATS #3 lands), `jobType` enum mapping, `publishedOn` staleness gating.
- Notion roadmap/design-doc updates happen at `/wrap`, not in this branch.
