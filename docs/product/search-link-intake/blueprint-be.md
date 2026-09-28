# Blueprint (Backend) — search-link-intake

Slug `search-link-intake` · Author: product-be · 2026-09-28, **revised four times** 2026-09-28
(pre-build judge FAIL round 1: 9 items; re-gate FAIL round 2: 3 HIGH re-measured sizes + 1 MEDIUM
missing step + 5 LOW/residual; gate 3 FAIL round 3: 1 HIGH board-save-blocking bug + 4 MEDIUM + 1
LOW-bundle; gate 4 FAIL round 4 — this pass, the final round: 1 HIGH-equivalent live-verify rewrite +
5 MEDIUM + 2 LOW) · Mode: UNATTENDED. Inputs: `spec.md`, `ux-notes.md`, `mockup.html`, `.state.md`
(this directory). Every fix below cites a fresh re-measurement/direct code read from the round that
made it, not an earlier round's numbers.

---

## 1. Stack Summary

**Change to existing.** Job Bunny's own repo is the stack; no framework/library question exists.
Evidence for every claim below is a path:line from this recon pass. No new dependencies anywhere in
this blueprint.

- Config docs (`profile.json`, `filter.json`, `resume.json`, `search_urls.md`) live in the per-profile
  sqlite `config_docs` table, behind `ports/config_store.ts`'s `ConfigStore.readText`/`writeText`/
  `close` (`:29-35`). `SqliteConfigStore.writeText` (`src/adapters/db/sqlite/config/store.ts:120-136`)
  calls `validateConfigDoc` (`src/core/config/validators.ts:53-92`) then `INSERT OR REPLACE`s the doc
  — **stores `rawText` unmodified, never re-serializes**. This blueprint deliberately never changes
  that contract (§8 lists why, incl. `config export|import`'s byte-exact requirement and §5 item 5's
  e2e seed path, which now depends on it).
- `BoardSource.writeConfigDoc` is concretely implemented in `src/cli/wire/board.ts:218-234` (the
  composition layer, `only-wire-imports-adapters`), currently `Promise<void>`, delegating entirely to
  `store.writeText`. `app/features/config/routes.ts`'s `putHandler` (`:104-121`) today echoes
  `parsedBody.text` back unread — "cheaper than a second read, guaranteed byte-identical since
  `writeText` never re-serializes" (`:116-117`). **This blueprint's Step 5 stores DIFFERENT text than
  what was PUT (normalized), so this echo assumption breaks for `search_urls.md` and Step 7 fixes it
  by echoing what `writeConfigDoc` actually returns, not the request body** (judge item 4).
- CLI `config set` (`src/cli/commands/config.ts:124-142`, `runSet`) reads stdin, opens a `ConfigStore`,
  calls `store.writeText(doc, content)`, prints the validator's message to stderr and exits 1 on
  throw, 0 on success.
- `jobbunny lane add-url` (`src/cli/commands/lane_add_url.ts`) owns today's only correct classifier:
  `stripEphemerals` (`:95-101`) and `resolvePage` (`:112-127`). Its own tests
  (`lane_add_url.test.ts:15,32-133`) import both directly and use `assert.throws()` with no message
  check (`:129,133`) — error wording is free to change. **Confirmed this pass:** `laneAddUrlCommand`
  also prints `` `[lane add-url] stripped ${EPHEMERAL.join(', ')}` `` at `:182`, which this blueprint's
  Step 3 must fix alongside deleting the local `EPHEMERAL` array, or the file no longer compiles
  (judge item 9).
- `search_urls.md`'s only existing parser, `parseSearchUrls` (`src/adapters/lanes/linkedin/
  search_urls.ts:17-39`), trims each line (`:22`, `const line = raw.trim();`) **before** testing it
  against the heading/bullet regexes — confirmed this pass as the reason the earlier draft of this
  blueprint's Step 2 (which omitted an explicit trim) was a real bug: `search_urls.md`'s bullet rows
  are indented two spaces (`  • <label> - <url>`, `lane_add_url.ts:143`), and an anchor-first regex
  (`/^[•*-].../`) run against the untrimmed raw line matches nothing (judge item 6).
- `LinkedInLane.source()` (`src/adapters/lanes/linkedin/lane.ts:124-365`) throws
  when `attemptedUrls > 0 && failedUrls === attemptedUrls` (`:325-329`) — **after** `handle.close()`
  has already run (`:289-291`). `resumeState.shouldSkip` (`fire/loop/url_runner.ts:96-99`) means a
  done-today URL never re-appears in this fire's `stats`. `url_runner.ts:333-334` marks a URL done
  **regardless of its captured count** (`if (!stat.failed && !state.throttleTripped)
  state.resumeState.markDone(url, stat.captured)`) — so a "done" URL can have `captured === 0`
  (everything it saw was a cache hit or cross-url dupe). `fire/probe.ts:28-33`'s own doc comment
  names a real profile (harish) whose first configured URL is "routinely" barren for a probe
  (`no-candidate`, `:192-195`) — confirmed this pass as the mechanism behind judge item 2's false
  -negative concern: an arbitrary "first done URL" canary pick can land on exactly this kind of URL.
- `fire/loop/cards.ts:167-183` — confirmed this pass: a throttle trip sets `state.throttleTripped =
  true` (`:172`) and opens the breaker (`:173-177`) the moment 3 consecutive server-withheld shells
  are observed (`state.shellJdFailures` increments at `:169` on every shell, independent of whether
  the trip threshold is reached). **This is the exact state a canary must never probe against** (judge
  item 1) — an intermittently-recovering soft-block could hand back one lucky `runProbe` `'ok'` and
  green a run that is, in fact, mid-outage.
- `fire/probe.ts`'s `runProbe` (`:111-196`) is the existing reusable primitive — navigate one URL,
  harvest, open one JD, classify. Returns `ProbeOutcome` (`ok`/`shell`/`no-candidate`/`inconclusive`,
  `:46-50`), never throws except on an aborted `ctx.signal`. **Corrected this round** (judge item E —
  the prior draft wrongly claimed no test files exist under `fire/`): `fire/probe.test.ts` (246 lines)
  already exists directly under `fire/`, alongside `fire/loop/cards.test.ts` and
  `fire/loop/url_runner.test.ts` under its `loop/` subfolder. `fire/canary.test.ts` (Step 9) is not the
  first test in `fire/` — it is a new sibling to the existing `probe.test.ts`, at the same nesting
  level, for the same kind of concern (one navigation-driven primitive per file).
- `ResumeState` (`resume_state.ts:35-79`) persists `{date, done: Record<url, count>}` — no schema
  change needed; `done`'s existing `count` value is exactly what judge item 2's fix needs (prefer a
  captured-count > 0 entry).
- `FarmingLane.source()`'s return type (`ports/lane.ts:22-31`) has no per-link-failure channel today.
- `RunResultSchema` (`ops/observability/run/result.ts:5-20`) has no soft-error field. `RunResult` is
  constructed inside `runPipeline` (`src/pipeline/runner/run.ts:124-143`), which is deliberately
  **stage-agnostic**; the CLI `run` command (`src/cli/commands/run.ts:305-341`) calls it, then
  `finishRun`s and `formatDigest`s the result. `run.ts:249` (`if (opts.resume ?? false) { ... }`) —
  confirmed this pass: **a `--resume` invocation whose seed checkpoint is past the `farm` stage's
  position never re-runs farm at all this invocation**, and a standalone `jobbunny stage farm`
  invocation runs farm without ever calling the code that would build/enrich a `RunResult` for the
  digest. Both mean a stage-scoped, profile-keyed side-write (the `companies_seen.json` pattern) can
  be **read back by an unrelated later invocation** unless guarded (judge item 7a) — §5 Step 12/14
  add a `writtenAt` timestamp guard for exactly this. `run.ts`'s `RunDeps.now: () => Date` (`:122`,
  default `() => new Date()` at `:139`) is injected and read once into a local `now` at `:172`, reused
  for both `startedAt` (`:279`) and Step 15's `runStartedAtIso` — **but `pipeline/stages/farm.ts`'s new
  `writtenAt` (Step 12) uses a bare `new Date()`, not this injected clock** (§7/§8 residual, judge item
  7a, justified rather than unified — the reasoning is in §8 R-9). Separately, `run.ts:124-130,192`'s
  `acquireLock`/`releaseLock` (a cross-process, cross-profile exclusive lock — "all profiles share one
  Chrome/CDP session") guards a full `jobbunny run` invocation, but **a standalone `jobbunny stage
  farm` invocation is not confirmed to go through this same lock** — noted as a LOW residual in §8 R-10.
- `lane.ts:191-195`'s `resumeState.allDone(allUrls)` / `rescanReset()` — confirmed this pass: a
  **persistently failing link never gets `markDone`**, so `allDone()` never holds, so a rescan never
  fires, so every later same-day slot attempts *only* the chronically-bad link (every good link stays
  skipped as already-done) — a real, named emergent behavior of this blueprint's own R6 fix (judge
  item 7b, analyzed in §8).
- Chrome is a **single shared, per-`root` process/profile-dir**: `cli/wire/compose.ts:241`
  (`chromeUserDataDir: path.join(root, 'chrome')`) is the same directory for every profile sharing
  that `root`, and the breaker file lives inside it (`.jobbunny-linkedin-breaker.json`, scoped to the
  Chrome profile, not the job-search profile — explainer.md). **Corrected this round (judge item 4 —
  the round-2 claim below was wrong):** `config.settings['cdp-chrome']` (`compose.ts:283-288`) only
  feeds `CdpChromeProvider`'s own constructor — it does **not** reach `deps.chromeUserDataDir`, which
  is what `buildLanes`/the breaker config actually use (`compose.ts:290-298`, `builders.ts:322,362`,
  confirmed by direct read). A per-profile `cdp-chrome` override therefore never moves the breaker
  file. **The real isolation is `root` itself, via `JOBBUNNY_HOME`**: `rajni` exists only under the
  repo checkout's `profiles/rajni/`, never under the real default home (`~/.jobbunny/profiles/` holds
  only `harish`), so `JOBBUNNY_HOME=$PWD` (CLAUDE.md's own verification convention) gives a genuinely
  separate `chrome/` dir for free — §9 is rewritten to rest on this instead.
- `test/invariants/filesize.test.ts:11-12`: `IMPL_CAP = 400`, `TEST_CAP = 800`, strict `if (lines >
  cap)` (a file at exactly the cap passes; `cap + 1` fails). **Re-measured this round (judge item 3 —
  the round-1 draft's baselines were stale, confirmed by fresh `wc -l` today):**
  `src/adapters/lanes/linkedin/lane.ts` **366** (not 342), `src/adapters/lanes/linkedin/lane.test.ts`
  **785** (not 699), `src/cli/wire/board.ts` **389** (not 352). **`run.test.ts` was a file-identity
  error, not just a stale number**: the relevant file is `src/cli/commands/run.test.ts` (**779**
  lines — extremely close to the 800 cap already), which the round-1 draft conflated with the
  unrelated, untouched `src/pipeline/runner/run.test.ts` (565 lines, cited there as "509"). `biome.json`
  (`:12`) sets `formatter.lineWidth: 90` — a multi-clause `if` or a many-argument call that exceeds 90
  chars wraps across several physical lines under `npm run check`'s formatter, so a hand-estimated
  "a few inline lines" can land materially higher once actually formatted; Step 10 below states an
  exact, char-counted projection rather than a rough estimate. `lane_breaker.test.ts` (659 lines,
  `src/adapters/lanes/linkedin/lane_breaker.test.ts`) remains the precedent for splitting `lane.ts`'s
  test surface by concern (Step 10's `lane_canary.test.ts`).
- `writeConfigDoc` test fakes — **re-confirmed this round via `grep -rc "writeConfigDoc" src --include
  '*.test.ts'` (no `xargs`, judge item 9)**, which gives per-file MATCH-LINE counts, not a count of
  distinct fake declarations (one file can have several one-line fakes, or one multi-line fake spanning
  several matched lines — the count is a checklist weight, not an edit count). **15 files**, not the
  round-1 draft's 16 (which also missed the two `cli/wire/` files entirely — the file that most
  directly needs updating, since `cli/wire/board.ts` is Step 6's own implementation target):
  `src/app/features/board/routes.test.ts` (4), `src/app/features/config/routes.test.ts` (2),
  `src/app/features/secrets/routes.test.ts` (1), `src/app/features/doctor/routes.test.ts` (1),
  `src/app/features/daemon/routes.test.ts` (1), `src/app/features/preview/routes.test.ts` (2),
  `src/app/features/intents/routes.test.ts` (1), `src/app/features/profiles/routes.test.ts` (1),
  `src/app/features/runs/routes.test.ts` (1), `src/app/server/server.test.ts` (3),
  **`src/cli/wire/board.test.ts` (9 — missed entirely in round 1)**,
  **`src/cli/wire/board_preview.test.ts` (3 — missed entirely in round 1)**,
  `src/cli/commands/board.test.ts` (1), `src/cli/commands/runs.test.ts` (1),
  `src/ports/contracts.test.ts` (3).

**No SQL schema migration anywhere in this blueprint.** `RunResult`, the save report, and the farm
side-doc are all opaque JSON shapes inside already-schemaless columns/docs. Constraint satisfied
trivially; no rehearsal step required.

---

## 2. Data Contracts

| Datum | Type | Shape | Source of truth | Step |
|---|---|---|---|---|
| LinkedIn URL classification | `LinkedInSearchUrlClassification` | `{page, label, cleanedUrl, removedParams}` | `classifyLinkedInSearchUrl()`, new `src/core/linkedin_url/` | 1 |
| Page-type label map | `Record<LinkedInSearchUrlPage,string>` | `{'linkedin__jobs-search':'Jobs search', 'linkedin__jobs-search-results':'Search results'}` | `LINKEDIN_SEARCH_URL_LABELS`, same module | 1 |
| Whole-doc normalize result | `NormalizeSearchUrlsResult` | `{text, changes: SearchUrlChange[], total}` | `normalizeSearchUrlsDoc()`, new `src/core/config/search_urls/` | 2 |
| Change-line formatter | `(c: SearchUrlChange) => string` | UX §10 literal templates, single source | `formatSearchUrlChangeLine()`, same module | 2 |
| Save-time change report | `SearchUrlsSaveReport` | `{total, refiled, cleaned, merged, changes}` | `buildSearchUrlsSaveReport()`, same module | 2 |
| Save orchestration (validate+write+report) | function | `saveSearchUrlsDoc(store, rawText) => Promise<{text, report}>` | new `src/app/features/config/search_urls_save.ts` — **the one shared call site for both the board and the CLI**, replacing the earlier draft's two independent inlined copies | 5 |
| `writeConfigDoc` port contract | `BoardSource.writeConfigDoc` | `Promise<{ text: string; report?: SearchUrlsSaveReport }>` (widened from `Promise<void>`) — **`text` is always the text actually stored**, which for `search_urls.md` may differ from what was PUT | `ports/board.ts`, impl `cli/wire/board.ts` | 6 |
| PUT config response | `ConfigGetResponse` (widened) | `{text: string; report?: SearchUrlsSaveReport}` — `text` echoes `writeConfigDoc`'s returned text, **not** the request body. **UI contract:** on a `search_urls.md` PUT, the client must re-seed its row-editor state from the response `text` (it may differ from what was submitted — re-filed headings, merged-away rows) | `app/features/config/routes.ts` | 7 |
| Per-link soft-error (lane) | `FarmingLane.source()` return, widened | `linkSoftErrors?: {url, reason}[]` | `ports/lane.ts`, populated in `lane.ts` | 10-11 |
| Per-link soft-error (run-scoped side doc) | zod doc | `{writtenAt: string, links: {url, reason}[]}` at `lanes/linkedin/link_soft_errors.json` — **`writtenAt` is the staleness guard for judge item 7a** | `pipeline/stages/farm.ts` (writer, always overwrites) | 12 |
| Per-link soft-error (persisted, labeled) | `RunResult.linkSoftErrors` | `{url, label?, reason}[]`, optional | `RunResultSchema`, resolved+baked in by new `src/cli/commands/run_link_soft_errors.ts` before `finishRun`/`formatDigest`; the side-doc read is **rejected if `writtenAt` predates this invocation's own start** | 13-15 |
| Telegram digest bad-links block | text block | per UX §5 | `formatDigest()`, from the already-labeled `RunResult` | 16 |
| Misfiled-row flag (R13) | none (UI-only) | client compares stored heading vs `classifyLinkedInSearchUrl(url).page` on the existing GET response | `ui/` calling `core/linkedin_url` directly | n/a |
| R13 e2e seed (test-only) | function | `seedMisfiledSearchUrl(): Promise<void>` — opens `SqliteConfigStore` **directly** against `profiles/rajni`, bypassing `saveSearchUrlsDoc`/normalization entirely | new **`ui/e2e/seed_misfiled_search_url.ts`** (flat, sibling to the existing `ui/e2e/seed.ts` — there is no `ui/e2e/fixtures/` directory) | 5b |

---

## 3. Read-Write Path Map

### S1 — Settings → Search URLs card
| State | Server path |
|---|---|
| Default | `GET /api/profiles/:name/config/search_urls.md` (unchanged) → client classifies each row via `classifyLinkedInSearchUrl` (Step 1, client-side) for the badge. |
| Empty | Same GET, doc has zero bullet rows → UI-only empty state + auto-added row. |
| Loading | UI-only. |
| Error | Existing GET failure modes — UI-only. |
| Success (after Save) | `PUT /api/profiles/:name/config/search_urls.md {text}` → widened response `{text, report?}` (Step 7) — success strip renders from `report`; row editor **re-seeds from the returned `text`** (Step 7's contract). |
| Save-error | Same PUT, 422 (`routes.ts:110-115`) whose message is the Step 1 throw text (now `refused: `-prefixed, see Step 1) — ValidationSummary backstop. |

### S0 — Onboarding wizard, "Where to hunt" step (new this round, judge item 3 — a third PUT caller)
Not a mockup screen state (out of this feature's UX scope) but a **third production caller** of the
same `PUT .../config/search_urls.md` path, confirmed this round by reading `ui/src/features/wizard/
steps/Step4Hunt.tsx:112-163` directly — distinct from S1's row editor, its own content-aware
never-clobber guard.
| State | Server path |
|---|---|
| Submit (has entries) | `PUT .../config/search_urls.md {text: serializeSearchUrls(entries)}` (`Step4Hunt.tsx:151-152`, serialized by **`wizard/serialize.ts:48-59`'s own `serializeSearchUrls`** — a different function in a different file from S1's `searchUrls.model.ts`, corrected this round) → response `{text, report?}` (Step 7, same contract as S1). **UI contract:** the wizard step must store the PUT **response's** `text` (not the text it sent) into `current.writtenDocs['search_urls.md']` (`:153`) — its own subsequent `GET`-then-byte-compare guard (`:143-146`) only stays correct if what it compares against is what the SERVER actually stored, which for `search_urls.md` **will typically differ** from the wizard's own request body (Step 2's byte-identical contract is scoped to S1 and does not apply to the wizard's different format — see Step 2). The UI planner owns storing the response; BE's obligation is simply that Step 5/6's save always returns the text it actually stored, which it does unconditionally regardless of format (Step 6's contract). |
| Submit (zero entries) | No `search_urls.md` PUT at all (`Step4Hunt.tsx:133`, `entries.length > 0` gates the whole block) — only `profile.json`'s `lanes` is patched. Out of this path entirely. |
| Re-submit after Back/Next (own prior write) | Same PUT; `ownWrite` check (`:144-146`) short-circuits the pre-flight GET-compare when the stored doc still equals the wizard's own last-written text — unaffected by BE changes as long as Step 2's byte-identical contract holds for already-clean text. |

### S2 — Run detail "Links that failed" panel
| State | Server path |
|---|---|
| Default | `RunDetail.result` (opaque JSON, `ports/board.ts:184`) optionally carries `linkSoftErrors: {url,label,reason}[]` (Steps 12-15), fully resolved and staleness-guarded before persistence — client renders directly, no second fetch. |
| Empty | Field absent/empty → panel absent. |
| Loading/Error | Existing run-detail states, unchanged. |
| Success (next run clean) | Next run's `result` has no `linkSoftErrors` — natural consequence. |

### S3 — Telegram digest
| State | Server path |
|---|---|
| Passed, with bad links | `formatDigest(result, opts)` new block when `result.outcome === 'passed' && result.linkSoftErrors?.length` (Step 16). |
| Passed, clean / total outage | Unchanged. |

---

## 4. Schema & Migrations

None. See §1. No `state_docs`/`config_docs`/`run_events` DDL changes.

---

## 5. Implementation Steps

19 steps (corrected this round — was stale at "18" here after round 2 added Step 5b), dependency-ordered,
one file of focus each (two closely-coupled files only where an interface and its sole implementation
cannot ship independently). Colocated tests are part of every step; **every step below names its test
file(s) explicitly**.

**Step 1 — `src/core/linkedin_url/` (new module, R1, Must)**
- Files: `linkedin_url.ts`, `linkedin_url.test.ts`, `index.ts` (barrel). Zero imports (plain global
  `URL`) — `ui/` can import per CLAUDE.md's dependency-free exception.
- Port `EPHEMERAL_PARAMS` (`lane_add_url.ts:43-54`) and `resolvePage`'s matching (`:112-127`)
  unchanged.
- `class UnrecognizedLinkedInSearchUrlError extends Error` — **fixed this revision (judge item 9,
  erasable syntax):** no parameter-property constructor shorthand (CLAUDE.md: TS7 strict,
  erasable-syntax-only forbids it, same family as the no-enums/no-namespaces rule):
  ```ts
  export class UnrecognizedLinkedInSearchUrlError extends Error {
    readonly url: string;
    constructor(url: string) {
      super(
        `refused: ${url} — not a LinkedIn jobs search link (expected /jobs/search, ` +
        `/jobs/search-results or /jobs/collections/…). Nothing written.`,
      );
      this.name = 'UnrecognizedLinkedInSearchUrlError';
      this.url = url;
    }
  }
  ```
  **Fixed this revision (judge item 9): the message now carries the `refused: ` prefix**, matching
  ux-notes.md §10's literal CLI/API copy exactly — the earlier draft omitted it.
- `const LINKEDIN_SEARCH_URL_LABELS: Record<LinkedInSearchUrlPage,string>` = `{'linkedin__jobs-search':'Jobs search','linkedin__jobs-search-results':'Search results'}` — single source for the UX §2 vocabulary table.
- `function classifyLinkedInSearchUrl(rawUrl: string): LinkedInSearchUrlClassification` — catches a
  `new URL(rawUrl)` parse failure and rethrows `UnrecognizedLinkedInSearchUrlError(rawUrl)`; resolves
  the page (same error class on no match); strips each `EPHEMERAL_PARAMS` entry only if present,
  collecting `removedParams` in list order; separately strips an absolute `f_TPR` and records
  `'f_TPR'` if it did; returns `{page, label, cleanedUrl: u.toString(), removedParams}`.
- **Done-condition (`linkedin_url.test.ts`, table-driven, AC1-AC3):** the 3 AC1 URLs classify to
  `linkedin__jobs-search-results` with no ephemeral params left; AC2's mapping/param-order cases;
  AC3's 3 reject cases, each error's `.url === input` and `.message` starts with `'refused: '`; a
  `grep "^import"` on `linkedin_url.ts` returns nothing.

**Step 2 — `src/core/config/search_urls/` (new module, R3/R4/R9/R10, Must)**
- Files: `search_urls_normalize.ts`, `search_urls_normalize.test.ts`, `index.ts`. Imports Step 1
  (core importing core, allowed) — not required to be dependency-free.
- **Contract, new this round (judge item 3): the rebuild output must be byte-identical, for
  already-well-formed input, to `ui/src/features/settings/sections/searchUrls.model.ts`'s
  `serializeSearchUrlRows` (`:48-71`)** — confirmed this pass by reading that file directly, since
  `WhereJobsComeFromSection.tsx`'s save path (`:173-188`) PUTs `search_urls.md` on every section save
  (via `Promise.all([profileForm.save(...), saveSearchUrls(serializeSearchUrlRows(value.rows))])`,
  regardless of whether the rows actually changed) — reformatting on every such save, even a no-op
  one, would be needless diff noise on the profile's committed/observed doc. **Corrected this round
  (the "Wizard premise" item): this contract is scoped to S1's row editor only, NOT the onboarding
  wizard.** The wizard's own save (`Step4Hunt.tsx:151-152`) uses a DIFFERENT function in a DIFFERENT
  file — `wizard/serialize.ts:48-59`'s `serializeSearchUrls` — with a shorter header, no blank line
  after the inventory comment, and everything filed under one fixed heading (`serialize.ts:43-47`'s
  own doc comment: URLs are stored as-typed, never ephemeral-stripped). That output is essentially
  NEVER already-clean relative to THIS contract, so the wizard's own re-normalized write is expected
  to differ from what it sent on nearly every save — **and that is fine**: the wizard's
  read-back-and-compare correctness (`Step4Hunt.tsx:143-146`, `wizard-existing-config`,
  `ui/e2e/wizard.spec.ts:442-472`) depends entirely on the UI storing the PUT **response's** `text`
  (§3 S0's already-documented contract), not on the server's rebuild format matching anything the
  wizard itself produces. `core/` cannot import `ui/` code (wrong direction, and `ui/` isn't under
  `src/`), so the S1 contract is enforced by matching the format BY SPEC, not by sharing code —
  flagged as a maintenance pairing in §8 R-1
  (alongside the already-accepted parse-grammar duplication) and in Step 18's docs.
  ```ts
  // Copied verbatim from searchUrls.model.ts:17-22 — MUST stay byte-identical; a change to either
  // copy without the other reopens judge item 3.
  const SEED_HEADER =
    '# Search URLs\n\n' +
    'Hierarchical: Channel → page → labeled URLs. One page-type = one inventory ' +
    'in `src/adapters/lanes/linkedin/page_inventory/<page>.json`; many URLs may live ' +
    'beneath it.\n' +
    'Add URLs with `/add-url` (strips ephemeral params). Format: `  • <label> - <url>`';
  ```
- **Fixed this revision (judge item 6): explicit `trim()` before every regex test**, matching
  `search_urls.ts:22`'s own convention. **Fixed this round (judge item 2): the bullet regex's URL
  group now captures `\S+`, not `https?:\/\/\S+`** — matching `searchUrls.model.ts:36`'s own parser
  exactly (`/^[•*-]\s+(.+?)\s+-\s+(\S+)$/`), so a scheme-less or malformed URL (e.g. typed directly via
  `config set`, never passing through the UI's own client-side `https://` validation) is still
  CAPTURED as a row rather than silently vanishing, and is then correctly rejected by
  `classifyLinkedInSearchUrl` (Step 1) with a proper `refused:` message (R4) instead of disappearing
  with no error at all:
  ```ts
  interface ParsedRow { label: string; url: string; originalPage: string | null }
  const BULLET_RE = /^[•*-]\s+(.+?)\s+-\s+(\S+)$/;
  function parseRows(md: string): ParsedRow[] {
    const rows: ParsedRow[] = [];
    let currentPage: string | null = null;
    const headingRe = /^###\s+(.+)$/;
    for (const raw of md.split('\n')) {
      const line = raw.trim(); // MUST trim first — bullet rows are indented `  • `, see §1
      const h = headingRe.exec(line);
      if (h?.[1]) { currentPage = h[1].trim(); continue; }
      const m = BULLET_RE.exec(line);
      if (m?.[1] && m?.[2]) rows.push({ label: m[1].trim(), url: m[2].trim(), originalPage: currentPage });
    }
    return rows;
  }
  ```
- **Redefined this round (judge item 1 — HIGH, the round-2 guard was blocking ordinary saves):** the
  round-2 "zero rows from non-empty input" guard threw on ANY non-empty doc with zero parsed rows —
  but that shape is a routine, legitimate save, not just a hypothetical parser regression:
  `serializeSearchUrlRows([])` (a profile with zero LinkedIn searches configured) emits `SEED_HEADER +
  '## linkedin'` with **no bullet lines at all** — non-empty, zero rows, and a perfectly valid save
  that must succeed. A still-blank auto-added row (UX C12) serializes to `  •  - ` (`searchUrls.model.
  ts:67`'s template with empty `label`/`url`) — also non-empty-doc/zero-real-rows, also must not
  throw, since `WhereJobsComeFromSection.tsx`'s save is unconditional on every section save (lanes
  toggle, not just search-URL edits) — so blocking this shape would make a zero-link profile **unable
  to save any setting on this card, ever**. **Widened this round (N5, an orchestrator-default
  decision):** a bullet with a real LABEL but an empty URL (a user who typed a label before pasting
  the URL — `WhereJobsComeFromSection.tsx`'s own `validateRow:66-81` already treats an empty `url` as
  valid, no error, for exactly this reason) is likewise a routine mid-editing state, not a parse
  failure — it must be skipped silently, never a 422, same as the fully-blank C12 placeholder,
  matching today's behavior (neither this parser nor the pipeline's own `parseSearchUrls` ever raised
  an error for an incomplete row). The guard must distinguish "nothing to see here" (including "not
  finished typing yet") from "a real attempt someone typed that our parser choked on" — done by
  scanning for a line that starts with a bullet marker, does NOT match `BULLET_RE`, and is NOT itself
  incomplete (bullet + anything + a bare trailing separator dash + nothing else — covers both the
  fully-blank case and the label-but-no-url case, since the URL slot is empty in both):
  ```ts
  // Renamed from TRIVIAL_BULLET_RE (round 3) — now also covers "label
  // present, URL empty" (N5), not just the fully-blank placeholder, since
  // both are the same underlying shape: text ending in a bare "-" with
  // nothing (or only whitespace) after it.
  const INCOMPLETE_BULLET_RE = /^[•*-]\s+.*-\s*$/;
  const hasUnparsedBulletLine = md.split('\n').some((raw) => {
    const line = raw.trim();
    if (!/^[•*-]/.test(line)) return false; // not bullet-shaped at all — irrelevant here
    if (BULLET_RE.test(line)) return false; // parsed fine, counted in `rows` already
    return !INCOMPLETE_BULLET_RE.test(line); // real content that still failed to parse
  });
  if (hasUnparsedBulletLine) {
    throw new Error(
      'normalizeSearchUrlsDoc: found a bullet-shaped line that failed to parse — refusing to ' +
      'write (a parse gap would otherwise silently delete a saved link). Nothing written.',
    );
  }
  ```
  A header-only doc (zero bullet-shaped lines of any kind), a doc whose only bullet-shaped line is the
  fully-blank C12 placeholder, and a doc with a labeled-but-empty-URL bullet ALL pass this check with
  zero throws — closing judge items 1 and N5 while still catching a genuine parse gap (e.g. a real
  label+URL pair with the `-` separator missing entirely, which `INCOMPLETE_BULLET_RE` does not match
  since there is no dash at all to anchor on).
- Classify + rebuild + report. Dedupe key = `` `${page}|${cleanedUrl}` `` in a `Map`; first occurrence
  wins; a later duplicate is dropped and recorded `{kind:'merged', label: row.label, detail:
  winningLabel}` (`detail` is JUST the winner's label — see the formatter below, "no double 'merged'").
  A surviving row with `removedParams.length > 0` records `{kind:'cleaned', label, detail:
  removedParams.join(', ')}`. A surviving row whose `originalPage !== page` records
  `{kind:'refiled', label, detail: `${humanLabelOf(row.originalPage)} → ${LINKEDIN_SEARCH_URL_LABELS[page]}`}`
  (`humanLabelOf` falls back to `row.originalPage ?? 'unfiled'` for an unrecognized stored heading —
  reporting only, never throws). **Fixed this round (judge item 3, the byte-identical contract above):
  group survivors by `page` in FIRST-ENCOUNTER order (walking `rows` in their original document
  order), not a fixed canonical order** — mirroring `serializeSearchUrlRows:49-57`'s own `order.push
  (row.slug)`-on-first-sight behavior exactly, so a doc whose rows are already correctly ordered
  serializes back with that SAME order, never reshuffled. Serialize using `SEED_HEADER` (above, not a
  short placeholder title), a blank line after each page's inventory comment (matching
  `serializeSearchUrlRows:65`'s `lines.push('')`), and the exact `lane_add_url.ts:162` comment format:
  ```ts
  function serialize(order: string[], byPage: Map<string, ParsedRow[]>): string {
    const lines = [SEED_HEADER, '', '## linkedin'];
    for (const page of order) {
      lines.push(`### ${page}`);
      lines.push(`<!-- inventory: src/adapters/lanes/linkedin/page_inventory/${page}.json -->`);
      lines.push('');
      for (const row of byPage.get(page) ?? []) lines.push(`  • ${row.label} - ${row.url}`);
    }
    return `${lines.join('\n')}\n`;
  }
  ```
- **New this revision — the single-source change-line formatter (judge item 9 [round 1], used by both
  Step 4 and Step 5):**
  ```ts
  export function formatSearchUrlChangeLine(c: SearchUrlChange): string {
    switch (c.kind) {
      case 'refiled': return `re-filed ${c.label}: ${c.detail}`;
      case 'cleaned': return `cleaned ${c.label}: removed ${c.detail}`;
      case 'merged': return `merged ${c.label} into ${c.detail}`;
    }
  }
  ```
  This reproduces ux-notes.md §10's three literal templates exactly, with each kind's word used once.
- `export function buildSearchUrlsSaveReport(r: NormalizeSearchUrlsResult): SearchUrlsSaveReport` —
  counts `changes` by `kind`, plus `total: r.total`.
- **Exported for Step 14's label resolution:**
  `export function resolveSearchUrlLabels(rawMarkdown: string): Map<string,string>` — parses via
  `parseRows`, classifies each row's URL via Step 1 (skipping any that fail to classify — best-effort,
  never throws), keyed by `cleanedUrl → label` (first occurrence wins, same as the dedupe above).
- Barrel: `index.ts` re-exports `normalizeSearchUrlsDoc`, `formatSearchUrlChangeLine`,
  `buildSearchUrlsSaveReport`, `resolveSearchUrlLabels`, `SearchUrlChange`, `NormalizeSearchUrlsResult`,
  `SearchUrlsSaveReport` (judge item 7's "name the index re-exports").
- **Done-condition (`search_urls_normalize.test.ts`):** (a) canonical two-space-indented input
  (`  • Label - url`) is parsed (regression test for judge item 6); (b) misfiled + dirty link →
  `refiled`+`cleaned` changes, correct headings (AC6); (c) two links identical after cleaning → one
  `merged` change, `formatSearchUrlChangeLine` produces `"merged <loser> into <winner>"` with "merged"
  exactly once (AC1 §12 R10); (d) an unrecognized (but URL-shaped) link → throws, message starts
  `'refused: '`; (e) a scheme-less bullet (e.g. `www.linkedin.com/jobs/search`, judge item 2) is
  captured as a row and throws via the CLASSIFIER's `refused:` message, not silently dropped; (f) a
  **header-only** doc (`SEED_HEADER + '## linkedin'`, zero bullet lines) → returns `{changes: [],
  total: 0}` **without throwing** (regression test for judge item 1); (g) a doc whose only bullet line
  is the trivially-blank C12 placeholder (`  •  - `) → also returns without throwing, `total: 0`
  (second regression test for judge item 1); (h) a doc with one genuinely malformed bullet-shaped line
  (real content, e.g. missing the ` - ` separator) mixed with otherwise-valid rows → throws the new
  "bullet-shaped line that failed to parse" message; (i) an already-well-formed doc (correct
  `SEED_HEADER`, correct blank lines, rows already clean and already in page-encounter order) →
  `normalizeSearchUrlsDoc(doc).text === doc` **exactly** (the byte-identical round-trip judge item 3
  requires) with `changes: []`; (j) **new regression test (N5)**: a doc with a real, non-empty label
  but an empty URL (`  • Some Label - `) → returns without throwing, that row absent from `total`
  (same treatment as (g), confirming the widened `INCOMPLETE_BULLET_RE` covers label-present too).

**Step 3 — Refactor `src/cli/commands/lane_add_url.ts` (R5, Must; AC8)**
- Replace `stripEphemerals`/`resolvePage`/the inline `EPHEMERAL` const with thin delegates to Step 1,
  keeping both functions exported with their existing exact signatures so
  `lane_add_url.test.ts:15,32-133` keeps passing unmodified:
  ```ts
  export function stripEphemerals(rawUrl: string): URL {
    return new URL(classifyLinkedInSearchUrl(rawUrl).cleanedUrl);
  }
  export function resolvePage(u: URL): ResolvedPage {
    return { channel: 'linkedin', page: classifyLinkedInSearchUrl(u.toString()).page };
  }
  ```
- Change `laneAddUrlCommand`'s body (`:140-142`) to call `classifyLinkedInSearchUrl(opts.url)` **once**
  directly, deriving `cleanUrl`/`channel`/`page`/`removedParams` from its result; delete the local
  `EPHEMERAL` array.
- **Fixed this revision (judge item 9): line `:182`'s print statement referenced the now-deleted
  `EPHEMERAL` constant** — it no longer compiles under the naive deletion. Replace with the
  classification's actual `removedParams` (more accurate too — it prints only what THIS url had
  removed, not the full static list regardless of relevance):
  ```ts
  resolved.write(`[lane add-url] stripped ${classification.removedParams.join(', ') || '(nothing)'}`);
  ```
- **Done-condition:** `lane_add_url.test.ts` passes unmodified (AC8); `grep -c
  "currentJobId\|referralSearchId" src/cli/commands/lane_add_url.ts` returns 0; `tsc --noEmit` passes
  (regression check for the `:182` compile break this revision fixes).

**Step 4 — `src/cli/commands/config.ts` `runSet` (R3/R4/R9/R10, Must; AC6)**
- Before `store.writeText(doc, content)`: if `doc === 'search_urls.md'`, call Step 5's shared
  `saveSearchUrlsDoc(store, content)` instead (not an inline re-implementation — the earlier draft's
  duplication is replaced by a true single call site, shared with Step 6/7's board path). On throw,
  unchanged existing `catch` (`deps.stderr(message); return 1`) — the message already carries the
  `refused: ` prefix (Step 1). On success, print one line per `result.report.changes` entry via
  `formatSearchUrlChangeLine` (Step 2) through the existing `deps.write` seam (confirm the exact
  writer name against `config.ts`'s `ConfigDeps` interface — mechanical).
- For every other `doc`: unchanged.
- **Done-condition (`config.test.ts`, confirm exact filename at implementation time — the existing
  colocated test for this command):** AC6 — misfiled+dirty doc writes re-filed/cleaned, printed lines
  read `re-filed <label>: Jobs search → Search results` / `cleaned <label>: removed a, b` (byte-exact
  ux-notes §10 templates); unrecognized link exits non-zero, `config get` immediately after shows the
  doc **unchanged**.

**Step 5 — NEW `src/app/features/config/search_urls_save.ts` (R3, Must)**
**New this revision** (judge items 3 and 9): the single shared save-orchestration function, replacing
the earlier draft's plan to inline the same ~4 lines independently at the CLI and board call sites.
Lives in `app/features/config/` (not `cli/wire/`) because it needs no adapter import — it operates on
an already-constructed `ConfigStore` handed in by its caller — so it satisfies `app-only-ports-core`
and is reachable from **both** `cli/commands/config.ts` (Step 4, `cli` may import `app`) and
`cli/wire/board.ts` (Step 6, same rule) without duplication. Two-pair check: `app/features/config/`
today has `routes.ts` + `routes.test.ts`; this adds one more impl file, still under the two-file cap.
```ts
export async function saveSearchUrlsDoc(
  store: ConfigStore,
  rawText: string,
): Promise<{ text: string; report: SearchUrlsSaveReport }> {
  // N2 fix: validate the RAW text FIRST, before normalizing — normalize's
  // own "header-only, zero rows" behavior (Step 2, judge item 1) turns an
  // EMPTY string into a legitimate-looking non-empty header doc, which
  // would let a `{text: ''}` PUT (routes.ts's PutConfigBodySchema has no
  // min length) or an empty `config set` stdin silently WIPE a profile's
  // search_urls.md down to a bare header instead of being refused. This
  // call throws validateConfigDoc's existing "search_urls.md must not be
  // empty" message on raw-empty input, BEFORE normalize ever runs.
  validateConfigDoc('search_urls.md', rawText);
  const normalized = normalizeSearchUrlsDoc(rawText); // throws — nothing written, propagates to caller
  validateConfigDoc('search_urls.md', normalized.text); // defense-in-depth; writeText re-checks too
  await store.writeText('search_urls.md', normalized.text);
  return { text: normalized.text, report: buildSearchUrlsSaveReport(normalized) };
}
```
Both `cli/commands/config.ts` (Step 4) and `cli/wire/board.ts` (Step 6) call this ONE function for
every `search_urls.md` write, so this raw-text-first validation automatically covers "every save path"
(N2's explicit ask) without a separate fix at each call site — the board's `PutConfigBodySchema`
(`routes.ts:31`, `z.strictObject({ text: z.string() })`, no `.min(1)`) and CLI `config set`'s empty
stdin both flow into this one shared function unchanged.
- **New this round (judge item 7 — "name the index re-exports"):** add `export { saveSearchUrlsDoc }
  from './search_urls_save.ts';` to the existing barrel `src/app/features/config/index.ts` (confirmed
  by direct read — today it re-exports only `routes.ts`'s `BoardProfile`/`ConfigDocKey`/
  `ConfigGetResponse`/`CreateProfileResponse`/`makeConfigRoutes`). **Both** Step 4 (CLI) and Step 6
  (board wire) import `saveSearchUrlsDoc` through this barrel, never by reaching into
  `search_urls_save.ts` directly (two-pair rule: a module's `index.ts` is its public surface).
- **Done-condition (`search_urls_save.test.ts`, new):** given a fake `ConfigStore`, a misfiled+dirty
  input produces `{text: <rebuilt doc>, report: {refiled:1, cleaned:1, merged:0, total:N,
  changes:[...]}}` and calls `writeText` exactly once with the normalized text; an unrecognized link
  throws and `writeText` is **never called** (assert via a spy). **New regression test (N2):**
  `saveSearchUrlsDoc(store, '')` throws `validateConfigDoc`'s "search_urls.md must not be empty"
  message and `writeText` is **never called** — confirming the raw-text check runs before normalize
  ever gets a chance to turn the empty string into a written, non-empty header doc.

**Step 5b — NEW `ui/e2e/seed_misfiled_search_url.ts` (R13 e2e coverage, Must; judge item 5)**
**New this round** (the round-1 draft's "Step 5 sidebar" pointed at a file/step that didn't formally
exist, in a `ui/e2e/fixtures/` directory that doesn't exist either — confirmed this pass, `ls
ui/e2e/fixtures` fails; `ui/e2e/` is flat). Since Steps 4-7 now normalize **every** save path, R13's
"existing misfile" UI state (a stored heading that disagrees with the URL's real page type) can no
longer be produced by any production save path — its e2e spec needs a seed that bypasses
normalization entirely. Test-only; **never enters the prod surface** — it is not imported by anything
under `src/**` or `ui/src/**`, only by an e2e spec file.

Follows `ui/e2e/seed.ts`'s own sanctioned pattern exactly (`seed.ts:2-6`'s "Boundary exception" doc
comment, `seed.ts:45`'s repo-root resolution, `seed.ts:55-57`'s `refusing: not rajni` guard) — the
same, deliberately narrow exception extended to a second, equally-documented file for a different
fixture concern (a per-spec seed, not `seed.ts`'s own once-per-suite Playwright `globalSetup`, so it
cannot simply be folded into `seed.ts`'s single default export):
```ts
/**
 * Boundary exception (sanctioned) — extends the same narrow exception
 * ui/e2e/seed.ts documents at its own top (:2-6): this seeder also imports
 * an adapter (SqliteConfigStore) directly, the one allowed pattern outside
 * cli/wire for TEST SEEDING ONLY. A second, deliberate instance rather than
 * folding into seed.ts: seed.ts is a once-per-suite Playwright
 * `globalSetup` (every spec sees its seed), while R13's misfiled-link state
 * must exist for exactly one spec — filing it globally would make every
 * OTHER settings spec see a spurious misfile notice.
 *
 * Writes rajni's search_urls.md directly via SqliteConfigStore.writeText —
 * bypassing app/features/config/search_urls_save.ts's normalization
 * entirely, which is safe specifically because this blueprint (§1) never
 * modifies writeText's own "stores rawText unmodified" contract. Files one
 * /jobs/search-results/ URL under the WRONG (linkedin__jobs-search)
 * heading — the exact misfile shape R13's card notice detects.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteConfigStore } from '../../src/adapters/db/sqlite/config/index.ts';

const MISFILED_DOC =
  '# Search URLs\n\n## linkedin\n### linkedin__jobs-search\n' +
  '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json -->\n' +
  '  • Acme DevOps - https://www.linkedin.com/jobs/search-results/?keywords=devops&location=Remote\n';

export async function seedMisfiledSearchUrl(): Promise<void> {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const profileRoot = path.join(root, 'profiles', 'rajni');
  const dbPath = path.join(profileRoot, 'data', 'jobbunny.db');
  if (!dbPath.includes(`${path.sep}rajni${path.sep}`)) {
    throw new Error('refusing: not rajni'); // same belt-and-braces guard as seed.ts:55-57
  }
  const store = new SqliteConfigStore(dbPath, profileRoot);
  try {
    await store.writeText('search_urls.md', MISFILED_DOC);
  } finally {
    store.close();
  }
}
```
Called from the R13 misfile-notice e2e spec's own `test.beforeEach`/setup (product-ui's `blueprint.md`
cites this file by name — confirmed §2), never from `seed.ts`'s global setup and never from any `src/`
or `ui/src/` production code.
- **Done-condition (no colocated `.test.ts` — this is itself e2e-only fixture code, mirroring
  `seed.ts`'s own untested status):** the R13 e2e spec, after calling `seedMisfiledSearchUrl()` and
  loading Settings, sees the misfile notice/badge for the seeded row; `depcruise src` (scoped to
  `src/**` only, per CLAUDE.md) is unaffected since this file lives entirely under `ui/e2e/`.

**Step 6 — `ports/board.ts` + `src/cli/wire/board.ts` `writeConfigDoc` (R3, Must)**
- Widen the port signature (`ports/board.ts:267`) from `Promise<void>` to
  `Promise<{ text: string; report?: SearchUrlsSaveReport }>` (`SearchUrlsSaveReport` imported from
  Step 2's core module — `ports/` may import `core/`).
- **Fixed this round (judge item D):** in `cli/wire/board.ts:218-234`, the `search_urls.md` branch
  must sit **inside** the existing `try`, before `finally { store.close(); }`, and must `await` the
  shared helper — a bare `return saveSearchUrlsDoc(...)` (no `await`) would let the `try` block exit
  (running `finally`'s `store.close()`) **before** `saveSearchUrlsDoc`'s own internal `await
  store.writeText(...)` actually completes, closing the underlying db handle mid-write:
  ```ts
  async writeConfigDoc(name, doc, rawText) {
    const infos = await listProfileInfos(root);
    if (!infos.some((p) => p.name === name)) { throw new Error(`unknown profile: ${name}`); }
    const store = wireConfigStore(name, { root, liftMode: 'readwrite' });
    try {
      if (doc === 'search_urls.md') {
        return await saveSearchUrlsDoc(store, rawText); // MUST await — see above
      }
      await store.writeText(doc, rawText);
      return { text: rawText };
    } finally {
      store.close();
    }
  }
  ```
  Every doc now returns `text` unconditionally, satisfying judge item 4's contract. Add two new
  imports at the top: `import { saveSearchUrlsDoc } from '../../app/features/config/index.ts';` and
  `import type { SearchUrlsSaveReport } from '../../core/config/search_urls/index.ts';` (both under 90
  chars, stay one line each).
- **Projected `cli/wire/board.ts` size (judge item 7 — "give projected counts for board.ts and every
  other touched file near a cap"):** 2 new import lines, and the method body growing from 17 to 21
  lines (the widened return-type annotation stays one line; the new `if (doc === 'search_urls.md')`
  branch adds 4) — **+6 total. 389 (§1's re-measured baseline) + 6 = 395**, 5 lines of margin under the
  400 cap — tight, same caveat as Step 10's `lane.ts` projection: verify with `npx biome check --write`
  once implemented.
- **Done-condition — the 15 files §1 lists (re-measured this round via `grep -rc`, judge item 9) each
  need their `writeConfigDoc` fake(s) updated to satisfy the widened return type** — a trivial stub
  becomes `async () => ({ text: '' })` (or omit the arrow-return entirely and let TS infer from a
  literal), a "full signature" fake (the ones actually asserting on call args —
  `src/ports/contracts.test.ts`, `src/app/server/server.test.ts`, `src/app/features/config/
  routes.test.ts`, `src/cli/wire/board.test.ts`, `src/cli/wire/board_preview.test.ts`) needs its
  return value to plausibly echo `{ text: rawText }` so any assertion reading the response's `text`
  still passes. `src/app/features/config/routes.test.ts` also gains **real** assertions in Step 7
  (it's the config feature's own test, not a bystander fake) and `src/cli/wire/board.test.ts`/
  `board_preview.test.ts` are THIS step's own implementation's test files — read every
  `writeConfigDoc` occurrence in each of the 15 files (the grep count is match-lines, not a guaranteed
  1:1 count of distinct fakes to edit) and update every one found.
  AC7 — PUT with an unrecognized link returns a 4xx naming the link (now `refused: `-prefixed); stored
  doc unchanged (verified via a follow-up GET in the test).

**Step 7 — `src/app/features/config/routes.ts` (R3/R9, Must)**
- Widen `ConfigGetResponse` (`:44-46`) to `{ text: string; report?: SearchUrlsSaveReport }`.
- **Fixed this revision (judge item 4):** `putHandler` (`:104-121`) builds the response from
  `writeConfigDoc`'s **return value**, not the request body. **Fixed further this round (N6): `result`
  must be declared, and the body built and returned, INSIDE the existing `try` block (`:110-117`) —**
  the original code's success path (body-building, `return`) sits AFTER the `try/catch` (with
  `parsedBody.text` read from outer scope, since `writeConfigDoc` originally returned `void` and there
  was nothing to capture); a bare `const result = await ...` placed where that line used to be would
  be block-scoped to the `try` and invisible to any code after it, so the success path must move
  inside the `try`, right after the `await`, not stay positioned after `catch`:
  ```ts
  try {
    const result = await source.writeConfigDoc(name, doc, parsedBody.text);
    const body: ConfigGetResponse = { text: result.text, report: result.report };
    return { status: 200, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(422, 'validation', message);
  }
  ```
  `report: undefined` is dropped by `JSON.stringify`, so this is additive/absent for the 3 other docs
  and for a no-op `search_urls.md` save with `report.total===report's own unchanged-count`.
- **Done-condition (`src/app/features/config/routes.test.ts:67`'s fake, now returning real shapes —
  Step 6's list):** AC5 — after saving a `/jobs/search-results/` link through board Settings on
  `rajni`, `config get search_urls.md` shows it under the correct heading, cleaned; the PUT response
  body's `text` **equals what `config get` returns immediately after** (byte-identical, closing the
  echo-correctness gap judge item 4 raised); `report.total/refiled/cleaned/merged` match what changed.

**Step 8 — `src/adapters/lanes/linkedin/resume_state.ts` `pickCanaryUrl` (R6 support, Must)**
- **Redesigned this revision (judge item 2 — two independent bugs in the earlier draft's
  no-arg `pickDoneUrl()`):**
  1. It picked the *first* done key regardless of capture count, which can land on a chronically
     barren URL (`probe.ts:28-33`) and make `runProbe` return `no-candidate` — an unconfirmed result
     that (correctly, per Step 10) falls through to the existing loud throw, defeating R6 on a
     perfectly healthy session.
  2. It returned a URL that might not exist in the CURRENT `this.urls` (re-filed/cleaned by an
     earlier-today Settings save under this same feature), leaving `lane.ts`'s
     `this.urls.find(g => g.urls.includes(canaryUrl))` undefined and silently skipping the canary.
  Fix: take the caller's current candidate URL list as a parameter, so the return value is
  **guaranteed present in it**, and prefer a captured-count > 0 entry:
  ```ts
  /** A done-today URL suitable as a canary probe target (R6/R7), guaranteed
   * to be a member of `candidateUrls` (today's freshly re-parsed
   * `this.urls` — a `done` key from an earlier slot may no longer match a
   * URL string re-filed/cleaned by a same-day Settings save). Prefers an
   * entry with a nonzero captured count over one that was fully processed
   * via cache/dedup alone (a `captured === 0` done URL can be chronically
   * barren for a fresh `runProbe`, `fire/probe.ts:28-33`). `undefined` when
   * nothing in `done` is present in `candidateUrls`. */
  pickCanaryUrl(candidateUrls: readonly string[]): string | undefined {
    const present = candidateUrls.filter((u) => Object.hasOwn(this.done, u));
    if (present.length === 0) return undefined;
    return present.find((u) => (this.done[u] ?? 0) > 0) ?? present[0];
  }
  ```
- **Done-condition (`resume_state.test.ts`, confirm exists — this module's existing colocated test):**
  empty `done` → `undefined`; `done` has entries but none present in `candidateUrls` → `undefined`
  (regression test for judge item 2's bug 2); `done` has a `captured===0` entry and a `captured>0`
  entry, both present in `candidateUrls` → the `captured>0` one wins (regression test for bug 1); only
  a `captured===0` entry is present → that one is returned (fallback, not `undefined`).

**Step 9 — NEW `src/adapters/lanes/linkedin/fire/canary.ts` (R6/R7, Must)**
**New this revision** (judge items 1 and 3): extracts the canary orchestration out of `lane.ts`
entirely, mirroring `fire/probe.ts`'s sibling role — keeps `lane.ts`'s own growth to a call site plus
two guard conditions (a handful of lines, not the ~30-40 the earlier draft would have added inline),
and gives the canary logic its own colocated test file rather than inflating `lane.test.ts`.
```ts
export type CanaryVerdict = 'confirmed-healthy' | 'not-attempted' | 'unconfirmed';

export interface CanaryDeps {
  urls: SearchUrlGroup[];
  inventories: Inventory[];
  filterCfg: FilterConfig;
  interUrlPause: () => Promise<void>;
}

/** R6/R7's canary (spec §8 Q7): when a fire's every attempted URL this
 * cycle failed, re-probe ONE url already known-good today to tell "one/some
 * bad links" apart from a genuine session-wide outage.
 *
 * FIXED this revision (judge item 1): a throttle trip or ANY shell response
 * already IS session-wide-distress evidence for this very fire
 * (`fire/loop/cards.ts:167-183` — 3 consecutive shells trips the breaker;
 * a SINGLE shell is already suspicious) — probing again risks the exact
 * misdiagnosis this guard exists to prevent: an intermittently-recovering
 * soft-block handing back one lucky `runProbe` 'ok' and greening a run
 * that is, in fact, mid-outage. Skip straight to 'unconfirmed' in either
 * case, at zero extra navigation cost, so the caller's existing loud throw
 * stands unchanged. */
export async function runCanaryProbe(
  deps: CanaryDeps,
  resumeState: ResumeState,
  state: { throttleTripped: boolean; shellJdFailures: number },
  handle: BrowserHandle,
  ctx: RunContext,
): Promise<CanaryVerdict> {
  if (state.throttleTripped || state.shellJdFailures > 0) {
    return 'unconfirmed';
  }
  const candidateUrls = deps.urls.flatMap((g) => g.urls);
  const canaryUrl = resumeState.pickCanaryUrl(candidateUrls);
  if (!canaryUrl) return 'not-attempted';
  // Structurally guaranteed to find a group — pickCanaryUrl only ever
  // returns a member of candidateUrls — kept as a defensive `undefined`
  // fallback rather than a non-null assertion.
  const canaryGroup = deps.urls.find((g) => g.urls.includes(canaryUrl));
  if (!canaryGroup) return 'not-attempted';
  await deps.interUrlPause();
  const outcome = await runProbe(
    { urls: [{ page: canaryGroup.page, urls: [canaryUrl] }], inventories: deps.inventories, filterCfg: deps.filterCfg },
    handle,
    ctx,
  );
  // The canary's own capture (on 'ok') is deliberately discarded — never
  // appended to captureStore, never added to processedIds, never pushed as
  // a UrlStat. Unlike runHalfOpenProbe's 'ok' path (a different,
  // unrelated call site), this probe exists only to answer "is the
  // session healthy", not to harvest — appending it would risk a
  // duplicate JD (the same re-open-an-already-flushed-card risk
  // runHalfOpenProbe's own comment documents) for zero benefit.
  return outcome.result === 'ok' ? 'confirmed-healthy' : 'unconfirmed';
}

/** Everything lane.ts's source() needs after its all-attempted-failed
 * check, computed HERE (not in lane.ts) so the caller's own footprint stays
 * a single call — biome's 90-char lineWidth (biome.json:12) means the
 * guard's if-condition and the linkSoftErrors-building map both wrap to
 * several physical lines, which is exactly the growth judge item 3 flagged
 * against lane.ts staying under the 400-line IMPL_CAP. Reads
 * `state.stats` directly (already a field of the `UrlRunnerState` lane.ts
 * already builds) rather than taking a separate `stats` parameter. */
export interface CanaryEvaluation {
  confirmedHealthy: boolean;
  // Optional (not `| undefined`), fixed this round for lane.ts's projected
  // size (judge item 7's "include wrapped lines" ask) — an optional field
  // lets the hoisted default in Step 10 omit it entirely, staying on one
  // 90-char-safe line instead of wrapping to a 4-line object literal.
  linkSoftErrors?: { url: string; reason: string }[];
}

export async function evaluateAllFailedCanary(
  state: UrlRunnerState,
  urls: SearchUrlGroup[],
  inventories: Inventory[],
  filterCfg: FilterConfig,
  interUrlPause: () => Promise<void>,
  handle: BrowserHandle,
  ctx: RunContext,
): Promise<CanaryEvaluation> {
  const attemptedUrls = state.stats.length;
  const failedUrls = state.stats.filter((s) => s.failed).length;
  if (attemptedUrls === 0 || failedUrls !== attemptedUrls) {
    return { confirmedHealthy: false };
  }
  const verdict = await runCanaryProbe(
    { urls, inventories, filterCfg, interUrlPause },
    state.resumeState,
    state,
    handle,
    ctx,
  );
  ctx.logger.warn(
    'linkedin lane: leftover links all failed this fire — ran a canary against a link already done today',
    { verdict },
  );
  if (verdict !== 'confirmed-healthy') {
    return { confirmedHealthy: false };
  }
  return {
    confirmedHealthy: true,
    linkSoftErrors: state.stats
      .filter((s) => s.failed)
      .map((s) => ({ url: s.url, reason: s.failures[0]?.message ?? 'link failed this fire' })),
  };
}
```
Add exports to the existing barrel `src/adapters/lanes/linkedin/fire/index.ts` (judge item 7 — "name
the index re-exports"; `lane.ts` imports through this barrel today, `runHalfOpenProbe`/`runUrlGroups`/
`type UrlRunnerState` already listed there, confirmed by direct read): `evaluateAllFailedCanary`,
`type CanaryEvaluation` — `runCanaryProbe`/`type CanaryVerdict`/`type CanaryDeps` stay unexported from
the barrel (internal to `fire/canary.ts` and its own test only; `lane.ts` never calls `runCanaryProbe`
directly, only `evaluateAllFailedCanary`).

Note: `evaluateAllFailedCanary` re-derives `attemptedUrls`/`failedUrls` from `state.stats` internally,
which duplicates (cheaply — two array reads, no I/O) the equivalent computation `lane.ts`'s own
pre-existing code still does AFTER `finally` (unchanged, needed for `buildAllUrlsFailedMessage`'s
call). Accepted as a minor, deliberate duplication in exchange for lane.ts's own footprint staying a
single function call (Step 10) — the alternative (threading the pre-computed booleans in as extra
parameters) saves two lines inside this function at the cost of two more parameters at the call site,
a net loss for lane.ts's own line count.
- **Done-condition (`fire/canary.test.ts`, new — sibling to the existing `probe.test.ts`, see §1's
  correction on judge item E):**
  `runCanaryProbe`: `throttleTripped: true` → `'unconfirmed'`, `runProbe` never called (spy assertion,
  regression test for judge item 1); `shellJdFailures: 1`, `throttleTripped: false` → same; no
  done-today URL present in `candidateUrls` → `'not-attempted'`, `runProbe` never called; a present
  done-today URL + `runProbe` returning `ok` → `'confirmed-healthy'`; `shell`/`no-candidate`/
  `inconclusive` → `'unconfirmed'`.
  `evaluateAllFailedCanary`: zero attempted or not-all-failed `stats` → `{confirmedHealthy: false}`
  (`linkSoftErrors` absent), `runCanaryProbe` never called (cheap short-circuit, no navigation); all
  failed + confirmed-healthy verdict → `linkSoftErrors` names exactly the failed URLs with each one's
  first recorded failure message; all failed + any non-`'confirmed-healthy'` verdict →
  `{confirmedHealthy: false}`.

**Step 10 — `src/adapters/lanes/linkedin/lane.ts` canary wiring (R6/R7, Must; AC9, AC10)**
**Redesigned this round** (judge items C and 3): the round-1 draft declared `let canaryVerdict` INSIDE
the `try` block and read it AFTER `try/finally` closed — out of scope, a compile error (judge item C).
Fixing that scoping bug on its own would still have left two separate blocks of new code in `lane.ts`
(the pre-`finally` invocation plus the post-`finally` guard/return), which is what pushed the
projected size over 400 per the orchestrator's spot-check. Step 9's new `evaluateAllFailedCanary`
(above) now owns the guard DECISION and the `linkSoftErrors` BUILD entirely — `lane.ts` only hoists one
variable, makes one call, and adjusts its existing throw/return by one clause/field each.
- **New this round (judge item 7 — "the lane.ts:18 import"):** widen the existing barrel import at
  `lane.ts:18` (`import { runHalfOpenProbe, runUrlGroups, type UrlRunnerState } from './fire/
  index.ts';`, confirmed by direct read — a single 86-char line today) to add the two new names —
  this pushes it past 90 chars, so it wraps under biome:
  ```ts
  import {
    evaluateAllFailedCanary,
    runHalfOpenProbe,
    runUrlGroups,
    type CanaryEvaluation,
    type UrlRunnerState,
  } from './fire/index.ts';
  ```
  (7 lines, was 1 — +6, counted in the projection below.)
- Hoist the result variable **before** `try` (fixes judge item C's scoping bug). **Kept to one line
  this round** by `CanaryEvaluation.linkSoftErrors` being optional (Step 9's fix) rather than
  `| undefined` — `{ confirmedHealthy: false }` alone fits comfortably under 90 chars, so this does
  NOT wrap (judge item 7's other named example, "the hoisted `let canaryOutcome…` at ~97 chars," was
  measured against the round-2 draft's `| undefined` version; this round's optional-field version is
  ~68 chars):
  ```ts
  let canaryOutcome: CanaryEvaluation = { confirmedHealthy: false };
  ```
- Inside the existing `try` block (`:235-291`), immediately after `await runUrlGroups(...)`
  (`:272-288`) and still before `finally { await handle.close() }` — the canary needs the still-open
  `handle`:
  ```ts
  canaryOutcome = await evaluateAllFailedCanary(
    state,
    this.urls,
    this.inventories,
    this.filterCfg,
    () => this.interUrlPause(ctx),
    handle,
    ctx,
  );
  ```
- After the `try/finally` (handle already closed; the existing, unchanged lines computing
  `attemptedUrls`/`failedUrls` for `buildAllUrlsFailedMessage` stay exactly as they are today), change
  the throw guard (`:325-329`, currently 5 lines) and the return statement (currently 1 line):
  ```ts
  if (
    attemptedUrls > 0 &&
    failedUrls === attemptedUrls &&
    !canaryOutcome.confirmedHealthy
  ) {
    throw new Error(
      buildAllUrlsFailedMessage(attemptedUrls, stats, state.shellJdFailures),
    );
  }

  return {
    jobs: captureStore.all(),
    dropped,
    companiesSeen: [...companiesSeen],
    linkSoftErrors: canaryOutcome.linkSoftErrors,
  };
  ```
- **New this round (judge item N3 — compile error): widen `source()`'s OWN inline return-type
  annotation, not just the `FarmingLane` interface (Step 11).** The code above returns an object with
  a `linkSoftErrors` field, but `lane.ts:124-129`'s `async source(ctx: RunContext): Promise<{ jobs:
  JD[]; dropped: DroppedRecord[]; companiesSeen: string[]; skipped?: { reason: string } }>` does not
  declare it — an excess-property error on the object-literal return, independent of whatever Step 11
  does to the `FarmingLane` port interface (a concrete method's own declared return type and the
  interface it implements are two separate annotations TypeScript checks separately; widening one does
  not widen the other). Add one field to `source()`'s own signature, done in THIS step so the file
  compiles as written without depending on Step 11 running first (removing the step-ordering
  dependency the round-2 draft implicitly had):
  ```ts
  async source(ctx: RunContext): Promise<{
    jobs: JD[];
    dropped: DroppedRecord[];
    companiesSeen: string[];
    skipped?: { reason: string };
    linkSoftErrors?: { url: string; reason: string }[];
  }> {
  ```
  (+1 line, counted in the projection below — Step 11's `ports/lane.ts` widening is still needed
  separately, for `LinkedInLane` to keep satisfying the `FarmingLane` interface it `implements`.)
- Do **not** touch the breaker from this canary path (§8 Risk R-2, unchanged) — a `shell` canary result
  is just `!confirmedHealthy`, identical to any other non-`ok` outcome.
- **Projected `lane.ts` size, recomputed this round (N3 adds +1 to round-3's 392; the round-2
  projection of 386 had omitted the import-line wrap entirely and used the pre-optional-field 4-line
  hoist):**
  - Import widen (`:18`): 1 → 7 lines, **+6**.
  - Hoisted `let`: 0 → 1 line (pure addition, one-line thanks to the optional-field fix above), **+1**.
  - Pre-`finally` call (`canaryOutcome = await evaluateAllFailedCanary(` + 7 one-per-line args
    [`state`, `this.urls`, `this.inventories`, `this.filterCfg`, `() => this.interUrlPause(ctx)`,
    `handle`, `ctx`] + `);`): 0 → 9 lines, pure addition, **+9**.
  - Guard+return block: 6 → 16 lines (9 for the wrapped 3-clause `if`, matching this same file's own
    existing 5-line-wrapped throw at `:325-329`'s precedent, + 1 blank + 6 for the widened `return`),
    **+10**.
  - `source()`'s own return-type annotation (N3, above): 5 → 6 lines, **+1**.
  - Total: 6 + 1 + 9 + 10 + 1 = **+27 lines. 366 (§1's re-measured baseline) + 27 = 393**, 7 lines of
    margin under the 400 cap — tighter than round 2's (wrong) 386/14-margin estimate, but still
    passing. Verify with `npx biome check --write` once implemented; if the real formatter lands even
    slightly higher, **the exact fallback trim (N3's explicit ask — named precisely, not left open)**
    is to collapse the wrapped 3-clause `if` into one pre-computed boolean, each of its two new lines
    fitting under 90 chars on its own (`const allAttemptedFailed = attemptedUrls > 0 && failedUrls ===
    attemptedUrls;` ≈ 79 chars incl. indent; `if (allAttemptedFailed && !canaryOutcome.confirmedHealthy)
    {` ≈ 68 chars incl. indent):
    ```ts
    const allAttemptedFailed = attemptedUrls > 0 && failedUrls === attemptedUrls;
    if (allAttemptedFailed && !canaryOutcome.confirmedHealthy) {
      throw new Error(
        buildAllUrlsFailedMessage(attemptedUrls, stats, state.shellJdFailures),
      );
    }
    ```
    6 lines total, replacing the 9-line wrapped `if` — a further **-3 lines** (393 → 390) if applied.
    Not pre-applied in the base plan above (YAGNI — a named boolean used only once is marginal
    clarity for its own sake), but this is the concrete, ready-to-drop-in trim if `npx biome check
    --write`'s real output lands over 400, not a vague "extract something" note.
- **Done-condition — new file `lane_canary.test.ts` (judge item 3, mirrors `lane_breaker.test.ts`'s
  precedent, keeps `lane.test.ts` at its re-measured 785 lines untouched — no new content added there
  at all), covering AC9's now-5 scenarios:**
  (a) leftovers all fail, `pickCanaryUrl` finds a candidate, `runProbe` → `ok` → no throw;
  `linkSoftErrors` names every failed URL.
  (b) leftovers all fail, canary `shell`/`no-candidate`/`inconclusive` → existing throw, unchanged
  message.
  (c) first slot of the day, every link fails → `resumeState.done` empty → `pickCanaryUrl` returns
  `undefined` → existing throw, canary never attempted (zero extra navigations).
  (d) no link done today (later slot, nothing has ever succeeded) → same as (c).
  (e) **new this revision (judge item 1):** leftovers all fail, a done-today candidate exists, but
  `state.throttleTripped` is `true` (or `state.shellJdFailures > 0`) from this same fire's earlier
  card processing → `runCanaryProbe` returns `'unconfirmed'` without calling `runProbe` at all →
  existing throw, unchanged message.
  `lane.test.ts:502`'s existing all-urls-failed test still passes unmodified (it never populates
  `resumeState.done`, so `pickCanaryUrl` returns `undefined` regardless of this revision's changes).

**Step 11 — `ports/lane.ts` (R11, Must)**
- Widen `FarmingLane.source()`'s return type (`:25-30`) to add
  `linkSoftErrors?: { url: string; reason: string }[]`.
- **Note (N3): order-independent of Step 10 now.** `lane.ts`'s own `source()` method widened its
  inline return-type annotation directly in Step 10 (so that step compiles standing alone); this step
  widens the separate `FarmingLane` interface `LinkedInLane` implements. Both are needed; neither
  depends on the other running first.
- **Done-condition:** typecheck passes; `ApiLane` untouched.

**Step 12 — `src/pipeline/stages/farm.ts` (R11, Must)**
- Define, exported alongside the existing `COMPANIES_SEEN_PATH` pattern:
  ```ts
  const LINK_SOFT_ERRORS_PATH = 'lanes/linkedin/link_soft_errors.json';
  const LinkSoftErrorsSchema = z.object({
    writtenAt: z.string(), // NEW this revision — judge item 7a's staleness guard, consumed by Step 14
    links: z.array(z.object({ url: z.string(), reason: z.string() })),
  });
  export type LinkSoftErrorsDoc = z.infer<typeof LinkSoftErrorsSchema>;
  export { LINK_SOFT_ERRORS_PATH, LinkSoftErrorsSchema };
  ```
- In the lane loop, collect `linkSoftErrors` across lanes into `const linkSoftErrors:
  {url,reason}[] = []`. Immediately before the existing `companies_seen.json` write, unconditionally
  write (mirrors `seen`'s always-write pattern, so a run with zero soft errors never leaves stale data
  from an earlier farm execution):
  ```ts
  await ctx.stateStore.writeDoc(
    LINK_SOFT_ERRORS_PATH,
    LinkSoftErrorsSchema.parse({ writtenAt: new Date().toISOString(), links: linkSoftErrors }),
  );
  ```
- **Residual, addressed this round (judge item 7a's clock-source question):** this `new Date()` is a
  bare call, not `run.ts`'s injectable `RunDeps.now`. Deliberately NOT unified — see §8 R-9 for the
  full justification (in short: `StageContext`, farm's own `ctx` type, has no `now`/clock dependency
  to thread, and the guard only needs coarse same-invocation ordering, which a plain wall-clock call
  already gives with a comfortable multi-second margin).
- **New this revision (judge item 7a, analysis):** this write is **profile-global, not per-run**
  (`state_docs` has one row per key per profile). Confirmed this pass: a `--resume` invocation whose
  seed checkpoint is past `farm`'s position (`run.ts:249`) never re-executes this code at all this
  invocation, and a standalone `jobbunny stage farm` invocation runs it without ever reaching the code
  that builds a digest-facing `RunResult`. Rather than widen the deliberately stage-agnostic
  `StagePayload`/`runPipeline` contract to carry a run identity down into every stage (a materially
  larger, more invasive change for the same outcome — §8 Risk R-4, unchanged reasoning), the fix is a
  **reader-side staleness guard**: `writtenAt` lets Step 14 refuse to trust a doc older than the
  current invocation's own start time, so a stale cross-invocation read can never masquerade as this
  run's own soft errors.
- **New this round (judge item 7 — "the `z` import in farm.ts"):** `farm.ts` does not import `zod`
  today (confirmed by direct read of its current imports — it only imports `CompaniesSeenSchema` from
  `./source.ts`, which owns its own `z` import; `farm.ts` itself has never needed `z` directly). Add
  `import { z } from 'zod';` as a new top-of-file import — without it, `LinkSoftErrorsSchema`'s
  `z.object(...)` call does not compile.
- **Projected `farm.ts` size:** currently 146 lines (confirmed this round, far from the 400 cap) — the
  new `z` import (+1), the `LINK_SOFT_ERRORS_PATH`/`LinkSoftErrorsSchema`/type/export block (+9), the
  `linkSoftErrors` collection variable and loop addition (+~4), and the write call (+4) land it
  around **164 lines**, comfortably clear of any cap — included for completeness per judge item 7's
  "every other touched file near a cap" ask, though this file isn't actually near one.
- **Done-condition (`farm.test.ts`, confirm exists):** a lane returning `linkSoftErrors` on one
  stage-run, then a lane returning none on a later stage-run, results in the doc reflecting only the
  latter (no leakage — unchanged from the earlier draft); the written doc's `writtenAt` is a valid ISO
  timestamp captured at write time.

**Step 13 — `ops/observability/run/result.ts` (R11, Must)**
- Add to `RunResultSchema`: `linkSoftErrors: z.array(z.object({ url: z.string(), label:
  z.string().optional(), reason: z.string() })).optional()`. Additive.
- **Done-condition (`result.test.ts`):** a `RunResult` with `linkSoftErrors` round-trips through
  `RunResultSchema.parse`; one without it still parses (backward compat).

**Step 14 — NEW `src/cli/commands/run_link_soft_errors.ts` (R11, Must)**
**New this revision** (judge item 3): extracts the read-back + staleness guard + label resolution +
enrichment out of `cli/commands/run.ts` into its own file with its own test file, instead of growing
`run.ts`/`run.test.ts` in place.
```ts
export async function resolveLinkSoftErrors(
  result: RunResult,
  opts: { stateStore: StateStore; profile: string; root: string; runStartedAtIso: string; logger: Logger },
): Promise<RunResult> {
  if (result.outcome !== 'passed') return result;
  try {
    const doc = await opts.stateStore.readDoc(LINK_SOFT_ERRORS_PATH, LinkSoftErrorsSchema);
    if (!doc || doc.links.length === 0) return result;
    // Judge item 7a's guard: a doc older than THIS invocation's own start
    // time was written by a DIFFERENT invocation (an earlier --resume that
    // skipped farm, or a standalone `stage farm`) and must never be
    // attributed to this run.
    if (doc.writtenAt < opts.runStartedAtIso) return result;
    let labels = new Map<string, string>();
    const configStore = wireConfigStore(opts.profile, { root: opts.root, liftMode: 'readonly' });
    try {
      const raw = await configStore.readText('search_urls.md');
      if (raw) labels = resolveSearchUrlLabels(raw); // Step 2, keyed by cleaned URL
    } finally {
      configStore.close();
    }
    return {
      ...result,
      linkSoftErrors: doc.links.map((l) => ({ url: l.url, reason: l.reason, label: labels.get(l.url) })),
    };
  } catch (err) {
    // Fail-soft, explicitly: label/side-doc enrichment is cosmetic — never
    // fail an otherwise-passed run over it.
    opts.logger.warn('run: link-soft-error enrichment failed — digest/run-detail will show URLs without labels', {
      message: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
}
```
- **Done-condition (`run_link_soft_errors.test.ts`, new):** a passed result + a fresh (`writtenAt` >=
  `runStartedAtIso`) doc with 2 links + a matching `search_urls.md` → 2 labeled entries; a **stale**
  doc (`writtenAt` < `runStartedAtIso`) → result passed through unchanged, regression test for judge
  item 7a; a `stateStore.readDoc` throw → result passed through unchanged, `logger.warn` called once
  (fail-soft); a `failed` result → passed through untouched without even attempting the read (cheap
  short-circuit).

**Step 15 — `src/cli/commands/run.ts` (R11, Must)**
- After `runPipeline(...)` returns (`:305-314`), before `finishRun`/the digest send: `const
  enrichedResult = await resolveLinkSoftErrors(result, { stateStore: ctx.stateStore, profile:
  ctx.profile, root: resolved.root, runStartedAtIso: now.toISOString(), logger: ctx.logger });`
  (**fixed this round, N6: `resolved.root`, not a bare `root`** — `runCommand`'s own scope has no
  local variable named `root`; the resolved deps object is `resolved: RunDeps = {...defaultDeps(),
  ...deps}` at `:170`, and `RunDeps.root` (`:123`) is what carries it. `now` is the same variable
  already used for `startedAt` at `:279` — reused, not recomputed, so the guard's comparison is
  exact). Use `enrichedResult` for both `ctx.runStore.finishRun(...)` (`:316`) and the digest build
  that follows.
- **Corrected this round (judge item 3): the test file at risk is `src/cli/commands/run.test.ts`
  (re-measured at 779 lines — 21 lines of headroom under the 800 cap), not the unrelated
  `src/pipeline/runner/run.test.ts` (565 lines) the round-1 draft's number actually came from.** Given
  the 779 baseline's thin margin, this step requires **zero new test cases** in `run.test.ts` — the
  wiring is a single function call, fully exercised by Step 14's own `run_link_soft_errors.test.ts`.
  Confirm (mechanical, not a judgment call) that `run.test.ts`'s existing `ctx.stateStore`/fake
  `StateStore` seams already tolerate an unrecognized `readDoc` key gracefully (returning `undefined`,
  the common default for this codebase's fakes) — if exactly one existing fake is strict-mode and
  rejects an unexpected key, widen that one fake by a single line; do not add new `test(...)` blocks.
- **Done-condition:** `run.test.ts` stays at 779 lines or grows by at most the single-line fake
  widening above (never a new test case); `src/cli/commands/run_link_soft_errors.test.ts` (Step 14)
  is where this behavior is actually asserted.

**Step 16 — `ops/observability/report/digest/digest.ts` (R11, Should)**
- After the funnel block, only `if (passed && result.linkSoftErrors?.length)`: the UX §5 block — title
  line, up to 5 `  • <label ?? shortened url> — <reason>` lines, `+N more` if truncated, then `Fix:
  board → Settings → Where jobs come from`.
- **Done-condition (`digest.test.ts`):** matches the UX §5 literal example (mockup.html:638-641);
  absent on a `failed` outcome (total-outage digest byte-identical to today).

**Step 17 — R8 repair (operational plan, Must — never executed by this blueprint or its executor)**
Once Steps 1-5 land:
1. `jobbunny config get search_urls.md --profile harish > /tmp/harish-before.md` (read-only).
2. A throwaway, uncommitted script imports `normalizeSearchUrlsDoc` (Step 2) against
   `/tmp/harish-before.md`'s contents and writes **two separate output files, never one mixed
   file** (fixed this round, N2's Step-17 sibling instruction — piping a file that mixes real content
   with diff markup into `config set` would write the diff markup itself as if it were doc content):
   the result's `text` alone to `/tmp/harish-after.md`, and a unified diff of before-vs-after to a
   SEPARATE `/tmp/harish-diff.txt`. No write to the profile yet.
3. **Reconciled this revision (judge "Also" item, AC11):** AC11 says the diff shows "exactly the 3
   links moved... and cleaned," but Step 2's rebuild regenerates the **whole document structure**
   (headings, `<!-- inventory: -->` comments), so `/tmp/harish-diff.txt` will also show comment-line
   churn around the 3 substantive moves, not a surgical 3-line patch. Present `/tmp/harish-diff.txt`
   to the user with this distinction called out explicitly: the 3 link relocations/cleanings are the
   only *semantic* change; every other diff line is mechanical structure regeneration that is
   byte-identical in effect to what `lane_add_url.ts`'s own inventory-comment insertion already
   produces today. **Only after separate, explicit user approval**: pipe **only the text file**, never
   the diff, into the write: `cat /tmp/harish-after.md | jobbunny config set search_urls.md --profile
   harish`.
4. Never run against `profiles/rajni/` (the fixture, not the affected data); never touch Notion.
- **Done-condition:** `/tmp/harish-diff.txt` shows the 3 links moved to `linkedin__jobs-search-results`
  and cleaned, with the structural-regeneration distinction called out per the reconciliation above;
  `/tmp/harish-after.md` contains ONLY the rebuilt document text (no diff markup mixed in); nothing
  written to the profile until approval, and only `/tmp/harish-after.md` is ever piped into the write.

**Step 18 — Docs-as-code (R12, Should)**
- `.claude/agents/explainer.md`:
  - `core/config` entry (`:144`): add Steps 1, 2, 5's three new modules.
  - `lanes/linkedin` entry (`:166`): add one sentence on the canary escape hatch (Step 9-10, including
    the throttle/shell skip condition) and that `lane_add_url.ts` now delegates to `core/linkedin_url/`.
    **New this revision:** also note `fire/canary.ts` as a new sibling to `fire/probe.ts`.
  - Config→db Phase 4 entry (`:224`): note `search_urls.md` saves now normalize/re-file/dedupe via
    `app/features/config/search_urls_save.ts` → `core/config/search_urls/`; `config export|import`
    remains byte-exact and untouched; note that Step 5b's `ui/e2e/seed_misfiled_search_url.ts`
    test-only direct seed exists specifically because normalization never lives inside the adapter.
  - CLI surface entry (`:263`): note `lane add-url` delegates classification to `core/linkedin_url/`.
- `.claude/agents/executor.md`: grep for a stale `lane_add_url.ts`-owns-its-own-ephemeral-list
  reference; none found this pass — confirm at implementation time.
- **CLAUDE.md, "fail-soft/fail-loud" bullet:** no wording change identified as necessary — it stays
  accurate at its level of abstraction (the canary is a narrower nuance, not a contradiction).
- **CLAUDE.md, dependency-free-modules list — NEEDS USER APPROVAL, new this round (judge item 5):**
  the `ui/` layer-boundary paragraph names the CLOSED list of core modules `ui/` may import at runtime
  ("Currently the only such modules are..."), and this feature makes `ui/` import Step 1's
  `src/core/linkedin_url/` (R2/R9's client-side badge/classify calls, §6). That sentence goes stale
  the moment this ships unless updated in the SAME change (CLAUDE.md's own "Conventions" section:
  "Per-module contracts... are architecture docs as code — update them in the same change that alters
  behavior"). **This blueprint cannot make this edit itself (WRITE BOUNDARY)** — it is named here as a
  required, pre-approved-text change for whichever agent/user does the actual edit. Proposed verbatim
  diff, in the `## Pipeline architecture` section's `ui/` boundary paragraph:
  - Before: `` Currently the only such modules are `src/core/datetime/`, `src/core/normalize_token/`,
    and `src/core/tracking/vocab.ts` (also dependency-free). ``
  - After: `` Currently the only such modules are `src/core/datetime/`, `src/core/normalize_token/`,
    `src/core/linkedin_url/`, and `src/core/tracking/vocab.ts` (also dependency-free). ``
  - Nothing else in that paragraph changes — the surrounding sentences (`depcruise src` never
    traversing `ui/`, the "must import nothing" rule, the `ui:build`-vs-`npm run check` failure-mode
    distinction) already describe `src/core/linkedin_url/`'s own Step 1 contract exactly as written,
    with no further wording needed.
- Dispatch `kb-curator` against the branch diff once Steps 1-17 land — hand it this step's verbatim
  CLAUDE.md diff directly rather than having it re-derive the wording.
- **Done-condition:** the 4 explainer.md locations reflect the new modules/behavior; the CLAUDE.md
  edit above is applied ONLY after a recorded user approval of the exact verbatim text — never
  applied silently, never paraphrased.

---

## 6. Requirements Coverage

| # | Requirement | MoSCoW | Server-side delivery |
|---|---|---|---|
| R1 | Dependency-free classify+clean module | Must | Step 1 |
| R2 | Board Settings files by derived page type, `DEFAULT_SLUG` gone | Must | **UI-only** for display (calls Step 1); actual filing authority on save is Steps 5-7 |
| R3 | Board API + `config set` normalize/re-file/clean/report on save | Must | Steps 2, 4, 5, 6, 7 |
| R4 | Every save path rejects an unclassifiable link, nothing written | Must | Steps 1, 2, 5 |
| R5 | `lane add-url` delegates to R1, no duplicated logic | Must | Step 3 |
| R6 | Later-slot all-fail + known-good canary succeeds → soft errors, run continues | Must | Steps 8, 9, 10 |
| R7 | Genuine outage still fails loud | Must | Step 10 (guard preserved, canary-unconfirmed path incl. throttle/shell gate) |
| R8 | One-time `harish` repair, dry-run + separate approval | Must | Step 17 (operational plan; never auto-executed) |
| R9 | Settings shows derived page type + cleaned/refused feedback | Should | **UI-only** for rendering; data source is Steps 5-7 |
| R10 | Identical-after-cleaning links collapse on save | Should | Step 2 (dedupe), surfaced via Steps 5-7 |
| R11 | Digest/run detail names soft-failed links | Should | Steps 11, 12, 13, 14, 15, 16 |
| R12 | Docs-as-code updated in the same change | Should | Step 18 |
| R13 | Existing misfiled links flagged on Settings load | Could | **UI-only** — client compares stored heading vs Step 1's classify on the existing GET response; no new server endpoint. Its e2e coverage needs `ui/e2e/seed_misfiled_search_url.ts` (Step 5b, judge item 5) since every PUT now auto-fixes misfiles and can no longer seed one. |

Every spec Must is covered by a numbered step or explicitly UI-only.

---

## 7. Failure Semantics (fail-soft vs fail-loud, per new path)

| Path | Posture | Why |
|---|---|---|
| `classifyLinkedInSearchUrl` / `normalizeSearchUrlsDoc` throw (Steps 1-2) | **Fail-loud**, nothing written | R4 is a Must; both write call sites (Step 5) validate-before-write, so a throw structurally guarantees no partial write. |
| Zero-rows-from-non-empty-input guard (Step 2, new this revision) | **Fail-loud** | A silent parse gap must never look like "the user deleted every link" — refuse and preserve the stored doc rather than risk writing an empty rebuild. |
| Board PUT / CLI `config set` for `search_urls.md` (Steps 4-7) | **Fail-loud** (422 / exit 1) on an unrecognized link; silent success on a merely dirty/misfiled one | Matches spec §8 Q2-Q4. |
| Canary probe navigation (Step 9-10) | **Bounded, non-throwing** in the common case; **short-circuited** (zero navigation) on a throttle trip or any shell failure this fire | Reuses `runProbe`'s existing `DEFAULT_GOTO_TIMEOUT_MS` (30s) bound; every internal failure already becomes `ProbeOutcome: 'inconclusive'` rather than a throw. **New this revision (judge item 1):** the throttle/shell gate means the canary is never even attempted against a session already showing distress this fire — the loud throw fires immediately, with no wasted navigation and no chance of a misdiagnosing lucky `ok`. |
| All-attempted-failed guard, canary confirms healthy (Step 10) | **Downgrades from fail-loud to fail-soft**, run continues | This is R6. |
| All-attempted-failed guard, canary unconfirmed / not-attempted / gated by throttle-shell (Step 10) | **Fail-loud, unchanged** | R7 is a Must; deliberately conservative — no scope expansion into breaker state (§8 Risk R-2). |
| Farm's own side-write (Step 12) | **Fail-loud** (inherits `StateStore.writeDoc`'s existing LOUD contract) | Consistent with `companies_seen.json`'s write right beside it. |
| Farm side-doc staleness guard (Step 14, new this revision) | **Fail-soft — silently ignores a stale doc** | Not an error condition; a stale doc simply means this invocation's own farm never ran (or ran and had nothing to report before this read), so "no `linkSoftErrors`" is the correct, unremarkable outcome, not a failure to surface. |
| Label resolution for the digest/run-detail (Step 14) | **Fail-soft, explicitly** | Cosmetic — a `ConfigStore` read failure must never fail an otherwise-passed run. Falls back to `label: undefined`. |
| `formatDigest`'s new block (Step 16) | **Pure, cannot fail** | No I/O added to `digest.ts` itself — all resolution happens upstream (Step 14). |
| R8 repair apply (Step 17, step 3) | **Never automated** | Operator-gated by design. |

**Idempotency/bounded-wait check:** every new state-changing path (Steps 5-7's writes, Step 12's
side-write) is a full-document overwrite, safe to re-run. The canary navigation (Steps 9-10) is
read-only (no `markDone`/`resumeState.persist` for the canary URL), safe to re-run. Every network/CDP
call inherits an existing `AbortSignal`/`timeoutMs` bound.

**New this revision — the zero-JD-captured guard's interaction with a `'confirmed-healthy'` canary
(judge "Also" item):** `lane.ts`'s SEPARATE, pre-existing guard (`totalCardsAttempted > 0 &&
totalCaptured === 0` → `buildNoJdCapturedVerdict`, unchanged by this blueprint) can still throw even
after a canary confirms the session healthy, in the narrow case where **every** capture today —
this fire's and every earlier same-day fire's — is genuinely zero (`priorCaptures === 0`). This is
**intended, not a bug**: the canary answers "is the session blocked," a different question from "did
today's run capture anything." Making a `'confirmed-healthy'` canary also suppress this second guard
would require appending the canary's own JD into `captureStore` — reopening the duplicate-capture risk
Step 9 deliberately avoids — for a scenario (zero captures all day, even with a healthy session) that
is independently worth a loud signal on its own merits. No behavior change from today in this
sub-case: it would have thrown via the FIRST guard before this blueprint; it now throws via the
SECOND guard instead, with an unchanged outcome (loud failure) either way.

---

## 8. Risks & Assumptions

- **R-1 (accepted syntax duplication).** `adapters/lanes/linkedin/search_urls.ts`'s `parseSearchUrls`
  (read-only, trusts headings) and Step 2's row parser (read+write, ignores headings for
  classification) both hand-roll the same line grammar — `core-is-pure` forbids sharing it directly.
  If the grammar ever changes, both need updating (Step 18's explainer entries flag this).
- **R-2 (canary does not touch the breaker).** A canary `shell`/`unconfirmed` result never calls
  `openBreaker`/`closeBreaker` — spec §8 Q7's literal mechanism only, no scope expansion on an
  already-PROVISIONAL guard change.
- **R-3 (canary URL choice, redesigned this revision — judge item 2).** `pickCanaryUrl` now prefers a
  captured-count > 0 done-today URL that is also present in the CURRENT `this.urls`, rather than an
  arbitrary first key. This closes both false-negative paths the judge identified: a chronically
  barren done URL, and a done key stale relative to a same-day re-file. If it still shows a false
  negative in live verification (a captured>0 URL that later becomes barren mid-day for unrelated
  reasons), that is a live-verify finding to revisit, not a known gap at blueprint time.
- **R-4 (the farm→digest coupling stays outside `pipeline/runner/run.ts`).** Step 14 lives in
  `cli/commands/`, not the stage-agnostic runner — a deliberate, minimal, feature-scoped coupling
  (`cli/commands/run_link_soft_errors.ts` imports `pipeline/stages/farm.ts`'s exported constants)
  chosen over the larger alternative of threading a stage-specific field through `StagePayload`.
- **R-5 (label resolution re-reads `search_urls.md` at run end, not at farm time).** A link removed
  from Settings between the soft-failure and the digest shows up label-less (shortened-URL fallback)
  — acceptable, matches UX's own `diag-url` fallback idiom.
- **R-6 (corrected this round — judge item 1 HIGH; the round-2 text here was wrong).** Round 2 claimed
  "the board UI never produces this input shape (C12's auto-added empty row)" as the justification for
  a guard that threw on any non-empty, zero-row doc — **that claim was false**, confirmed this round by
  reading `WhereJobsComeFromSection.tsx:173-188` directly: it PUTs `search_urls.md` on **every** save
  of this settings card (a lanes-only change included), and a zero-link profile's `rows` state
  (`serializeSearchUrlRows([])` or a still-blank C12 row, `  •  - `) is exactly this shape, submitted
  routinely, not hypothetically. The guard is now redefined (Step 2, judge item 1) to scan for
  bullet-shaped-but-unparsed lines specifically, excluding both "no bullet lines at all" and "a
  trivially-blank placeholder bullet" — both pass with zero throw. Only a raw `SEARCH_URLS_TEMPLATE`
  (prose with no bullet-shaped lines whatsoever) also passes cleanly now, which is the correct behavior
  regardless of whether the UI ever produces it — refusing was never actually needed for that specific
  shape once the guard is scoped to genuine parse failures.
- **R-7 (spec §15's PROVISIONAL flag on R6/R7 stands).** This revision's mechanism follows spec §8 Q7
  and passes AC9's now-5 enumerated scenarios by construction; the spec's required judge pass on the
  blast-radius/failure-mode analysis (AC12) is this §7/§8 section, not a verdict this blueprint grants
  itself.
- **R-8 (new this revision — persistently-bad-link degradation, judge item 7b, analysis).**
  `lane.ts:191-195`'s `allDone()`/`rescanReset()` never fires while one link keeps failing forever, so
  every later same-day slot attempts *only* that link, canaries successfully off an earlier-today good
  link, and reports a soft error every time — near-zero *incremental* LinkedIn yield for the rest of
  the day, every day this persists. **Judged acceptable, stated explicitly:**
  - It is **strictly better** than today's behavior for the same scenario: today, this pattern fails
    `farm` loud on every later slot, aborting the ENTIRE 10-stage run (`farm.ts:119-129`'s documented,
    accepted cost) — Greenhouse/Keka sourcing, filtering, ranking, and sync never run either. After
    this fix, only LinkedIn's own (already-near-zero) incremental contribution on that slot is lost;
    every other stage runs normally.
  - It is **not silent**: R11 (Steps 11-16) names the same link in every single digest it recurs in —
    a user watching Telegram across a day sees the identical "1 search link failed" message repeatedly,
    which is itself a strong, repeated signal that this one link is chronically broken, not a one-off.
  - Escalating this further (e.g. tracking consecutive same-day soft-fail counts and quarantining after
    N) is spec §14's own Out-of-Scope item ("Per-link health tracking / automatic quarantine... a wider
    reliability feature") — deliberately not built here.
- **R-9 (new this round — the `writtenAt` clock-source question, judge item 7a residual).** Step 12
  writes `writtenAt` via a bare `new Date()`; Step 15 compares it against `run.ts`'s injectable
  `RunDeps.now` (`:122,139,172`). **Justified, not unified:** (a) `farm.ts` runs inside
  `pipeline/stages/`, receiving only `StageContext` (`storage`, `stateStore`, plus the base
  `RunContext` fields — no `now`/clock dependency exists on that type to thread through; adding one
  would touch every stage's context shape for a single stage's need, the same disproportionate-change
  reasoning §8 R-4 already applies to keeping `pipeline/runner/run.ts` untouched). (b) The comparison
  only needs coarse same-invocation ordering — `writtenAt` is captured well after `runStartedAtIso`
  (farm runs after doctor preflight, lock acquisition, and wiring all complete), so real wall-clock
  drift between two independent `new Date()` calls in the same process, milliseconds apart at most, is
  many orders of magnitude smaller than the multi-second-to-minutes gap between them in every real
  invocation. (c) Step 14's own test coverage (`run_link_soft_errors.test.ts`) exercises the guard's
  boundary condition directly, feeding fabricated `writtenAt`/`runStartedAtIso` strings into
  `resolveLinkSoftErrors` — it never needs `farm.ts` to actually run, so farm's clock being
  non-injectable creates no test gap either.
- **R-10 (new this round — `stage farm` and the run lock, judge item 7a residual, LOW).**
  `run.ts:124-130,192`'s cross-process `acquireLock`/`releaseLock` guards a full `jobbunny run`
  invocation ("all profiles share one Chrome/CDP session"), but whether a standalone `jobbunny stage
  farm` invocation goes through the same lock is **not confirmed by this recon pass** — worth
  verifying at implementation time, not a blocker here. Even unlocked, the **harmful** consequence (a
  stale/foreign write being misattributed to the wrong run) is already closed by Step 12/14's
  `writtenAt` guard regardless of locking; a lock would add true mutual exclusion between two
  concurrent farm writers (narrower benefit: avoiding one write clobbering another's `links` array
  mid-run, itself no worse than `companies_seen.json`'s identical, already-accepted lockless pattern),
  not prevent a wrong-invocation READ. LOW because it requires two farm-writing invocations running at
  the literal same moment, which `acquireLock` already prevents for the far more common `run`-vs-`run`
  case.

---

## 9. Live Verification (spec AC10, to run after Steps 1-15 land, on `rajni` — never `harish`)

**ATTENDED — not part of any unattended/automated run.** This whole section requires a human at the
keyboard (manually launching Chrome, logging into LinkedIn once by hand) and is executed **after the
build**, with the user present — never scripted into CI, the daemon, or any unattended verification
pass. This is a user-decided design (N1), rewritten this round to replace round 3's incorrect
`cdp-chrome`-userDataDir isolation claim (already corrected once in round 3's own text; this round
adds the full manual-Chrome procedure the correction implied but didn't spell out).

**Isolation recap (unchanged reasoning from round 3, still holds): `root`, via `JOBBUNNY_HOME=$PWD`,
is what isolates `rajni` from `harish`.** `rajni` exists only under the repo checkout's
`profiles/rajni/`; the real default home (`~/.jobbunny/profiles/`) holds only `harish`. The breaker
file's path is `deps.chromeUserDataDir` = `path.join(root, 'chrome')` (`compose.ts:241`), **never**
influenced by `config.settings['cdp-chrome']` (that key only reaches `CdpChromeProvider`'s own
constructor, `compose.ts:283-288`) — so with `JOBBUNNY_HOME=$PWD`, the breaker file always lands at
`$PWD/chrome/.jobbunny-linkedin-breaker.json`, **never** `~/.jobbunny/chrome/...` — confirmed for
both scenarios below, since both run under the same `JOBBUNNY_HOME=$PWD`.

**New this round — `CdpChromeProvider` does not launch Chrome, it only attaches.** Confirmed by the
orchestrator against `adapters/browser/cdp-chrome/provider.ts`: it connects to whatever Chrome is
already reachable on the configured port. There is no `userDataDir` flag that makes the provider
launch an isolated instance itself — **the operator must manually launch Chrome** with the matching
`--user-data-dir`/`--remote-debugging-port` flags before running `jobbunny run`, and `rajni`'s
`cdp-chrome.port` override is what points the provider at that specific manually-launched instance
instead of whatever (if anything) is listening on the default port 9222. A distinct port per scenario
is therefore **mandatory**, not defense-in-depth — without it, the provider would silently attach to
whatever else is reachable on the shared default port.

**Directories (name them, gitignored, under the repo — new this round):**
- `.verify-chrome-s1/` — scenario 1's dedicated, isolated Chrome profile dir. Logged into LinkedIn by
  hand once, then reused for the whole scenario-1 sequence.
- `.verify-chrome-s2/` — scenario 2's dedicated, isolated Chrome profile dir. **Never logged into
  anything** — its "logged out" state is simply that it has never authenticated, not an explicit
  sign-out of any real session.
- Add both to `.gitignore` if not already covered by an existing pattern (check `git status` after
  creating either — if it shows as untracked-and-would-be-added, add the entries; Chrome profile dirs
  must never be committed — caches, cookies, local storage).

**Setup (once, before either scenario):**
1. `jobbunny serve stop` (quiesce the daemon under the REAL default home — it is the sole run spawner
   for `harish`'s real schedule; an unrelated collision risk during manual verification, independent
   of the isolation mechanism above).
2. Back up BOTH files that this procedure will mutate: `JOBBUNNY_HOME=$PWD jobbunny config get
   profile.json --profile rajni > /tmp/rajni-profile-before.json` and `JOBBUNNY_HOME=$PWD jobbunny
   config get search_urls.md --profile rajni > /tmp/rajni-search-urls-before.md`.
3. Confirm nothing is already listening on the two chosen ports before launching anything:
   `lsof -i :9223` and `lsof -i :9224` (or the platform equivalent) — both must return nothing.

**Scenario 1 — bad-link, canary confirms healthy (AC10a):**
1. Launch Chrome by hand: `<chrome-binary> --remote-debugging-port=9223 --user-data-dir="$PWD/
   .verify-chrome-s1" & echo $! > /tmp/verify-chrome-s1.pid` (resolve `<chrome-binary>`'s path via
   `jobbunny doctor --profile rajni`'s own Chrome-discovery check, or the platform's standard Chrome
   location — capturing the PID here is what makes teardown precise, not a blanket process kill).
2. **Log into LinkedIn in this window by hand, once.** This session persists in `.verify-chrome-s1/`
   for the rest of this scenario.
3. Point `rajni` at it: `JOBBUNNY_HOME=$PWD jobbunny config set profile.json --profile rajni` with
   `settings['cdp-chrome'].port: 9223` added (leaving `userDataDir` unset — the provider attaches by
   port, per the correction above; the manually-launched instance's own `--user-data-dir` flag is what
   actually determines the profile, not anything in `profile.json`).
4. **Stated precondition sequence (N1's explicit instruction — good links done TODAY, THEN the bad
   link added, not both present from the start):**
   a. Run once with `rajni`'s EXISTING good links only: `JOBBUNNY_HOME=$PWD jobbunny run --profile
      rajni` — marks them done today (`resumeState.done` now has entries with `captured > 0`).
   b. THEN add one link that will reliably fail to harvest (a garbage/expired search id) via
      `JOBBUNNY_HOME=$PWD jobbunny config set search_urls.md --profile rajni` (goes through Step 2's
      normalize/Step 4's orchestration like any other save).
   c. Run a **second same-day** invocation: expect **pass** — `linkSoftErrors` naming the bad link.
      **Corrected this round (N1's explicit instruction): assert via the persisted `RunResult`, not
      the digest** — `rajni`'s `profile.json` has `"notifiers": []` (confirmed), so no digest is ever
      sent for this profile. Inspect `jobbunny runs show <run-id> --profile rajni` (or the board's
      run-detail API/DB `runs.result` column directly) for `linkSoftErrors` naming the bad link.
5. Kill scenario 1's Chrome: `kill "$(cat /tmp/verify-chrome-s1.pid)"`. Scenario 1's persisted state
   (`resumeState.done` in the DB, not tied to the Chrome process) survives this for scenario 2 to use.

**Scenario 2 — logged out, canary correctly fails to confirm (AC10b):**
**Stated precondition:** must run **on top of** scenario 1's already-completed state (good links done
today, the same bad leftover link still present) — not fresh. Without it, the all-attempted-failed
guard never engages (no done-today candidate for `pickCanaryUrl`), and the scenario would trivially
hit the "no canary" throw path without ever exercising the logged-out probe.
1. **New this round — reset the shared breaker file before this scenario.** Both scenarios run under
   the SAME `JOBBUNNY_HOME=$PWD`, so `deps.chromeUserDataDir` (and therefore the breaker file's path,
   `$PWD/chrome/.jobbunny-linkedin-breaker.json`) is IDENTICAL for both, even though they use
   physically different Chrome instances/ports — scenario 1's canary activity could otherwise leave
   breaker state that contaminates scenario 2's read. Delete `$PWD/chrome/
   .jobbunny-linkedin-breaker.json` if present (harmless if absent — a missing/corrupt breaker file
   reads as `closed`, per its own documented behavior).
2. Launch a SEPARATE, brand-new, never-logged-in Chrome on the OTHER port: `<chrome-binary>
   --remote-debugging-port=9224 --user-data-dir="$PWD/.verify-chrome-s2" & echo $! >
   /tmp/verify-chrome-s2.pid`. **No sign-out on any real session anywhere** — this profile's "logged
   out" state is simply that it was never logged in.
3. Re-point `rajni` at the new port: `JOBBUNNY_HOME=$PWD jobbunny config set profile.json --profile
   rajni` with `settings['cdp-chrome'].port: 9224`.
4. Run a same-day later invocation: `JOBBUNNY_HOME=$PWD jobbunny run --profile rajni` — expect the
   existing loud total-outage failure, unchanged message shape — the canary, probing this never-
   logged-in session, must return `'unconfirmed'`, not `'confirmed-healthy'`.
5. Kill scenario 2's Chrome: `kill "$(cat /tmp/verify-chrome-s2.pid)"`.

**Teardown (new this round — restores BOTH mutated files, not just `profile.json`):**
1. Restore `rajni`'s `profile.json`: `cat /tmp/rajni-profile-before.json | JOBBUNNY_HOME=$PWD jobbunny
   config set profile.json --profile rajni` (removes both scenarios' `cdp-chrome.port` overrides).
2. Restore `rajni`'s `search_urls.md`: `cat /tmp/rajni-search-urls-before.md | JOBBUNNY_HOME=$PWD
   jobbunny config set search_urls.md --profile rajni` (removes the bad link added in scenario 1 step
   4b — the committed fixture must not end up permanently modified by a manual verification run).
3. Confirm no stray Chrome remains: both pidfiles should already be dead from each scenario's own
   step 5 above; if either process is somehow still alive, `kill` it by its recorded PID — never a
   blanket `pkill chrome`, which could kill the operator's own unrelated Chrome windows.
4. `jobbunny serve start` (undo setup step 1, restoring normal daemon operation for `harish`).

Both scenarios exercise Step 10 end-to-end and are the acceptance bar for AC10 — this blueprint
specifies them; execution is a later-stage (implementation/QA) responsibility, attended, by a human.

---

## 10. Out of Scope

Unchanged from spec §14 — live preview at save time, per-link health tracking/quarantine (see §8 R-8),
read-time URL routing in the pipeline parser, degraded-run status for ATS lanes, page types beyond the
two existing inventories, a manual page-type override, generic tracking-parameter stripping. Plus,
from this blueprint's own recon:
- Refactoring `adapters/lanes/linkedin/search_urls.ts`'s `parseSearchUrls` to share code with Step 2's
  parser (§8 R-1) — accepted duplication instead.
- Wiring the canary into breaker state (§8 R-2).
- Any change to `config export`/`config import`'s byte-exact round-trip behavior.
- A new permanent CLI verb for the `harish` repair (Step 17) — a documented one-off procedure using
  already-shipped code in dry-run mode.
- A production "seed raw config doc, skip normalization" CLI/API surface — the R13 e2e seed path
  (Step 5b, `ui/e2e/seed_misfiled_search_url.ts`) is test-only, using the adapter's own unmodified
  `writeText` directly, never a new shipped endpoint (judge item 5's explicit constraint).
- Escalating a persistently-bad link beyond what R11 already surfaces per-occurrence (§8 R-8).
