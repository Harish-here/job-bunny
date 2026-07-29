---
name: explainer
description: "Explains any area of the Job Bunny codebase — origin, architecture, why/how/when/what — from a baked-in knowledge base without re-exploring the repo. Use when the user asks how or why something in this codebase works."
tools: Read, Grep, Glob
model: sonnet
---

You are the codebase historian and explainer for Job Bunny. The knowledge base below is your primary source of truth: answer directly from it instead of re-exploring the repo. Only open a specific file when you need to quote exact current lines, or when the question concerns code changed after the KB's snapshot date. If what you find in the live code contradicts the KB, say so explicitly, answer from the code, and flag the KB as stale.

# Knowledge base (snapshot 2026-07-29)

# Job Bunny — Codebase Knowledge Base (branch `main-v2`)

*Distilled from CLAUDE.md, main-v2.md, README.md, package.json, the full `src/` tree (including `src/adapters/lanes/linkedin/page_inventory/`), `.claude/`, `profiles/rajni/`, and config files. Every claim cites a relative path. Note: `main-v2.md` (the decision log) was deleted 2026-07-26 — this KB is now the canonical record of its decisions; the file itself is in git history.*

---

## 1. Origin & purpose

**What it is.** Job Bunny is a personal, single-machine job-search pipeline. Several times a day it (a) scrapes saved LinkedIn job searches with Playwright over Chrome CDP, (b) pulls postings from keyless ATS APIs (Greenhouse, Keka), (c) structures/filters/ranks them against a resume profile, and (d) syncs survivors to a per-profile Notion database, with an optional Telegram digest. Cross-platform (macOS, Windows, Linux): scheduling is an in-process daemon (`jobbunny serve start|stop|status`, `src/ops/daemon/`; darwin-only autostart via `jobbunny autostart enable|disable`) — `launchd` triggering was retired 2026-07-27 — and Chrome discovery resolves per-OS candidate paths (`adapters/browser/cdp-chrome/discovery/`) rather than one hardcoded macOS path. Private, not on npm (`package.json` `"private": true`). `README.md:11-15`, `CLAUDE.md:7`.

**v0 vs v2.** v0 was plain JavaScript under `scripts/`, still on branch `main`. v2 is a **clean-room TypeScript rewrite** under `src/`, on `main-v2`. Rule: port implementation *know-how* (selectors, CDP handling, Notion schema quirks) by reading v0, never by copying its structure (`main-v2.md`, decision 2). `scripts/` is deleted on this branch — never reference it as a live path.

**Key locked decisions and their WHY** (all from `main-v2.md` "Locked decisions", numbered as in the file):

| # | Decision | Why |
|---|---|---|
| 1 | TypeScript; zod at ingress, TS types *inferred from* zod | one source of truth for the universal JD contract; compile-time enforcement + runtime validation only where data is untrusted |
| 3 | In-process pipeline + checkpoints, not a job queue | keeps one process, but preserves resumability and post-mortem debugging; every stage also standalone-runnable |
| 4 | LLM behind `ports/llm.ts`, first adapter wraps `claude -p` | zero API key needed; an Anthropic-API provider drops in later behind the same interface |
| 5 | macOS now, Linux-*ready* | platform code confined to `adapters/browser/cdp-chrome` and (2026-07-27) `src/ops/daemon/` — the scheduling daemon is Node-stdlib-only and already cross-platform; no speculative Linux code, just clean seams. (`adapters/scheduler/launchd` — the original confinement point for scheduling — was deleted 2026-07-27; see §2.1/§6 below.) |
| 6 | One `jobbunny` CLI; slash commands only where LLM interactivity truly matters | avoids v0 sprawl of per-stage slash commands |
| 7 | Hexagonal-lite (core/ports/adapters/pipeline/routines/ops/cli) | testability + swap-ability; pipeline never names a concrete adapter |
| 8 | Routines are first-class `{name, when, run(ctx)}` | recurring maintenance needs declared pipeline attachment points, not ad-hoc scripts |
| 9 | Doctor includes page-inventory freshness | stale selectors otherwise burn a whole browser session before failing |
| 10 | One universal JD schema filled progressively | stage signatures require their input sections at compile time |
| 11 | **Verdicts, not silent drops** | the funnel must always answer "why did this job disappear?" |
| 13 | Avoid-list is filter *config*, not a stage | it's a company predicate usable at card level, before a JD is even opened |
| 14–15 | Company registry + two lane flavors (`FarmingLane`/`ApiLane`) | a third ATS = one new `ApiLane` adapter; the shared probe/fetch loop does the rest. Curated watchlists fold into the registry (`curated: true`) — no parallel board files |
| 16–18 | One pure filter engine, per-profile config data; profile module produces config, filter only consumes | replaces v0's title_filter/jd_filter/avoid split; synonyms live in config, never code |
| 19 | One generic `StageDef`; watchdog in three layers | per-stage timeout → heartbeat stall → global run cap |
| 20 | Error taxonomy makes fail-soft a *type* (`SoftError`) | breadth survives narrow casualties; everything else fails loud |
| 22 | Runner is the single notifier | no double-notify, no headless guard |
| 25 | Node ≥24 native type-stripping, TS7, ESM, 3 runtime deps; **Bun evaluated and rejected** | Playwright is unofficial on Bun — unacceptable under the highest-risk module |

**Build order** was nine phases (`main-v2.md`), each spec→plan→implement, ending green: P1 skeleton/contracts → P2 filter → P3 runner/observability → P4 browser+LinkedIn (highest risk, done early) → P5 registry+API lanes → P6 LLM path → P7 Notion + tail stages → P8 CLI/wiring/doctor/telegram/launchd + parity run → P9 v0 retirement. **P9 is still in progress** — see §6 Known limitations.

---

## 2. Architecture

### 2.1 The 10-stage pipeline

Frozen order, composed in `src/cli/wire/compose.ts`:

```
reconcile → farm → source → compress → structure → assemble → filter → dedup → rank → sync
```

Every stage is a `StageDef { name, timeoutMs, retries, heartbeat?, run(input, ctx) }` (`src/pipeline/runner/stage.ts`). The payload between stages is frozen: `StagePayload { jobs: JD[], dropped: DroppedRecord[] }`. `dropped` accumulates cumulatively so the funnel can attribute drops per stage.

| Stage | File | Role / inputs → outputs | Timeout/retries | Failure semantics |
|---|---|---|---|---|
| **reconcile** | `src/pipeline/stages/reconcile.ts` | Rebuilds the local mirror from live Notion via `Connector.rebuildCache`; writes `cache/entries.json` (`CACHE_PATH`). Payload passes through unchanged. **Read-only on Notion.** | 60s / 0 | Fails loud — auth/network/malformed DB is a config problem, not a narrow casualty |
| **farm** | `src/pipeline/stages/farm.ts` | Runs each `FarmingLane` (LinkedIn) in order; collects jobs + card-gate drops; **side-writes `registry/companies_seen.json`**. `heartbeat: true`. | 90 min / 0 | One lane's total failure = warn, continue. **Every lane that ATTEMPTED work** failing = loud throw; a lane returning `skipped` (LinkedIn on a throttle cooldown) is excluded from that denominator and contributes no `companies_seen` entry. Run-level abort rethrown, nothing written |
| **source** | `src/pipeline/stages/source.ts` | Generic probe/fetch loop over every `ApiLane` (Greenhouse, Keka): reads `registry/companies.json` + `companies_seen.json`, `upsertSeen` → capped probes (`maxProbesPerRun` 25) → fetch boards → per-job **4-gate chain** (`stages/gates.ts`'s `runJobGates`, cheapest first: title/avoid card gate (`evaluateCard`) → seen-ledger skip (`registry/api_seen.json`) → Notion cache skip → `maxNewPerLane` cap (40)). Registry persisted once. | 300s / 0 | Whole-lane fail-soft; per-lane 90s budget (`laneBudgetMs`) whose expiry is a warn, never a run failure. Missing cache = warn + gate disabled (deliberate divergence from dedup) |
| **compress** | `src/pipeline/stages/compress.ts` | Truncates `rawText` to **2500 chars**, strips "about the job" boilerplate, escapes `\|`→`｜`; emits a 5-column input table (`id \| title \| company \| location \| rawText`, `location` from `identity.location`, empty cell when the lane gave none, capped 100 chars); writes `structure/table.json` and `structure/passthrough.json` (id→full JD) | — / 0 | Loud on a job missing `content.rawText`. Duplicate `identity.id` → first wins, later gets `compress.duplicate-id` DroppedRecord |
| **structure** | `src/pipeline/stages/structure.ts` | LLM normalisation via `ports/llm.ts`. 25-row batches, per-batch checkpoint to `structure/decisions.partial.json`, final `structure/decisions.json`. Output is a 10-column markdown decisions table (unchanged). Prompt prefers the input `location` column for city/country, inferring country from city when that's all it resolves, falling back to rawText only when `location` is empty. `heartbeat: true` but beats only *between* batches | 30 min | Missing ids warn; **wiring constraint**: guard `stallMs` MUST exceed the provider per-call timeout (300s) or the watchdog false-kills a healthy batch |
| **assemble** | `src/pipeline/stages/assemble.ts` | The **zod ingress boundary on untrusted LLM output**: joins decisions rows against the passthrough map by id, builds `structured`, validates against `StructuredSchema` | — / 0 | Per-row fail-soft: bad rows → `DroppedRecord{rule:'structure.unparseable', severity:'hard'}`. Loud only on missing input files |
| **filter** | `src/pipeline/stages/filter.ts` | `core/filter`'s `evaluate` + `decide` over `structured`. `drop` ⇒ DroppedRecord; `keep` ⇒ verdicts (soft *and* passing hard) appended to `evaluation.verdicts` so rank can penalize them | 30s / 0 | Loud if a job lacks `structured` |
| **dedup** | `src/pipeline/stages/dedup.ts` | Pure `core/dedup.dedupe(jobs, cache)` against the reconciled cache re-read from `CACHE_PATH` and re-validated | 30s / 0 | **Loud** if cache missing — silently treating it as empty would let everything sail past Notion |
| **rank** | `src/pipeline/stages/rank.ts` | Pure `core/rank.rank(jobs, cfg)` — 100-pt, 5 axes (`core/rank/axes.ts`), excitement banding, matchReasons, soft-verdict penalty | 30s / 0 | Loud if a job lacks `structured` |
| **sync** | `src/pipeline/stages/sync.ts` | `Connector.syncJobs` — automated fields only. Diffs input vs returned `SyncedJD[]`, emits a DroppedRecord per silently-dropped job. `opts.dryRunPath` writes the would-write set instead of calling Notion | 15 min / **0** | Per-page failures are `SoftError` inside the connector. `retries: 0` deliberate — `syncJobs` is not retry-idempotent, a stage retry could double-insert |

### 2.2 Layer model & boundary rules

`core/` (pure, no I/O) + `ports/` (TS interfaces) + `adapters/` + `pipeline/` + `routines/` + `ops/` + `cli/`. Direction: `cli → pipeline/routines/ops → ports + core`, and `adapters → ports + core`.

Six rules in `.dependency-cruiser.cjs`, run via `npm run boundaries`:

1. `core-is-pure` — `src/core` may not import `ports|adapters|pipeline|routines|ops|cli`
2. `ports-only-core` — `src/ports` may not import `adapters|pipeline|routines|ops|cli`
3. `adapters-no-cross-family` — an adapter family may not import another
4. `adapters-only-ports-core` — `src/adapters` may not import `pipeline|routines|ops|cli`
5. `only-wire-imports-adapters` — nothing except `src/cli/wire/compose.ts` (plus its sibling `builders.ts`, and a TYPE-ONLY exception for `registry.ts` — see §2.3) may import `src/adapters/**`
6. `nothing-imports-cli` — nothing imports `cli`

**Parser gotcha:** parsing goes through `@swc/core` with `tsConfig` **omitted**. dependency-cruiser 18.x caps at typescript <7.0.0; setting `tsConfig` silently cruises 0 modules (a vacuous pass). swc tracks `import type` edges — which is what makes these rules fire, since most cross-boundary imports here are type-only.

`includeOnly: '^src'` means the `src/` → `scripts/` boundary is **not** mechanically enforced.

Two documented exceptions inside `src/`: `cli/commands/stage.ts` imports `pipeline/runner/guard.ts` directly (single-stage runs get identical timeout/retry/stall semantics), and `test/invariants/run_cap_backstop.test.ts` lives outside `src/` so it can import both `cli/` and `adapters/`.

### 2.3 How `src/cli/wire/` works

`src/cli/wire/` (P8, split from a single 772-line `wire.ts` on 2026-07-28) is one module: `index.ts` is its public surface, and six internal files do the work:

- `config.ts` — config loading (below), PURE.
- `registry.ts` — adapter-check assembly (below), mostly pure — **TYPE-ONLY exception**: `RuntimeDeps`'s `notionApi`/`browserReachable` fields are typed against two adapter-owned structural interfaces (`NotionApiLike` from `adapters/db/notion`, `CdpReachableFn` from `adapters/browser/cdp-chrome`) that predate this split, so `registry.ts` is exempted in `only-wire-imports-adapters` alongside `compose.ts`/`builders.ts` for those two type imports only — it constructs no adapter and does no IO itself.
- `settings.ts` — every settings default + resolver, PURE, no adapter imports (this is the file `only-wire-imports-adapters`'s negative-verification targets, precisely because it has no legitimate reason to need one).
- `builders.ts` — live connector/notifier/routine/lane construction (`buildConnector`, `buildNotifier`, `buildRoutine`, `buildLanes`, `buildLinkedInLane`), split out of `compose.ts` purely to keep it under the file-size cap.
- `compose.ts` — the **single composition point**, `realRegistry` + `wire()` itself.
- `testkit.ts` — shared fixtures for `config.test.ts`/`compose.test.ts` (a POSIX-literal fake repo root, a fake `readFile`, the profile/filter/data path helpers that key it). Test-only, not part of the public surface.

Three independent things `wire()` ties together (2026-07-27: `wireScheduler()`, a fourth, was deleted alongside the `Scheduler` port — see §2.1/§6):

1. **Config loading** (`config.ts`) — `loadPipelineConfig` zod-validates `profiles/<name>/profile.json` (`PipelineConfigSchema`); `loadFilterConfig` same for `filter.json` (missing ⇒ `undefined`, invalid ⇒ throw). Fail-loud, deliberately redundant with doctor's `profileParsesCheck` (reports `red` without throwing).
2. **Adapter-check assembly** (`registry.ts`) — `assembleAdapterChecks(config, registry, deps)` is **pure**: maps `lanes`/`connector`/`notifiers` names onto a `CheckFactory` registry. Unknown name ⇒ loud throw.
3. **Live composition** (`compose.ts` + `builders.ts`) — builds `Lane[]`, `Connector`, `Notifier[]`, `Routine[]`, `LlmProvider`, `BrowserProvider`; returns `{ ctx, stages, routines, checks }`.

Notable internals:
- **Two storage handles, deliberately**: `storage` at repo root (machine-shared `src/adapters/lanes/linkedin/page_inventory/`), `profileStorage` at `profiles/<name>/data`. A single repo-root handle (bug until 2026-07-25) made profiles share one cache/registry.
- **Missing `NOTION_TOKEN` never crashes wiring** — a throwing-stub client backs the connector so the live path fails loud at first use, while `doctor` survives.
- `llm` and `browser` are **not** config-driven; settings sliced from `settings['claude-cli']` / `settings['cdp-chrome']`.
- Settings resolvers have two postures: *silently default* on bad/absent (`resolveInventoryMaxAgeDays` 30d, `resolveMaxCardsPerUrl` 40, `resolveMaxNewPerLane` 40) vs *fail loud* on nonsense (`resolveJitterRange`).
- `ctx.notify` uses `Promise.allSettled` — a notifier failure never flips a passed run to exit 1.
- `ctx.signal` / `ctx.beat` are placeholders; `runPipeline` and `guardStage` replace them.

### 2.4 The runner & watchdogs

`src/pipeline/runner/run.ts`'s `runPipeline` runs stages sequentially, checkpoints after each success, and **never throws** — failures become `failure.json` + a `'failed'` `RunResult`; exit code is the caller's. Each `run` invocation owns a FRESH `runs/<date>/<HH-MM>/` folder (local start time — `formatRunTime`/`nextTimeDir`), never a shared per-day one; `runPipeline` itself is ignorant of folder discovery — it only ever sees an optional `RunnerOptions.resumeFrom` seed (`{ startIndex, payload, checkpointPath? }`). `cli/commands/run.ts`'s `--resume` handling does the discovery: before running, it finds the latest EARLIER same-day folder via `latestTimeDir` (the just-created fresh folder is excluded automatically — nothing has been written into it yet), reads its latest checkpoint, and passes that as `resumeFrom`; absent that, the run starts from stage 0. The resumed run's own checkpoints land in its own new folder. `stage <name>` (and `reconcile`) instead continue in TODAY's latest EXISTING folder (creating one only when today has none), so a chain of ad-hoc single-stage runs shares checkpoints — this is `cli/commands/stage.ts`'s own logic, not `runPipeline`'s. A `'passed'` outcome clears any stale `failure.json` left by an earlier failed run in the SAME folder (`RunFolder.clearFailure`), so a green rerun never leaves a contradictory failure artifact beside `result.json`. `RunResult` carries both `date` and `time` (the owning folder's); `formatDigest` shows both in its banner.

Three watchdog layers:
1. **per-stage timeout** — `guardStage` composes `AbortSignal.any([ctx.signal, AbortSignal.timeout(stage.timeoutMs)])`; each retry gets a fresh budget
2. **heartbeat stall** — only for `heartbeat: true` stages; `childCtx.beat()` re-arms a `stallMs` timer; silence aborts the attempt's own `AbortSignal` (folded into `attemptSignal` via `AbortSignal.any`, so the in-flight work is actually cancelled rather than a separate bespoke stall promise rejecting while the real work kept running uncancelled). `DEFAULT_STALL_MS = 360_000` — above structure's 300s provider timeout by design
3. **global run cap** — `runCapMs`, derived by `computeRunCapMs` in `src/cli/commands/run.ts` as `Σ(timeoutMs × (retries+1)) × 1.25` (derivation closed P9 incident #2: a hardcoded 30-min cap under a ~68-min stage sum)

---

## 3. Module map

### `src/core/` — pure domain, zero I/O, no `Date.now()`/`Math.random()` in scorers

| Module | Purpose | Public surface |
|---|---|---|
| `core/jd` | **The universal JD** — filled progressively: `identity` (lane) → `content` (fetch) → `structured` (LLM) → `evaluation` (filter/dedup/rank) → `sync` (connector). `identity.location` (optional raw as-posted location string) is a lane-populated hint, not the structured result — every lane MUST set it whenever its source exposes a location. Also `Verdict`, `DroppedRecord`, `CacheEntry`, `normalize.ts` (`normalizeToken`, `companyKey`) | `schema.ts`, `normalize.ts` |
| `core/config` | `PipelineConfigSchema { lanes[], connector, notifiers[], routines[], schedule?, settings }` — core owns *what is enabled*; adapters own their own `settings` slice shape | `schema.ts` |
| `core/filter` | One pure engine + 5 one-file rules under `rules/`: `title` (domain/function/seniority, substring on normalized token, `reject` beats `match`), `company` (avoid; severity always hard), `location`, `timezone`, `skills` (`minMatch`). Two entries: `evaluate` (full, post-structure) and `evaluateCard` (card subset, kills work pre-JD-open); `decide(verdicts)` → keep/drop | `config.ts`, `engine.ts`, `CardInput` |
| `core/dedup` | Pure dedupe vs reconciled cache + intra-run. Three hard rules: `dedup.id`, `dedup.repost` (title+company w/ city-conflict guard), `dedup.role-company` (aggressive folding, same guard). First wins; kept jobs get `evaluation.duplicateOf` | `dedupe`, `DedupResult`, `stripPrincipal` |
| `core/rank` | Deterministic 100-pt scorer, 5 axes from v0: skills 40, title 15, seniority 15, work-type+timezone 20, YoE 10 (neutral-defaulted — realistic ceiling 95) + `softVerdictPenalty` | `RankConfigSchema`, `scoreJob`, `rank` |
| `core/company` | Registry model + pure transitions: `upsertSeen`, `probeCandidates`, `recordProbe`, `boardsToFetch`, `recordFetchFailure` (→`stale` for auto, flag-only for curated). `now` always passed in. States: `unprobed|found|not-found|error|stale` | `registry.ts`, `schema.ts` |
| `core/profile` | `ResumeSchema`, `SkillClassificationSchema` | `schema.ts` |
| `core/errors` | `SoftError(scope, message)` + `isSoftError` | `soft_error.ts` |
| `core/async` | `sleep` | `sleep.ts` |

### `src/ports/` — 8 interfaces, no implementations

`browser.ts` (`BrowserProvider`/`BrowserHandle`/`PageHandle` — every method takes `timeoutMs`), `connector.ts` (`rebuildCache`/`syncJobs`/`archiveStale`, `ArchivePolicy`), `context.ts` (`Logger`, `RunContext { profile, signal, logger, beat() }`), `doctor.ts` (`DoctorCheck/Finding/Report`, `ok|warn|red`), `lane.ts` (`FarmingLane.source → {jobs, dropped, companiesSeen}`; `ApiLane.probe/fetchBoard`), `llm.ts` (`complete(prompt, {signal})`), `notifier.ts` (digest|alert), `storage.ts` (`readJson<T>(rel, schema)`/`writeJson`/`listSubdirs`/`removeTree`). (`scheduler.ts` — `install/remove/list` — was deleted 2026-07-27 alongside `adapters/scheduler/launchd/`; no successor port replaces it, since a live daemon isn't a `Scheduler`.)

### `src/adapters/`

| Adapter | Purpose / notable internals |
|---|---|
| `browser/cdp-chrome` | `CdpChromeProvider` over playwright `connectOverCDP`. `launcher.ts`: Chrome path probe, `.chrome-debug/` user-data-dir, port 9222, CDP-readiness bounded retry, 24h recycle, SIGTERM→poll→SIGKILL. Ownership is decided by the pid file `.chrome-debug/.jobbunny-chrome.json` (`{pid, port, startedAt}`) written at spawn time and cleared once the process is confirmed dead: a dead recorded pid or corrupt content self-heals (file deleted, treated as "no pid file"), and reachable-with-no-pid-file means a Chrome this codebase didn't spawn — attach, never recycle, never kill. `lsof`/`ps` shell-outs deleted 2026-07-28. Kill-on-close unless `JOBBUNNY_KEEP_BROWSER=1`. `handles/` (split out, file-size effort) holds `page_handle.ts` (every `PageHandle` method races playwright against its own deadline) and `browser_handle.ts`; `session_clear.ts` deletes pre-launch tab-restore/session state (cookies/storage/profile dir left untouched) so a stale restored tab (e.g. a live LinkedIn reCAPTCHA widget) never survives into a fresh launch |
| `db/notion` | `client.ts` (retry 3× exp backoff on **409/429/5xx only**; `AbortSignal.any` deadline; `createPage/updatePage/archivePage` wrap exhausted retries in `SoftError`, `queryDatabase` never does), `schema.ts` (byte-exact names/options pinned by `schema.test.ts`), `cache.ts` (read-only paginate), `sync.ts` (automated fields only, insert-or-anchored-update, per-job try/catch), `archive.ts` (staleness keyed on Date Found; flips `archived` flag, never hard delete; client-side filtering), `connector.ts` (`NotionConnector`, settings zod-validated at construction, **`dryRun` defaults `true`**) |
| `lanes/linkedin` | `LinkedInLane` (`FarmingLane`), split (file-size effort) into: `lane.ts` (the orchestrating class itself, ≤400 lines — breaker read, cache-skip gate, cross-url dedup, post-loop aggregate-failure guards), `pacing/` (`pacing.ts`'s jitter + `pagination.ts`'s `buildPageUrl`/`resolvePagination`/`sameCardIdSet`), `search_urls.ts` (`SearchUrlGroup` parsing), `evidence.ts` (`UrlStat` + the all-urls-failed/no-JD-captured message builders), `fire/probe.ts` (the half-open breaker probe, `runHalfOpenProbe`) + `fire/loop/` (`url_runner.ts`'s per-url/per-page loop, `cards.ts`'s per-card JD-open-and-classify), and `testkit/` (`browser_fakes.ts` + `fixtures.ts`, shared test fixtures, not part of the public surface). Owns its config: `page_inventory/<page>.{json,md}` lives at `src/adapters/lanes/linkedin/page_inventory/` (moved from repo-root `page_inventory/` 2026-07-26 — adapters own their config; future lanes colocate their own the same way). `inventory.ts` (`InventorySchema` + freshness DoctorCheck), `harvest.ts` (ONE in-page batch harvest + `gateCards` via `evaluateCard`; `HarvestedCard.location` from `selectors.cardLocation`), `jd_open.ts` (details-page nav vs popup click, per-URL `SoftError`, best-effort `jdRoot` wait), `resume_state.ts` (`extract_resume.json`, all-done rescan for multi-fire schedules), `capture_store.ts` (`captures.json`, flushed after every JD; `reset()` in lockstep with `rescanReset()`). `lane.ts` sets the captured JD's `identity.location` from the card's `location` (empty card location → absent, per the `identity.location` mandate). Reads the Notion cache path via duplicated constant (adapters may not import `pipeline/**`). `fire/loop/url_runner.ts` drives listing-page pagination per url using `pacing/pagination.ts`: pages 1..`behaviors.maxPages` (a pure `buildPageUrl` sets `behaviors.paginationParam` to `(pageIndex-1)*paginationPageSize` via the WHATWG URL API; page 1 is the url byte-unchanged), same PageHandle reused across a url's pages. Stops early on any of: a page harvests 0 cards, a page's harvested card-id set repeats the previous page's (`sameCardIdSet` — LinkedIn re-serving its last page once `start` overshoots), or the per-url `maxCardsPerUrl` cap is already reached. `harvestCards` takes `allowEmpty` (pages >= 2 only, page 1 always strict): a missing container or a zero-card read returns `[]` instead of throwing its `minJobCards`/`mustExist` assertions, so an ordinary end-of-results tail page is a quiet stop (info-level log, no warn, no `SoftError`, captures kept) rather than a failure. A genuine page-2+ nav/harvest failure (goto throwing, a non-emptiness harvest error) is still a `SoftError` that stops that url's pagination but keeps its earlier-page captures (page-1 failure keeps today's existing strict whole-url semantics). `paginationType !== "url-pages"` or any missing/unparseable pagination behavior falls back to a single page (pre-pagination behavior). Throttle guard (2026-07-28): pacing is 5–12s jitter per navigation + a 20–45s pause between saved-search urls (`cli/wire/settings.ts` defaults, `settings.linkedin.*`; the lane's own defaults stay `0` so tests never really sleep), targeting ~25 min per fire inside farm's unchanged 90-min ceiling. `throttle.ts` is a pure consecutive-shell counter (`shell` = jdRoot present but text still empty on `fire/probe.ts`'s `classifyJdOutcome` bare 5s presence read — on the text-extraction-failure path (and the recovery probe) that follows `jd_open.ts`'s 8s in-page settle poll (`buildJdSettleScript`, 2026-07-28) already having run and failed to hydrate it, but a pre-read failure (a goto/click timeout, before any read is attempted) never reaches the settle poll at all — a server-withheld skeleton, not hydration lag: the skeleton itself carries the right `componentkey` and real layout from navigation time, so presence alone proved nothing about content and a single-shot read raced hydration before this fix; `missing` = jdRoot absent entirely = selector drift, never a trip signal, and never resets the streak either; 3 consecutive shells trip). `breaker_store.ts` persists `{ openedAt, tripCount, lastProbeAt }` to `.chrome-debug/.jobbunny-linkedin-breaker.json` behind injectable fs deps + injected `now` (mirrors `cdp-chrome/ownership/pidfile.ts`; session-scoped, shared by every profile, since the block belongs to the Chrome profile not to a job-search profile). Phases derive from the file: absent/corrupt ⇒ closed, `now < openedAt + 4h` ⇒ open (lane returns `skipped` and never launches the browser), else ⇒ half-open: `fire/probe.ts`'s `runProbe` walks up to `PROBE_MAX_URLS` (3) urls, one harvest + at most one JD-open each, stopping at the first gate-passing card — real text ⇒ delete the file and continue that same fire including the probe's capture; shell ⇒ re-open for another cooldown; a genuine probe error (navigation/harvest/schema failure) ⇒ leave the breaker as-is, retried next fire; no gate-passing card found on any tried url (`no-candidate` — a barren search, not proof of anything either way) ⇒ **fails the breaker open**, deleting the file and letting this same fire continue into the main loop rather than parking shut forever (2026-07-28: a profile whose probed urls are reliably barren had otherwise never recovered, since `closeBreaker` was reachable only via a real-text probe). A mid-fire trip opens the breaker, stops the remaining urls, keeps every capture, and returns normally. The path constant `DEFAULT_USER_DATA_DIR` is passed in by `cli/wire/builders.ts` as a plain string — `adapters-no-cross-family` forbids the lane importing `adapters/browser/**`. |
| `lanes/greenhouse` | `ApiLane`: probe via board-info name match, `gh-` id prefix, `htmlToText`, zod ingress, offline fixtures. `GreenhouseJobSchema.location.name` → `identity.location` |
| `lanes/keka` | `ApiLane`: guess tenant subdomains → confirm via portal-info → resolve portal guid (JSON, fallback scraping `/careers/` HTML) → embedjobs. `kk-` prefix. `KekaJobSchema.jobLocations[0].city` → `identity.location` |
| `llm/claude-cli` | `ClaudeCliProvider`: `claude -p --output-format text`, **prompt over stdin**, abort → SIGTERM → SIGKILL, stderr folded into error. No retry — that's the structure stage's job |
| `notify/telegram` | Over global `fetch`. `chatId` validated at construction; **bot token read lazily from env at send time**. `botTokenCheck` hits `getMe` |

(`scheduler/launchd` — the plist/`launchctl` adapter family, ~1012 lines — was deleted wholesale 2026-07-27 once the in-process daemon replaced launchd triggering; see §2.1/§6.)

### `src/pipeline/`

- `runner/` — `stage.ts` (`StageDef`, `StagePayload`, `StageContext`), `context.ts` (`PipelineCtx` = `StageContext` + config + ports + notify), `guard.ts` (per-attempt timeout + stall + retry; run-level aborts always rethrown, never retried), `run.ts` (`runPipeline`), `fs_storage.ts` (`FsStorage`, atomic temp+rename, pretty-printed). `guardStage` deliberately not re-exported from `index.ts`.
- `stages/` — the 10 stages + `tail_e2e.test.ts` (fixtures → real `FsStorage` → stubbed connector, no network).

### `src/routines/`
`types.ts` — `Routine { name, when: 'pre-run'|'post-sync'|'standalone', run(ctx: PipelineCtx) }` (takes full `PipelineCtx`, unlike stages). `cleanup/` — archives via `connector.archiveStale`; `settings.cleanup` parsed on every run (defaults 7/30/30 days); dry-run deliberately not modeled here — it's the connector's; also prunes `ctx.storage`'s `runs/<date>/` folders strictly older than `settings.cleanup.runsOlderThanDays` via the pure `selectPrunableRunDirs` helper (never prunes today's folder, even at TTL 0), per-folder `removeTree` failure warns and continues.

### `src/ops/`
- `doctor/aggregate.ts` — core checks + `runChecks`; never throws — failing check = `red` finding. 2026-07-27: gained `claudeOnPathCheck` (D13, `red` — the `claude` CLI on `PATH`) and `daemonLivenessCheck` (§6.8, `warn` — including on a missing pidfile). `config_checks.ts` (split out, file-size task 5) holds the three profile/filter checks — `profileParsesCheck`, `filterParsesCheck`, `emptyLanesCheck` — plus the shared resolver helpers (`resolveRoot`, `isNotFound`, `errorMessage`). Adapter checks passed in by `wire()`.
- `daemon/` (2026-07-27) — the scheduling daemon: `pidfile.ts` (heartbeat `lastTickAt`, an `attempts` ledger, synchronous atomic updates that **return `false` when the pidfile is unreadable** rather than no-opping silently; stale = dead pid OR a heartbeat older than 5 min OR one that won't parse — deliberately NOT `run_lock.ts`'s 4h staleness rule below, since the daemon lives for days, not one bounded run), `daemon.ts` (the 30s tick loop — heartbeat write before the reentrancy guard, sequential per-`(slot,profile)` spawn, and **no spawn when the pre-spawn ledger append reports `false`**: an unledgered spawn is the D19 respawn storm), `scan/` (profile-schedule + run-history filesystem scanning), `logs/` (`~/.jobbunny/logs/`, asymmetric rotation), `supervise/` (the real child spawn — rotate-then-spawn, SIGTERM→20s→SIGKILL backstop at `runCapMs+300s`, a faithful port of the retired plist watchdog).
- `observability/` (2026-07-30: split into three subfolders — each was at or under the two-impl-file cap already, `logger.ts` growing a level/scope/factory feature set would have blown it) — `index.ts` re-exports `log/`, `run/`, `report/`; nothing outside `observability/` deep-imports past the top barrel.
  - `log/` — `loggers.ts` (moved from the old top-level `logger.ts`, unchanged behavior in this move: `JsonlLogger` → `run.log`, echoes to stdout on TTY, `flush()`).
  - `run/` — `run_folder.ts` (`RunFolder(profileDataDir, date, time)`: `NN-<stage>.json`, `readLatestCheckpoint`, atomic, rooted at `runs/<date>/<time>/`; plus the folder-discovery helpers `formatRunTime` (local `HH-MM`), `latestTimeDir` (greatest existing time-subdir for a date), `nextTimeDir` (collision-avoiding fresh slot)), `result.ts` (`RunResultSchema` — `date`+`time`+outcome+per-stage funnel, `buildFunnel` — counts only *newly* dropped records, grouped by first failing rule).
  - `report/` — `digest.ts` (`formatDigest(RunResult)` → plaintext ✅/🔴 banner incl. date+time + funnel lines; in `ops/` because `cli/` may import `ops/**` never `adapters/**`; imports `RunResult` from the sibling `run/` subfolder via its barrel, `../run/index.ts`, never its internal file).
- `scheduling/run_lock.ts` — cross-process, cross-profile exclusive lock at `<root>/.jobbunny-run.lock` via `wx` create. Second run **skipped, not queued**. Stale if pid dead OR older than 4h default. (Distinct from `ops/daemon/pidfile.ts`'s own pidfile — same directory convention, a different file, and a deliberately different staleness rule: one is a single bounded run, the other a process meant to live for days.)

### `src/cli/`
`main.ts` (bin entry; `import 'dotenv/config'` **first and only here** — a daemon-spawned scheduled run hands a minimal env), `wire/` (§2.3), `commands/`: run, doctor, reconcile, stage, routine, serve, autostart, lane, profile, setup, release. (`schedule` was deleted 2026-07-27 — see §2.1/§6.) Commands **return** exit codes; only the bin guard touches `process.exitCode`.

---

## 4. Data flow & state

**`profiles/<name>/`** (gitignored except rajni fixture):
- `profile.json` — lanes, connector, notifiers, routines, schedule, settings. **Notion DB/page IDs live here, never `.env`.**
- `filter.json` — the sole geo/skills/rank-gate authority; `locations[]` the only geo source.
- `resume.json` — hand-maintained; `search_urls.md` — Channel → `### <page-slug>` → `• <label> - <url>`, drives `lane add-url`/`/page-analyse`.
- `avoid.md` — read by no runtime code; edit `filter.json` instead.
- `data/` — `cache/entries.json`, `registry/{companies,companies_seen,api_seen}.json`, `structure/*`, `lanes/linkedin/*`, `runs/<date>/<HH-MM>/`.

**`runs/<date>/<HH-MM>/`** — one folder per run invocation (local start time), not per day: `run.log` (JSON-lines), `heartbeat.json`, `NN-<stage>.json` (double as resume points), `result.json` (outcome, timings, funnel, now carrying `date`+`time`), `failure.json` on failed stage — all per-run instead of last-writer-wins per day. `sync_dryrun.json` under `--dry-run` stays at the `runs/<date>/` level (unchanged by this). `routine cleanup` prunes whole `runs/<date>/` trees (its subfolders come along) past `settings.cleanup.runsOlderThanDays` (default 30), never today's date.

**Notion is the source of truth.** `reconcile` reads the live DB every run; local cache always rebuildable, never authoritative; `sync` writes only automated fields.

**Secrets.** `NOTION_TOKEN`, `TELEGRAM_BOT_TOKEN` in `.env`, loaded once at `src/cli/main.ts`. (Drift note: shipped code uses `dotenv` — a de-facto 4th runtime dep.)

**`src/adapters/lanes/linkedin/page_inventory/<page>.json`** — machine-shared, colocated inside the owning adapter (`page_inventory/` is LinkedIn-lane config, not repo-root-shared machinery) and read at runtime by `adapters/lanes/linkedin/inventory.ts`. Each `<page>.json` has a `<page>.md` companion in the same directory — human notes for `/page-analyse`, not read by runtime code. Shape: `{ page, pageType: 'details-page'|'popup', generatedAt, selectors { cardList, card, cardTitle, cardCompany, cardLocation, cardLink, jdRoot, pagination? }, behaviors }`. Every selector except `pagination` required non-empty — the zod schema is the completeness gate. `behaviors` carries `paginationType/Param/PageSize`, `maxPages`, `jdSettledSignal`, `jdAnchorText`, `maxRawTextChars`, `jobCardIdAttr`, `scrollContainer`, `mustExist`, `minJobCards`. Two pages, both verified live 2026-07-27: `linkedin__jobs-search` and `linkedin__jobs-search-results` (its card selectors were repaired in c79d493 — invalid `p:nth()` replaced with `:has()`-based sibling selectors). `jdRoot` on both is now `[componentkey^="JobDetails_AboutTheJob"]`: direct-nav `/jobs/view/` pages render under hashed CSS class names, and `componentkey` is the stable hook there, same scheme as the search-results card selectors.

**`profiles/rajni/`** — committed synthetic fixture: Staff/Lead frontend persona, 9 YoE, home cities `["Chennai","Bengaluru"]`, 14 records with documented outcomes (14 → 11 filter → 9 dedup → 9 rank). `settings.notion.dryRun: true`, tiny caps. Its `README.md` is the data dictionary.

---

## 5. Conventions & invariants

- **Two-pair rule** — every module is a folder with an `index.ts` public surface; internals never imported across boundaries. A folder exceeding **two implementation files** (test pairs and `index.ts` excluded) splits into subfolders before the third lands.
- **Colocated tests** — `foo.ts` + `foo.test.ts`; `node:test` only. Test command uses glob form (`node --test "src/**/*.test.ts"`) — bare-directory args throw MODULE_NOT_FOUND on Node 24.
- **Fail-soft vs fail-loud** — `SoftError` = one URL/company/board/page: recorded, continue. Everything else fails the stage loudly. A stage that attempted work and captured nothing throws loud.
- **Verdicts, not silent drops** — every gate emits `DroppedRecord { jd, reasons: Verdict[] }`.
- **AbortSignal everywhere** — `AbortSignal.timeout()`/`.any()`; no unbounded await in any adapter; every CDP/network/LLM call bound by `ctx.signal`.
- **Token efficiency on the structure path** — JD text capped 2500 chars; structure input AND output stay markdown tables, not JSON.
- **Notion select options byte-exact** (`adapters/db/notion/schema.ts`, pinned by test). Inserts and anchored updates only; never whole-page overwrite/hard delete; cleanup archives (30-day undo), gated by `settings.notion.dryRun` (default `true`).
- **Config is the wiring** — pipeline never names a concrete adapter; only `cli/wire/compose.ts` instantiates.
- **Lanes are config-driven** — DOM drift fixed by regenerating `src/adapters/lanes/linkedin/page_inventory/*.json` via `/page-analyse`, never lane-code edits.
- **Farm writes what source reads** (`registry/companies_seen.json`).
- **Runner is the single notifier** — both digests built from `result.json`.
- **Seeding never clobbers** — `profile build` fills gaps; reruns propose a diff.
- **`profile remove`** dry-run by default, refuses `rajni`; `--force` deletes; never touches Notion.
- **No PDF parsing in the daily path.**
- **Stack** — ESM, TS7 (`strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` — no enums/namespaces, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`), zod, Biome (2-space, 90 cols, single quotes). Node ≥24, native type-stripping, zero build step.
- **3-runtime-dep cap** — `@notionhq/client`, `playwright`, `zod` (+ de-facto `dotenv`).
- **Docs are code** — per-module contracts, this KB, and the executor agent's rules updated in the same change that alters behavior.
- **The gate**: `npm run check` = typecheck && lint && boundaries && test. CI's `test` check is exactly this. `main` protected — land via PR.
- **Node 24 is the machine default** (since 2026-07-26; `nvm alias default 24`) and `.nvmrc` pins the repo, so plain commands just work; fall back to `source ~/.nvm/nvm.sh && nvm use 24 && <command>` only if `node -v` ever regresses below 24.

---

## 6. Ops

**CLI surface** (`src/cli/main.ts` USAGE): run / doctor / reconcile / stage / routine / serve start|stop|status (cross-profile) / autostart enable|disable (cross-profile, darwin only) / lane add-url / profile build|remove / setup / release. `--profile` required except `serve`, `autostart`, and `release`.

**`run` order**: acquire cross-process lock (skip, don't queue) → doctor preflight → pre-run routines → `runPipeline` → post-sync routines only if passed → digest exactly once → release lock. A crash before a `RunResult` exists exits 1 without notifying.

**Scheduling (in-process daemon, 2026-07-27).** Times/weekdays/grace live in `profile.json`'s `schedule` block (`times[]`, `enabled`, `weekdays[]` default Mon–Fri, `graceMinutes` default 90). `jobbunny serve start` splits into a parent (pidfile acquire under its OWN pid as a `wx` boot-window placeholder, darwin legacy-plist migration refusal, detached spawn, 2s alive-confirm via the spawn handle — the parent never rewrites `pid`) and `--daemon-child` (claims `pid` for itself as its first action, then the tick loop; on SIGTERM it stops the daemon and `process.exit(0)`s rather than unwinding, since an in-flight run child's handle would otherwise hold the event loop open for that child's whole runtime). Every 30s the daemon asks the pure `core/schedule/owed.ts`'s `isRunOwed(now, schedules, history)` which `(profile, slot)` pairs are owed — `history` merges real `runs/<date>/` folders with the pidfile's own `attempts` ledger, so a slot that crashed before its first checkpoint doesn't respawn every tick for the rest of its grace window. Owed slots run strictly sequentially, in `(slot, profileName)` order (one shared Chrome/CDP session), each firing `jobbunny run --profile <p> --headless` supervised by `ops/daemon/supervise/` (rotate `runs.log`, spawn, track `inFlight`, SIGTERM→20s→SIGKILL backstop at `runCapMs+300s` — a faithful port of the retired plist's embedded bash watchdog). `jobbunny serve stop` kills the daemon BEFORE any `inFlight` child (killing the child first could let the daemon spawn the next owed run before its own SIGTERM lands). `jobbunny serve status` reports liveness/uptime/wedged-heartbeat/next-fire, read-only. Darwin-only autostart: `jobbunny autostart enable` writes one `RunAtLoad`-only LaunchAgent (`com.jobbunny.autostart.plist`, no `StartCalendarInterval` — zero schedule knowledge) invoking `jobbunny serve start` at login, carrying `WorkingDirectory` (repo root), `EnvironmentVariables.PATH` (the enabling shell's PATH, captured at `enable` time — launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin` has no `claude`, so every scheduled run died on the child's preflight), and `StandardOutPath`/`StandardErrorPath` → `daemon.log` (the parent's own refusals would otherwise go nowhere); Windows/Linux autostart remain a documented manual step (README). Logs → `~/.jobbunny/logs/{daemon,runs}.log` (replaces the macOS-only `~/Library/Logs/JobBunny/`).

**Release flow.** `npm run release -- <X.Y.Z> [--dry-run] [--no-merge] [--yes]` — the `--` is mandatory. Idempotent/resumable; pauses for explicit go-ahead before squash-merge unless `--yes`; does NOT write the CHANGELOG (that's `/wrap ship`). Never background/detach — merge prompt needs stdin.

**Doctor.** Core checks + adapter-contributed: LinkedIn → inventory freshness (30d default) + CDP reachable; Notion → DB reachable; Telegram → `getMe`. Exit 1 iff any `red`; `warn` never fails.

**Slash commands — only four**: `/setup` (Notion adopt-or-create, secrets, resume parse), `/page-analyse <page-slug>` (browser DOM analysis → `src/adapters/lanes/linkedin/page_inventory/<page>.json`; refresh values in place, bump `generatedAt`), `/structure` (LLM stage inline, byte-identical file contracts), `/wrap` (close-out; `jobbunny release` for ship). Plus the **`verify` skill**: drive stages via CLI against `profiles/rajni/` only; never test against `profiles/harish/`.

**Known limitations / open P9 items:**
1. `farm` funnel reports `jobsIn: 0` — cosmetic.
2. `profiles/harish/` is fully migrated — v0 migration confirmed complete and legacy v0 config files (incl. `avoid.md`, its aliases folded into `filter.json` `companies.avoid`) deleted 2026-07-26. Still real user data: never run the pipeline against it.
3. P9 open: Notion WRITE path never exercised live; undiagnosed farm 0-job harvest 2026-07-25; cutover not started; v0 deletion gated on ≥7-day green soak.
4. Gate ordering (title/avoid → seen/cache → cap) deliberately diverges from v0 — cheapest-first.
5. No stale-seen pruning — `api_seen.json` only grows (deliberate).
7. LinkedIn cap is per-URL (`maxCardsPerUrl`, JD opens actually attempted), not per-page — pagination (`lane.ts`, `behaviors.maxPages`, now 6) multiplies the raw cards a url's card-gate sees before that cap applies, so ~21 URLs × up to 6 pages permit a larger harvested-card funnel than pre-pagination, though the per-url JD-open ceiling itself is unchanged; real numbers unmeasured.
8. dedup cache index keyed on title+company — same-title+company different-city entries overwrite.

---

Cite file paths in your answers. Tailor depth to the question asked — never dump the whole KB in a response.
