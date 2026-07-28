# File-Size Splits (PRs 2–7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 12 pinned over-cap files under the gate's caps (impl ≤ 400, test ≤ 800), one PR per group, ending with the pin machinery deleted.

**Architecture:** Pure code motion — no behavior change anywhere. Each task moves named declarations (line ranges refer to `main` at `bf43647`, before any split) into sibling modules, updates imports, shrinks the gate's pin list, and lands as its own PR. Public module surfaces (`index.ts` exports and importer-visible paths) stay stable except the documented `cli/wire.ts` → `cli/wire/` change. The repo's **executor agent** proposes final file/subfolder placement (two-pair rule: a folder over two implementation files splits into subfolders); this plan locks the seams, not the folder shapes.

**Spec:** `docs/superpowers/specs/2026-07-28-file-size-caps-design.md`.

## Global Constraints

- Node ≥ 24; ESM, TS7 strict, erasable-syntax-only; Biome formatting; no new dependencies.
- **Pure code motion.** Moved functions keep their exact bodies. Where a class-method body becomes a free function, its statements move verbatim; only the parameter plumbing is new. No renames of exported symbols, no behavior or logging changes, no "while I'm here" fixes.
- **Every task:** branch from freshly-pulled `main` (previous PR merged first — MERGE GATE below); `npm run check` green before the PR; every new file under its cap; colocated tests move with the code they exercise; zero test blocks deleted (verify: total `node --test` pass count must not drop below the pre-task count).
- **Pins:** each task removes/updates its files' entries in `test/invariants/filesize.test.ts` and sets the `PINS.size <=` ceiling literal to the new entry count.
- **MERGE GATE:** each task ends with a PR + CI green, then STOPS for the human to merge (or explicitly authorize `gh pr merge --merge --delete-branch`). The next task must not start from an unmerged base.
- Never run anything against `profiles/harish/`; runtime verification uses `profiles/rajni/` only.
- Docs are code: a task that changes documented architecture updates `.claude/agents/executor.md`, `.claude/agents/explainer.md`, and `CLAUDE.md` in the same PR.

---

### Task 1 (PR 2): Split the LinkedIn lane — branch `feat/split-linkedin-lane`

**Files:** `src/adapters/lanes/linkedin/lane.ts` (1173) and `lane.test.ts` (2956). The folder already has 7 extracted sibling modules; `index.ts` publicly exports `LinkedInLane`, `parseSearchUrls`, and types `LinkedinBreakerConfig`, `SearchUrlGroup` — that surface must not change.

**Implementation moves (from lane.ts):**

- [ ] **1. `pacing.ts`** — `DEFAULT_JITTER_MIN_MS`/`MAX_MS`, `DEFAULT_INTER_URL_DELAY_MIN_MS`/`MAX_MS`, `jitterMs()` (lines 68–122).
- [ ] **2. `pagination.ts`** — `buildPageUrl()`, `resolvePagination()`, `sameCardIdSet()`, `PaginationConfig`, `SINGLE_PAGE_PAGINATION` (130–193 + types at 149–159).
- [ ] **3. `search_urls.ts`** — `SearchUrlGroup`, `parseSearchUrls()`; `index.ts` re-export path updated (public surface identical).
- [ ] **4. `probe.ts`** — `classifyJdOutcome` and `runProbe` (378–465) become free functions taking an explicit deps argument (the lane fields they read: inventories, filterCfg, plus page/handle/ctx); `ProbeOutcome`, `JD_ROOT_PRESENCE_TIMEOUT_MS` move with them.
- [ ] **5. `evidence.ts`** — the all-URLs-failed evidence assembly and lane-wide no-JD guard message building (1072–1169) as pure functions over the collected stats, plus `FailureKind`, `zodIssuesMessage`, `todayIso`, `toSoftError` (253, 270–287).
- [ ] **6. `url_runner.ts`** — the per-group/per-URL/per-page/per-card loop (677–1031) as one exported function receiving a single mutable state object (stats, dropped, companiesSeen, captureStore, resumeState, throttleCounter, breaker phase data) plus a deps object (browser handle, inventories, filterCfg, pacing fns, cache set, caps). This is the load-bearing extraction — statements move verbatim; `this.x` reads become `deps.x`/`state.x`.
- [ ] **7. `lane.ts` keeps** the class: fields, constructor (signature unchanged — the pacing-slot structural-cast test pins it), `jitter`/`interUrlPause` methods, and a `source()` reduced to orchestration: breaker phase handling, probe invocation, calling the url runner, aggregates, guards via `evidence.ts`. Target ≤ 400.
- [ ] **8.** Executor agent proposes subfolder grouping for the new files (e.g. a `fire/` subfolder for probe/url_runner/evidence) per the two-pair rule; `index.ts` exports unchanged.

**Test moves (from lane.test.ts, per its block map):** shared fixtures (FakeStorage/FakePage/FakeBrowserHandle/FakeBrowserProvider/Script/newScript/seed helpers/fakeBreakerFs, lines 22–397 and 1848–1980) go to one or two test-kit modules **each under 400 lines** (they are implementation files to the gate). Suites split roughly: core happy-path/errors/resume/persistence (399–1164) stays as `lane.test.ts`; cache/dedup/cap (1166–1316) + probe UrlStat (2813–2914) + constructor-slot (2916–2956) stay with it if room, else a `lane_features.test.ts`; pagination (1318–1819) → `pagination.test.ts` beside `pagination.ts` (includes the `buildPageUrl` unit tests); jitter + inter-URL pacing (1821–2139) → `pacing.test.ts`; breaker suite (2172–2812) → `lane_breaker.test.ts`; `parseSearchUrls` blocks (2141–2170) → `search_urls.test.ts`. Every resulting test file ≤ 800.

- [ ] **9.** Record pre-split totals: `npm test 2>&1 | tail -5` (pass count) and per-file `wc -l`. After the split, pass count must be ≥ the same number.
- [ ] **10.** Pins: remove `lane.ts` and `lane.test.ts` entries; ceiling literal → 10.
- [ ] **11.** `npm run check` green; commit in reviewable slices (helpers first, then probe/evidence, then url_runner, then test splits); PR titled `refactor(linkedin): split lane.ts and lane.test.ts under the size caps`. **MERGE GATE.**

**Risk note:** this folder holds the freshly-shipped throttle guard (PR #59). The 52-block suite drives behavior through `source()`'s public API, so it survives internal motion — any test edit beyond an import path or fixture reference is a red flag to stop and reassess.

---

### Task 2 (PR 3): wire.ts becomes `cli/wire/` — branch `feat/split-wire`

**Files:** `src/cli/wire.ts` (772), `wire.test.ts` (882). Five commands import `wire`/`WireResult` from `../wire.ts`.

- [ ] **1.** Create `src/cli/wire/` with: `config.ts` — `ConfigLoaderDeps`, `resolveRoot`, `resolveReadFile`, `isNotFound`, `loadPipelineConfig`, `loadFilterConfig` (113–167); `registry.ts` — `RuntimeDeps`, `CheckFactory`, `AdapterRegistry`, `resolveFactory`, `assembleAdapterChecks` (174–246); `settings.ts` — all defaults + resolvers + `LinkedinPacingSettingsSchema` (254–268, 447–562); `compose.ts` — everything that imports `src/adapters/**`: `realRegistry` (270–303), stub/builders/type guards (313–344), `LiveLaneDeps`, `buildLanes`, `buildLinkedInLane` (346–445), `WireOverrides`, `WireResult`, `wire()` (566–772); `index.ts` — re-exports the exact current public surface. If `compose.ts` lands over 400, split its lane/connector builders into a sibling `builders.ts` and extend the depcruise carve-out to both files.
- [ ] **2.** Delete `src/cli/wire.ts`; update the five command imports to `../wire/index.ts`.
- [ ] **3.** `.dependency-cruiser.cjs`: `only-wire-imports-adapters` `pathNot` becomes `'^src/cli/wire/compose\\.ts$'` (plus `builders.ts` if created). Verify the rule still FIRES: temporarily add an adapter import to `src/cli/main.ts`, run `npm run boundaries`, confirm an error, revert.
- [ ] **4.** Same-PR doc updates: CLAUDE.md (every `cli/wire.ts` mention → the folder/compose path), executor.md §1/§2 rule 5, explainer KB's wire references.
- [ ] **5.** Split `wire.test.ts` by target: resolver blocks (90–180) → `settings.test.ts`; `assembleAdapterChecks` (184–331) → `registry.test.ts`; loaders (343–419) → `config.test.ts`; `wire()` end-to-end (435–882) → `compose.test.ts`. Shared helpers (21–87) go to a small kit file (< 400) or are duplicated where trivial.
- [ ] **6.** Pins: remove `wire.ts` + `wire.test.ts` entries (paths gone — the stale-pin check forces this); ceiling → 8.
- [ ] **7.** `npm run check` green; PR `refactor(cli): wire.ts becomes the cli/wire/ module; compose.ts is the sole adapter importer`. **MERGE GATE.**

---

### Task 3 (PR 4): Split release — branch `feat/split-release`

**Files:** `src/cli/commands/release.ts` (705), `release.test.ts` (615, under cap — splits only to follow its code).

- [ ] **1.** Create `src/cli/commands/release/`: `version.ts` — `VERSION_SYNC_FILES`, `parseVersion`, `changelogHasVersionBlock`, `packageJsonVersion`, `ReadmeBadgeResult`, `updateReadmeBadge`, `npmSwallowedFlags` (113–199); `resume.ts` — `STAGE`, `Stage`, `PrState`, `ResumeState`, `resolveResumeStage` (201–257); `steps.ts` — shell wrappers + idempotent mutators + checks poll (264–500); `index.ts` — `ReleaseCommandOptions`, `ReleaseDeps`, `defaultDeps`, `releaseCommand()` (37–107, 503–705) re-exporting the pure symbols tests use. Update `main.ts`'s import.
- [ ] **2.** Tests: pure-function blocks (29–91) → `version.test.ts`/`resume.test.ts` beside their modules; the orchestration suite with `makeExecCommand` (92–615) stays as the command's test.
- [ ] **3.** Pins: remove `release.ts`; ceiling → 7. `npm run check` green; PR `refactor(cli): split release command into version/resume/steps modules`. **MERGE GATE.**

---

### Task 4 (PR 5): Split the CDP provider — branch `feat/split-provider`

**Files:** `src/adapters/browser/cdp-chrome/provider.ts` (582), `provider.test.ts` (877).

- [ ] **1.** New `handles/` subfolder (matches existing `ownership/`, `discovery/` pattern): `page_handle.ts` — `CdpChromePageHandle`, `withDeadline`, `toAbortError` (499–582); `browser_handle.ts` — `CdpChromeBrowserHandle` (416–496); plus its `index.ts`. `provider.ts` keeps types/reachability/`decideChromeAction`/deps/`CdpChromeProvider`/`raceWithTimeout` (~360). Family `index.ts` exports unchanged.
- [ ] **2.** Tests: the PageHandle deadline suite (blocks at 226–345 per the block map) → `handles/page_handle.test.ts` with the minimal fakes it needs; `provider.test.ts` drops to ≤ 800.
- [ ] **3.** Pins: remove `provider.ts` + `provider.test.ts`; ceiling → 5. `npm run check` green; PR `refactor(browser): extract cdp-chrome page/browser handles`. **MERGE GATE.**

---

### Task 5 (PR 6): Five remaining files — branch `feat/split-small-files`

Each is one cohesive extraction; all in one PR.

- [ ] **1. serve** (513): `src/cli/commands/serve/` folder — `start.ts` (`runServeStartParent`, `runServeStartChild`, 194–367), `lifecycle.ts` (`waitUntilDead`, `killAndConfirmDead`, `runServeStop`, 369–429), `status.ts` (`runServeStatus`, `formatDuration`, 431–498), `index.ts` (constants incl. `LEGACY_PLIST_REGEX`, `migrationCleanupBlock`, types, `ServeDeps`, `defaultServeDeps`, `serveCommand` dispatch). Update `main.ts` and `autostart.ts` imports; `serve.test.ts` (375) moves alongside with import updates.
- [ ] **2. launcher** (447): extract `session_clear.ts` — `SESSION_CLEAR_*` constants, `SessionClearFsDeps`, `SessionClearResult`, `clearSessionState` (146–183 constants + 207–287); its tests move from `launcher.test.ts` to `session_clear.test.ts`. Family `index.ts` exports unchanged.
- [ ] **3. aggregate** (439): extract `config_checks.ts` — `profileParsesCheck`, `filterParsesCheck`, `emptyLanesCheck` (84–263) with the shared resolver helpers they use; `aggregate.ts` keeps env/claude/daemon checks, `coreChecks`, `runChecks`, `worstStatus`. Matching test blocks move to `config_checks.test.ts`.
- [ ] **4. source** (427): extract `gates.ts` — the per-job 4-gate chain (269–338) as an exported function with its counters; `source.ts` keeps the stage factory and lane loop. Gate-specific test blocks may move to `gates.test.ts` (optional — `source.test.ts` is under cap).
- [ ] **5. rank** (407): extract `axes.ts` — `clamp`, `computeSkills`, `computeTitle`, `computeSeniority`, `computeLocation`, `computeYoe`, `softFailPenalty` (173–346); `rank.ts` keeps schemas, `excitementFor`, `scoreJob`, `rank`. Axis unit-test blocks move to `axes.test.ts`. The v0-parity replay test must stay byte-green.
- [ ] **6.** Pins: remove `serve.ts`, `launcher.ts`, `aggregate.ts`, `source.ts`, `rank.ts` — **PINS is now empty**; ceiling → 0. `npm run check` green; PR `refactor: split the five remaining over-cap files`. **MERGE GATE.**

---

### Task 6 (PR 7): Delete the pin machinery — branch `feat/remove-filesize-pins`

- [ ] **1.** `test/invariants/filesize.test.ts`: delete the `PINS` map, the ceiling assertion, the pin branches in the first test, and the entire stale-paths test; the gate becomes cap-only (~55 lines). Update its header comment.
- [ ] **2.** `.claude/agents/executor.md`: in the file-size bullet, replace the pin sentences with: `The pin list is gone — every file is simply under its cap; a new file over the cap fails \`npm run check\` outright.`
- [ ] **3.** Spec: append to `docs/superpowers/specs/2026-07-28-file-size-caps-design.md` a final line: `**Status (completed): all offenders split; the pin machinery was removed in the final PR.**`
- [ ] **4.** `npm run check` green; PR `test(invariants): retire the file-size pin list — caps only`. Done.

---

## Self-review notes (already applied)

- Covers all 12 pinned files and the spec's full sequencing including the final pin deletion; the wire depcruise change and same-PR doc updates are explicit (spec §wire.ts split).
- Line ranges are from `main@bf43647` recon (2026-07-28); implementers must treat symbol names as authoritative when line numbers have drifted, and STOP if a named symbol is missing.
- Deliberately delegated to the executor agent: exact subfolder shapes (two-pair rule) and the url_runner state-object field list — the seam is locked, the plumbing is placement.
- Task 1 is the risk peak (fresh throttle guard); its no-test-edits red flag and pass-count floor are the guardrails.
