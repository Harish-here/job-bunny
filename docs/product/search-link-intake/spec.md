# Spec — Search-link intake (paste any LinkedIn search link, it just works)

Slug: `search-link-intake` · Author: product-pm · 2026-09-28 · Mode: UNATTENDED (every open question
decided on its recommended default; see Resolved Q&A) · Persona: P1 "The Operator-Owner", tuner hat
(`docs/product/personas.md` v1.5).

---

## 1. Problem & Goal

**The ask, as stated:** "the urls whatever i paste suppose to work without even sanitizing." It
started as a bug report: "Job Bunny is not running properly at the scheduled times, except for the
day's first run."

**Five whys (kept short):**
1. *Why do later runs fail?* Every slot after 09:00 on `harish` fails at `farm` in about 3 minutes.
   This started on 09-23 (runs 166, 167, 170-173). Every slot passed from 09-15 to 09-22.
2. *Why farm?* The LinkedIn lane's leftover links all fail, so the lane throws "all URLs failed".
   LinkedIn is the only farming lane, so `farm` treats that as a total outage and aborts the run.
3. *Why do the leftovers fail?* On 2026-09-22 at 16:47Z, three `/jobs/search-results/` links were
   saved through board Settings. Settings filed all three under the `linkedin__jobs-search` page type.
   The lane then used the wrong selectors for them, and the results list never attached.
4. *Why were they misfiled?* Settings stamps every new row with a hard-coded default page type. Only
   the CLI (`lane add-url`) works out the page type from the URL and strips per-click parameters. That
   cleaner lives in `src/cli/`, and layer rules keep the board from reaching it.
5. *Why did one bad link take out four of five daily runs?* The first slot handles every link, and the
   good ones succeed. Each good link is then marked done for the day, so later slots only try the
   leftovers. When the only leftovers are bad links, "all attempted links failed" looks exactly like an
   expired login.

**Underlying problem:** there are two defects, and they compound.
- **Intake:** two of the three ways to save a link (Settings, `config set`) accept a link without
  understanding it.
- **Outage check:** the pipeline's outage check can't tell "one bad link" from "LinkedIn is down"
  once the day's set has shrunk.

**Goal (outcome):** a link the user pastes from LinkedIn's jobs pages works on every save path, with
no hand-cleaning. A single bad link can never again cost the rest of the day's runs. A real outage
(expired login) must still fail loud.

## 2. Persona & JTBD

- **Persona:** P1, the Operator-Owner, first in the **tuner hat** (adding a search calmly) and then,
  when it breaks, in the **operator hat** (Telegram failure page, then the board).
- **Canonical job (JTBD-4, refined):** When I find a LinkedIn search worth watching, I want to paste
  its link wherever I happen to be (board or terminal) and have it scraped from the next run on, so
  aiming the machine takes seconds and never breaks it.
- **Secondary job (JTBD-3):** When a run fails, I want the failure to name what actually broke. An
  "outage" page for what was one bad link sends me down the wrong path.
- **Persona evidence added this run:** the user's own expectation is that pasted input should work
  without sanitising. Settings violated that silently, and the first sign was days of failed runs.

## 3. Industry Research

One research pass (product + UX + reliability). This synthesis is my judgment. Sources are cited.

| Pattern | Evidence | What we take |
|---|---|---|
| Clean links automatically, from a known-parameter list | Firefox "Copy Clean Link" and query stripping use a list of known tracking parameters ([Bugzilla 1924493](https://bugzilla.mozilla.org/show_bug.cgi?id=1924493), [Firefox query-stripping docs](https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/query-stripping/index.html)); canonicalisers strip `utm_*`, `gclid`, `fbclid` and similar ([canonical-url](https://github.com/kinu01/canonical-url)) | **Table stakes.** Strip silently using an explicit list. Never ask the user to clean a link. Our list already exists (`EPHEMERAL` in `lane_add_url.ts`). It has to move, not be reinvented. |
| Accept any URL and work out what it is | RSS readers take a homepage URL and discover the feed ([Inoreader web feeds](https://www.inoreader.com/blog/2020/04/convert-almost-any-webpage-into-rss-feed-with-inoreaders-web-feeds.html)). If discovery fails, they offer choices rather than guessing ([Inoreader 2021](https://www.inoreader.com/blog/2021/01/make-your-life-easier-by-finding-rss-feeds-for-your-favorite-sites.html)) | **Classify from the URL, never from a default.** When classification fails, say so. Do not silently file the link somewhere. |
| LinkedIn scrapers accept only recognised URL shapes | Apify LinkedIn scrapers accept listed URL forms and skip unrecognised ones with a log note ([apt_marble](https://apify.com/apt_marble/linkedin-job-listings-scraper-by-url)) | Rejecting unknown shapes at the door is normal practice. Our CLI already does it (`resolvePage` throws). |
| Don't validate mid-paste; show the result | Premature inline validation breaks copy-paste flows ([Baymard](https://baymard.com/blog/inline-form-validation)). Validate on blur and give positive confirmation ([Smashing 2022](https://www.smashingmagazine.com/2022/09/inline-validation-web-forms-ux/)) | UX hand-off: check on blur or save, and show the derived page type as positive feedback. |
| Partial failure is not an outage | Circuit-breaker pipelines accept some failed items and keep going ([Medium, circuit breakers for distributed jobs](https://medium.com/@admirxsaheta/how-circuit-breakers-protect-distributed-jobs-from-fragile-external-services-83f917323edf)). Airflow is adding per-task failure budgets ([PR 67724](https://github.com/apache/airflow/pull/67724)) | **Tell outage from bad input by checking against something known to be good.** Don't just count failures in a set that has shrunk. |
| Anti-pattern: one bad step fails the whole flow | In Zapier, one failed step fails the rest of the Zap ([Zapier help](https://help.zapier.com/hc/en-us/articles/8496037690637-How-to-troubleshoot-errors-in-Zap-workflows)) | Our current behaviour is this anti-pattern. |

## 4. Classification

**Change to existing.** Recon shows all three save paths, the parser, and the outage guards already
exist (see Current State). This is not a greenfield repo, so there is no stack question. The slice
touches **core pipeline** code (`adapters/lanes/linkedin/`), so the CLAUDE.md Stability principle
applies in full.

## 5. Current State

| Area | Today | Ref |
|---|---|---|
| Settings save | New rows get `DEFAULT_SLUG = 'linkedin__jobs-search'` whatever the URL. The page-type badge is read-only. Client checks cover protocol, host and label only. | `ui/src/features/settings/sections/SearchUrlsSection.tsx:23,30-45,72,134` |
| Board API | `PUT /api/profiles/:name/config/:doc` goes to `writeConfigDoc`, which has no URL awareness | `src/app/features/config/routes.ts:104-120,152-154` |
| `config set` / API validator | `search_urls.md` checked only for being non-empty after trim | `src/core/config/validators.ts:86-90` |
| CLI `lane add-url` | `stripEphemerals()` removes `currentJobId, referralSearchId, origin, originToLandingJobPostings, savedSearchId, alertAction, trackingId, refId, eBP, start` plus an absolute `f_TPR=a<epoch>`. `resolvePage()` routes `/jobs/search`, `/jobs/collections/*` → `linkedin__jobs-search`; `/jobs/search-results` → `linkedin__jobs-search-results`; anything else throws. | `src/cli/commands/lane_add_url.ts:95-127` |
| Shared URL logic in core | None. No parse/normalise module exists in `src/core/`. | recon |
| Parser | `parseSearchUrls` groups URLs by heading (page slug). It trusts the heading and never checks the URL. | `src/adapters/lanes/linkedin/search_urls.ts:17` |
| Day-done marking | A URL that succeeded is recorded in a per-day `done` map (`lanes/linkedin/extract_resume.json`). Later slots try only the others. | `url_runner.ts:96`, `resume_state.ts:33,59-61` |
| Lane guard | Throws when `attemptedUrls > 0 && failedUrls === attemptedUrls`. Tested. | `lane.ts:325-328`, `lane.test.ts:502` |
| Farm guard | All attempted farming lanes failed (skipped lanes excluded) → total outage. LinkedIn is the only farming lane. | `src/pipeline/stages/farm.ts:110-136` |

Established root cause (orchestrator-verified, not re-investigated):
- `currentJobId` is harmless: raw and stripped links render the same, and LinkedIn re-appends it.
- **Misfiling is the cause.** The user's two correctly-filed `/search-results/` links work.

## 6. Gaps

1. **G1 Intake:** the page type isn't derived from the URL on 2 of the 3 save paths.
2. **G2 Intake:** ephemeral parameters aren't stripped on 2 of the 3 paths. Some of them matter for
   correctness:
   - `start` skips page 1.
   - `f_TPR=a<epoch>` goes stale.
   - Per-click parameters defeat duplicate detection.
3. **G3 Architecture:** the only correct cleaner sits in `src/cli/`, which neither `src/app/` nor `ui/`
   can reach.
4. **G4 Data:** `harish` still has 3 misfiled links saved.
5. **G5 Reliability:** the outage checks (`lane.ts:325` → `farm.ts:131`) misfire on the day's leftover
   set. Any link that keeps failing turns every later slot into a "total outage".
6. **G6 Alert quality:** the failure page says "outage" when the truth is "these 3 links are broken".

## 7. Relevance Verdict

**Case against building, stated first:**
- The immediate damage is 3 links on one profile. Re-adding them with `jobbunny lane add-url` fixes
  the user's runs today in about two minutes with zero code.
- The audience is one person who knows the CLI.
- Part (c) edits the most safety-critical path in the pipeline, the outage check. It does so to cover
  a failure that took a UI bug to trigger. The Stability principle warns against exactly this trade.

**Why it doesn't hold:**
- The trap stays armed. Every future Settings add of a `/search-results/` link repeats the outage, and
  Settings is the path the settings-overhaul epic built to replace hand-editing.
- The amplifier doesn't depend on the UI bug. Any link that keeps failing for any reason (a deleted
  saved search, LinkedIn changing a URL shape) silently costs 4 of 5 daily runs. The alert blames the
  wrong thing, which breaks the persona's "alert quality is load-bearing" rule.
- The fix to (a) mostly moves code that already exists. (c) can be small and testable if it is scoped
  to the lane's own guard.

**Verdict: BUILD**, as one slice. Engineering is gated per the Stability constraints (blast-radius
review, judge pass before code, live verification on `rajni`). This is a recommendation; the
orchestrator decides.

## 8. Resolved Q&A

All answers below are **ASSUMED (unattended)**. Each is the recommended default. None came from the user.

1. **Where does the shared cleaner/classifier live?** ASSUMED (unattended): a new
   **dependency-free** module in `src/core/` (plain `URL`, no imports). That way the CLI, the app
   layer, *and* `ui/` can all use it; CLAUDE.md allows `ui/` to import dependency-free core modules.
   `lane_add_url.ts` must delegate to it.
2. **What does a save do with a recognised but dirty link?** ASSUMED (unattended): normalise it
   silently (strip ephemerals, file by path), and show the user the result: the derived page type, and
   the cleaned URL where it changed. There are no prompts.
3. **What about an unrecognised link (not a LinkedIn jobs search/collections/search-results path)?**
   ASSUMED (unattended): **reject at save** with a one-line reason naming the link, on every path. This
   matches the CLI's existing `resolvePage` throw and the research (don't guess). No "file it anyway"
   escape hatch.
4. **Does `config set` / the raw API rewrite the doc or reject misfiled lines?** ASSUMED (unattended):
   run the same normalisation, so misfiled or dirty lines are re-filed and cleaned. Report what
   changed. Reject only unrecognised links. Reason: "whatever I paste should work" applies to every
   path, and rewriting the user's own save while reporting it is not clobbering.
5. **Duplicates after cleaning?** ASSUMED (unattended): two links that are identical after cleaning
   collapse into one, and the save reports this.
6. **How is the repair (b) done?** ASSUMED (unattended): push the stored `harish` doc through the new
   normalising save path. Show a before/after diff first (dry run). Write only after **separate
   explicit user approval**. No bespoke migration code unless product-be finds the save path can't do
   a dry run.
7. **How does the outage check stop misfiring (c)?** ASSUMED (unattended), mechanism PROVISIONAL:
   - When a later slot's leftover links all fail, the lane retries **one link already done today** as
     a canary.
   - Canary succeeds → the leftovers are recorded as per-link soft errors. The run goes on, and the
     digest names the failing links.
   - Canary fails, or there are no done links → today's loud failure, unchanged.
   - Farm's guard is left alone. Any alternative that product-be/product-ui propose must still pass
     every acceptance criterion in §11. Rejected alternative: "count done-today links as successes".
     It would hide an expired login that happens after the first slot.
8. **Should Settings let the user override the derived page type?** ASSUMED (unattended): no. The page
   type is derived and shown, never chosen. A picker would bring back the misfiling class.
9. **Which profiles are in scope?** ASSUMED (unattended): the behaviour covers all profiles. Live
   verification uses `rajni` only. The data repair covers `harish` only, behind approval.

## 9. Tech Story

*Written backwards from the moment the job is done.*

> On the 16:30 slot, Harish's board shows new jobs from the Comcast search he pasted into Settings
> two days ago. That happened because the link was stored under the page type its URL belongs to,
> with its per-click parameters stripped, by the same core function the CLI and `config set` use. If a
> link ever goes bad, the lane first confirms that a link already known good today still loads. It
> then logs the bad link as a soft error rather than aborting, so the run completes and the Telegram
> digest names the link. If even the known-good link fails, the run fails loud exactly as it does
> today.

Testable pieces:
- a pure `classify + clean` function, with a table-driven test;
- three call sites wired to it;
- one lane guard branch, with a unit test for each outcome;
- one data repair, dry run first.

## 10. Content Priority

This ranks what matters most. Screen layout belongs to product-ux.

1. The link gets filed correctly with no user effort. This is the fix.
2. A bad later-slot link doesn't kill the day's runs, but a real outage still fails loud.
3. An unrecognised link is refused at save with a reason the user can act on.
4. The user can see what page type the link was filed under, and what was stripped.
5. The failure digest names the bad link instead of saying "outage".
6. The one-time `harish` repair.

## 11. Requirements

| # | Requirement | Source | MoSCoW |
|---|---|---|---|
| R1 | One dependency-free core module classifies a LinkedIn URL to its page type by path (`/jobs/search`, `/jobs/collections/*` → `linkedin__jobs-search`; `/jobs/search-results` → `linkedin__jobs-search-results`) and strips the ephemeral list (today's `EPHEMERAL` + absolute `f_TPR`), keeping relative `f_TPR=r<n>` | Recon gap G2, G3; research (list-based stripping) | Must |
| R2 | Board Settings files each new or edited link by R1's derived page type. The hard-coded `DEFAULT_SLUG` is gone. | Ask; recon gap G1 (`SearchUrlsSection.tsx:23,72`) | Must |
| R3 | The board API and `jobbunny config set` put `search_urls.md` through R1 on save: re-file, clean, and report changes | Ask ("whatever I paste"); recon gap G1/G2 (`validators.ts:86`) | Must |
| R4 | Every save path rejects a link R1 cannot classify, with a one-line reason naming the link. Nothing is written. | Research (Inoreader, Apify reject-don't-guess); CLI parity | Must |
| R5 | `jobbunny lane add-url` delegates to R1. The logic is not duplicated. | Recon gap G3; CLAUDE.md two-pair / single-source conventions | Must |
| R6 | When a later slot's attempted links all fail but a link already done today still loads, the failures are per-link soft errors and the run continues | Recon gap G5; research (partial failure is not an outage) | Must |
| R7 | A genuine outage (a known-good link also fails, or there is no known-good link) still fails loud exactly as today | CLAUDE.md fail-loud invariant; user constraint | Must |
| R8 | One-time repair of `harish`'s `search_urls.md`: dry-run diff first, written only after separate explicit user approval | User constraint; recon gap G4 | Must |
| R9 | Settings shows each link's derived page type, and tells the user when a link was cleaned or refused | JTBD-4 (friction removal); research (show the result, validate on blur) | Should |
| R10 | Links that are identical after cleaning collapse into one on save | Recon gap G2 (per-click params defeat dedup) | Should |
| R11 | Run digest / run detail names each link that soft-failed under R6 | Persona (alert quality is load-bearing); gap G6 | Should |
| R12 | Architecture docs updated in the same change: explainer KB, module contracts, and CLAUDE.md if the guard's description changes (CLAUDE.md edits need user approval) | CLAUDE.md conventions | Should |
| R13 | Existing misfiled links are flagged when Settings loads (any profile) | Gap G4 generalised | Could |

## 12. Acceptance Criteria

1. The R1 function, given each of the user's 3 Comcast/Zafin/Shell links
   (`/jobs/search-results/?currentJobId=…&origin=…&referralSearchId=…`), returns page
   `linkedin__jobs-search-results` and a URL with none of the R1 ephemeral parameters.
2. The R1 function maps `/jobs/search/?keywords=x` and `/jobs/collections/recommended/` to
   `linkedin__jobs-search`. It keeps `f_TPR=r86400`, strips `f_TPR=a1726000000-`, strips `start=25`,
   and leaves all other parameters byte-identical and in order.
3. The R1 function rejects `https://www.linkedin.com/feed/`, `https://example.com/jobs/search/`, and a
   non-URL string, and the error names the input.
4. The R1 module imports nothing: no `node:` builtins, no other `src/` module. `npm run ui:build`
   passes with Settings importing it.
5. After saving a `/jobs/search-results/` link through board Settings on `rajni`, `config get
   search_urls.md` shows it under the `linkedin__jobs-search-results` heading, cleaned.
6. `jobbunny config set search_urls.md` on `rajni`, given a doc with one misfiled and one dirty link,
   writes the re-filed, cleaned doc and prints the changes. Given an unrecognised link, it exits
   non-zero and writes nothing.
7. The board API `PUT …/config/search_urls.md` with an unrecognised link returns a 4xx naming the link.
   The stored doc is unchanged.
8. `lane add-url` behaves exactly as before on its existing tests, and its source no longer contains
   its own ephemeral list or path mapping.
9. Lane unit tests cover:
   - (a) leftovers all fail and the canary succeeds → no throw, soft errors per link;
   - (b) leftovers all fail and the canary fails → the existing all-URLs-failed throw;
   - (c) first slot of the day, every link fails → the existing throw;
   - (d) no link done today → the existing throw.
   The existing `lane.test.ts:502` test still passes.
10. Live on `rajni`:
    - with one deliberately bad link plus good links, a second same-day run passes, and its run
      detail/digest names the bad link;
    - with Chrome logged out, a same-day later run still fails at `farm` with the loud total-outage
      error.
11. The `harish` repair prints a before/after diff showing exactly the 3 links moved to
    `linkedin__jobs-search-results` and cleaned. Nothing is written without the user's explicit
    approval.
12. `npm run check` and the CI `ui` job are green. A judge pass on the blast-radius/failure-mode
    analysis of R6/R7 is recorded before any lane code is written.

## 13. Success Metrics

- For the 3 days after ship and repair, every `harish` later slot (11:30/14:00/16:30/19:00) passes
  `farm`. Today it is 0 of 4 per day.
- Across all profiles, zero links in `search_urls.md` sit under a heading that disagrees with R1's
  classification.
- In the first month, zero "total outage" failure digests where a same-day earlier slot passed and
  login was valid.
- The user adds a new search from Settings with no follow-up CLI or hand-edit. Observed on the next
  add.

## 14. Out of Scope

| Cut | Reason |
|---|---|
| Live preview (load the link in Chrome at save time to prove it works) | Needs Chrome from the board, which breaks the one-Chrome / daemon-is-sole-spawner invariant. That is a feature of its own. |
| Per-link health tracking / automatic quarantine after N failures | A wider reliability feature. R6/R7 fix the misfire without new persistent state. |
| Routing by URL at read time in the parser (ignore headings) | Would also repair old data. But it means a second change to the core pipeline, and headings stop being truthful. Write-time normalisation plus a one-time repair is smaller. |
| Letting ATS lanes run when LinkedIn fails ("degraded run" status) | Already recorded as a deliberate, accepted cost in `farm.ts:119-129`. A feature, not this slice. |
| Page types beyond the two existing inventories | YAGNI. New shapes arrive through `/page-analyse` plus an R1 mapping, which is a known one-line extension. |
| A manual page-type override in Settings | Brings back the misfiling class (Q&A 8). |
| Stripping generic tracking parameters (`utm_*`, `gclid`) | No evidence they show up in LinkedIn jobs links. Adding one to the list later is trivial. |

## 15. Four-Risks Scorecard

| Risk | Score (1-5, 5 = low risk) | Rationale |
|---|---|---|
| **Value** | 5 | The evidence is direct: 4 of 5 daily runs lost from 09-23, the user's own words, and a trap still armed for every future Settings add. |
| **Usability** | 4 | Open concerns handed to product-ux, not answered here: how the derived page type is labelled for a user who never thinks in inventory slugs; how "cleaned" is shown without noise; where a refused link's reason appears; whether R13 (flag existing misfiles) earns its space. |
| **Feasibility** | 3, **PROVISIONAL** (product-ui/be confirm) | **Named weakness:** R6/R7 change the core pipeline's outage check. The canary adds one navigation per failing later slot, which adds throttle exposure under LinkedIn pacing and the breaker. A canary could also succeed while the session is half-broken, on a page-specific soft-block. This needs the Stability-principle blast-radius review, and **it is the riskiest assumption**: that re-visiting one known-good link reliably tells "bad link" apart from "outage". R1–R5 are low risk, because they relocate code that already exists. |
| **Viability** | 4 | No new dependencies. Stays inside the board's existing write surface (the config tables). The layer rules are satisfied by placing R1 in core. Cost: a docs-as-code update (R12). Any CLAUDE.md change needs separate user approval. |

**Verdict (derived):**
- Value is high and the scorecard has no blocker. The one weakness, the guard change, is contained by
  the §12 criteria 9, 10 and 12.
- **BUILD.**
