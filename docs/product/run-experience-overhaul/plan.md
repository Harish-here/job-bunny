# Plan — Run Experience Overhaul

Frozen task briefs for `sdd-task-loop`. Derived from `blueprint.md` §8, amended by the R6
validation recorded in §0 below.

**Design is frozen.** Briefs carry decisions, not options. An implementer who finds a brief
under-specified stops and asks — it does not redesign.

| Input | Path |
|---|---|
| Spec | `docs/product/run-experience-overhaul/spec.md` |
| Design dossier | `docs/product/run-experience-overhaul/ux-notes.md` |
| Mockup | `docs/product/run-experience-overhaul/mockup.html` |
| Blueprint | `docs/product/run-experience-overhaul/blueprint.md` |

---

## 0. Validation finding — R6's class list was closed around the wrong center

Run before freezing, against `~/.jobbunny/profiles/harish/data/jobbunny.db` (read-only).
Corpus: **13 runs, 2026-08-06 → 2026-08-10, 4 failures.**

| Observed failure class | Count | In blueprint's R6 five? |
|---|---|---|
| `farm` stalled — no `beat()` within 360000ms | 2 | **No — absent** |
| `farm` total outage — all lanes failed | 1 | Only by inference as class (i) |
| `crashed`, `failure_json` NULL **and** `result_json` NULL | 1 | **No** |

Across the entire `run_events` table: **0** breaker/throttle mentions, **0** Chrome mentions,
**0** login/auth mentions.

**Honest caveat:** 4 failures over 4 days is not a distribution. Zero occurrences means *rare*,
not *impossible* — the breaker and Chrome-launch paths are live code. The conclusion is not
"delete those classes"; it is that the set was closed around the wrong center and must not be
frozen at five.

### Three amendments this forces

- **A4 — class (vi) `stall` is mandatory.** It is 50% of observed failures and the class where a
  diagnosis earns the most: "farm stopped reporting progress for 6 minutes" is actionable where
  the raw error string is not. Brief 14 implements it as a first-class member, not an add-on.
- **A5 — the diagnosis engine is a registry, not a frozen five.** A new class must cost one table
  entry plus one test, never a refactor. This is a structural requirement on brief 14, checkable
  by review.
- **A6 — R10 returns to scope.** The blueprint cut it partially, reasoning "no reachable backend
  signal produces it." That reasoning is disproven: run id 1 is `status='crashed'` with both
  `failure_json` and `result_json` NULL — a real, renderable telemetry-missing row sitting in the
  DB now. `'unrecorded'` is a **reachable** state, and its tests use a real-shaped fixture rather
  than a synthetic one.

---

## 1. Phase split — this plan does NOT run as one unattended loop

Briefs 1–7 touch `ports/`, `adapters/`, `pipeline/runner/`, and a schema migration. CLAUDE.md's
stability principle says changes there are reviewed for blast radius and **never shipped on unit
tests alone**. Briefs 8–26 are read-side SPA work gated by `ui:check` + `ui:build` + `ui:e2e`.

| Phase | Briefs | Mode | Gate |
|---|---|---|---|
| **P1 — backend** | 1–7 | **Attended.** Review wave + runtime verification before P2 starts. | `npm run check`, then the `verify` skill: `JOBBUNNY_HOME=$PWD node src/cli/main.ts run --profile rajni --dry-run` |
| **P2 — frontend** | 8–26 | Unattended-safe. | `npm run check`, `npm run ui:check`, `npm run ui:build`, `npm run ui:e2e` |

**P2 must not start until P1's migration is verified against a real DB copy.** A v6→v7 migration
landing on autopilot is exactly the failure mode the stability principle exists to prevent.

Backup before first migration run:
`cp ~/.jobbunny/profiles/harish/data/jobbunny.db ~/jobbunny-v6-backup.db`

---

## 2. Briefs — Phase 1 (backend, attended)

Every brief: colocated test pair required, 400-line impl cap, 800-line test cap, two-pair rule
applies in `src/`.

### B1 — `RunProgress` port surface
- **Files:** `src/ports/run_store.ts`
- **Do:** add the `RunProgress` interface; extend `RunStoreWriter` with `recordProgress()`; add
  `progress: RunProgress | null` to `RunSummary`. Shape verbatim from blueprint §3.
- **Constraint:** the record shape must accommodate within-stage counters (`current`/`total`)
  later **with no further schema change** — this is a user-level acceptance condition (spec AC5),
  not a preference. Review the shape against that before writing brief 2.
- **Done:** file typechecks; implementers now show a missing-method error (expected; B4 fixes).
- **Tier:** smart. **Review: yes** — port change, blast radius.

### B2 — v6 → v7 migration
- **Files:** `src/adapters/db/sqlite/store/migrations.ts` (+ existing test)
- **Do:** append the `run_progress` migration (blueprint §3.1 SQL verbatim); bump
  `LATEST_SCHEMA_VERSION` 6 → 7. Confirmed: current value is `6` at line 16.
- **Done:** test asserts a fresh DB lands at `user_version = 7` and `run_progress` exists; an
  existing v6 DB migrates without data loss.
- **Tier:** smart. **Review: yes** — schema migration, irreversible on real data.

### B3 — progress row mapping
- **Files:** `src/adapters/db/sqlite/runs/progress.ts` + `progress.test.ts` (both new)
- **Do:** `UPSERT_PROGRESS_SQL`, `progressRowValues()`, `mapProgressRow()`.
- **Done:** tests cover upsert-on-conflict and null-row mapping.
- **Tier:** fast. Review: no.

### B4 — store wiring
- **Files:** `src/adapters/db/sqlite/runs/store.ts` + test
- **Do:** implement `recordProgress()` **fail-soft, mirroring `heartbeat()`**; extend
  `listRuns`/`getRun` with `LEFT JOIN run_progress`; wire `mapProgressRow`.
- **Done:** `SqliteRunStore` satisfies `RunStore`; a throw inside the prepared statement is caught
  and warned, never propagated (explicit unit test).
- **Tier:** smart. **Review: yes** — adapter, fail-soft contract.

### B5 — runner emits progress
- **Files:** `src/pipeline/runner/run.ts` + test
- **Do:** add the `recordProgress` call beside `heartbeat` (blueprint §3.3 verbatim).
- **Constraint:** this is the frozen 10-stage runner. Add a call; change nothing else. Stage order
  and count are untouchable.
- **Done:** fault-injection test — a **throwing** `recordProgress` stub still yields
  `outcome: 'passed'` (spec AC6).
- **Tier:** smart. **Review: yes** — `pipeline/runner/`, highest blast radius in the plan.

### B6 — soft-error grouping (R9, promoted to Must per A1)
- **Files:** `src/app/features/runs/soft_errors.ts` + test (both new)
- **Do:** `groupSoftErrors()` — read-side only over existing `run_events` warn rows. **No
  write-side instrumentation.**
- **Real data to test against** (from the validation corpus — use as fixture shapes):
  `linkedin lane: page identity loss` ×44 · `linkedin lane: url failed` ×13 ·
  `board fetch failed` ×8 · `harvest: harvested 0 cards` ×6 · `stage attempt failed` ×3
- **Done:** tests cover empty input, single group, multi-group sort-by-count, and a
  malformed/missing `data` field degrading to an `'unknown'` bucket rather than throwing.
- **Tier:** fast. Review: no.

### B7 — soft-errors endpoint
- **Files:** `src/app/features/runs/routes.ts` + test; `src/app/features/runs/index.ts`
- **Do:** `GET .../runs/:id/soft-errors` with `SOFT_ERROR_SCAN_LIMIT = 2000`; export
  `GetSoftErrorsResponse`.
- **Constraint:** read-only. The board's write surface is structurally bounded — `jobs` and the
  runs tables stay pipeline/runner-only.
- **Done:** route test hits the endpoint against a seeded DB; `makeRunsRoutes` includes the new
  `RouteDef`.
- **Tier:** fast. Review: no.

> **P1 GATE — do not proceed to P2 until all four hold:**
> 1. `npm run check` green on all 3 OS in CI.
> 2. Migration verified on a **copy** of the real 237MB DB — v6 → v7, no data loss.
> 3. `verify` skill: a real run against `rajni` writes `run_progress` rows for all 10 stages.
> 4. Fault injection confirmed: a failing run store still yields a passing run.

---

## 3. Briefs — Phase 2 (frontend, unattended-safe)

### B8–B10 — data layer
- **B8** `ui/src/lib/api/types.ts` — re-export `GetSoftErrorsResponse` / `SoftErrorGroup` /
  `SoftErrorSummary`. Type-only (`verbatimModuleSyntax`). **fast**
- **B9** `ui/src/features/runs/softErrors.api.ts` (new) — `getSoftErrors(profile, id)`, matching
  `runs.api.ts`'s `getJson`/`profileBase` idiom exactly. **fast**
- **B10** `ui/src/features/runs/runs.queries.ts` + `useRunsData.ts` — `softErrorsKeys`/
  `softErrorsQuery`/`useSoftErrors`, following `runQuery`/`useRun` (`enabled: id > 0`). **fast**

### B11 — kill the regex stage guess (R3's payoff)
- **Files:** `ui/src/features/runs/runProgress.ts` + test
- **Do:** **delete** `STAGE_PREFIX` and `parseStageProgress`; replace with
  `stageProgressFrom(run: RunSummary): RunProgress | null` reading `run.progress`. Keep
  `heartbeatFreshness` unchanged.
- **Done:** `grep -rn 'STAGE_PREFIX\|/\^(\[a-z\]+):/' ui/src` returns **nothing** (spec AC4,
  literally checkable).
- **Tier:** smart. Review: no.

### B12 — funnel math
- **Files:** `ui/src/features/runs/runResult.ts` + test
- **Do:** extend `FunnelStage` with `elapsedMs` and `attempts` (present in `RunResultSchema`, not
  carried through the UI type); add `getBiggestDrop()` and `computeRetention()` — the latter
  **excludes `reconcile` and `farm` by name**.
- **Done:** tests for biggest-drop tie-breaking and retention-excludes-farm-and-reconcile.
- **Tier:** fast.

### B13 — outcome classification
- **Files:** `ui/src/features/runs/runOutcome.ts` + test (both new)
- **Do:** `classifyOutcome(run, softErrors): OutcomeKind` where `OutcomeKind = 'produced' |
  'empty' | 'degraded' | 'failed' | 'crashed' | 'running' | 'unrecorded'`. Health gate exactly as
  ux-notes §1 states it.
- **Amended by A6:** `'unrecorded'` is **reachable**, not dead code — `status='crashed'` with
  `failure_json` and `result_json` both NULL. Test it as a real case.
- **Done:** table-driven test, one case per kind, including the empty-vs-degraded boundary
  (spec AC3: two zero-yield runs, one healthy one not, must classify differently).
- **Tier:** smart. **Review: yes** — this is the design's central mechanism.

### B14 — failure diagnosis ⚠️ **amended by A4 + A5**
- **Files:** `ui/src/features/runs/runDiagnosis.ts` + test (both new)
- **Do:** `classifyFailure(run, softErrors): DiagnosisVerdict` as a **registry** — an ordered array
  of `{ kind, matches(run, softErrors), title, nextAction }` entries, iterated in order, first
  match wins. Adding a class must cost one array entry plus one test.
- **Classes, ordered by observed frequency, not by the blueprint's original listing:**

  | # | Class | Evidence in corpus | Detection |
  |---|---|---|---|
  | vi | **`stall`** | **2 of 4 failures** | `failure_json.error` matches `stalled: no beat()`; surface the stage and the timeout |
  | — | **`total-outage`** | 1 of 4 | `error` matches `total outage`; this is the shape CLAUDE.md says looks like an expired login |
  | i | `expired-login` | 0 direct markers | Best-effort only; must **not** outrank `total-outage` |
  | iv | `zero-yield-healthy` | — | Delegates to B13's health gate |
  | ii | `breaker-open` | **0 occurrences** | Keep — live code path, merely rare |
  | v | `chrome-not-found` | **0 occurrences** | Keep — live code path, merely rare |
  | iii | `daemon-down` | n/a | **Excluded here** — never produces a run row (A3); lives in B24–B26 |

- **Done:** one test per class, plus one asserting an unmatched failure falls through to
  `{ kind: 'fallback', rawError, lastCheckpoint }` **with no invented `kind`** (spec AC11).
  Plus a registry test: adding a stub entry requires no signature change.
- **Tier:** smart. **Review: yes** — amended against real data; the review checks the amendment
  landed, not just that tests pass.

### B15–B19 — components (leaves first)
- **B15** `ui/src/index.css` — `--amber`/`--amber-foreground` + `--color-amber`, following the
  existing `--success`/`--destructive` pattern. **Done:** no amber hex literal outside this file. **fast**
- **B16** `detail/StageRail.tsx` (new) — 10 segments, 3/3/4 grouping, `done`/`current`/`pending`/
  `failed` only (**no `skipped`**). `<ol>`/`<button>` a11y in `variant="detail"`; `role="img"` in
  `variant="strip"`. **Done:** a11y test asserts `aria-current="step"` and one `aria-label` per
  segment in ux-notes §4's exact format. **smart**
- **B17** `detail/FunnelTable.tsx` (new, extracted from `RunDetailView.tsx`) — retention bar via
  Tailwind background-width (**zero new deps — no charting library**); `farm`'s
  outward-bar-with-info-marker; `reconcile`'s `n/a · state-sync only`; `not reached` rows past a
  failure. **Done:** test covers all three special cases plus the ordinary in→out case (AC13).
  **Never renders a literal `0` for farm.** **smart**
- **B18** `detail/DiagnosisPanel.tsx` (new) — renders per `DiagnosisVerdict`; **exactly one**
  primary action; calm treatment (no button) for healthy-empty. **Done:** test asserts one primary
  per non-calm verdict, zero for calm (AC10, C8). **smart**
- **B19** `detail/EvidenceSection.tsx` (new) — soft-error summary line + existing `EventsList`
  behind a disclosure (move `EventsList` from `RunDetailView.tsx` unchanged). **Done:** disclosure
  closed by default; trigger-label count matches `SoftErrorSummary.total` (AC14). **fast**

### B20 — detail composition
- **Files:** `ui/src/features/runs/RunDetailView.tsx` (rewritten) + test
- **Do:** compose B16–B19 into the fixed 5-panel order (blueprint §6); `kind==='unrecorded'`
  short-circuit render — **now a live path per A6**, showing no rail, no funnel, no events.
  The absence is the disclosure.
- **Done:** panel order asserted by DOM position; failing/crashed/produced/empty/**unrecorded**
  fixtures each render the correct panel set (AC12).
- **Tier:** smart. **Review: yes** — file-size cap risk (400 lines); split if it exceeds.

### B21 — the run list
- **Files:** `ui/src/features/runs/RunsList.tsx` (rewritten) + test
- **Do:** 7-way outcome row via `runOutcome.ts`; **weight-not-hue** (left border + tint only on
  the urgent three); redundant text channel on **every** row; `farm`-safe subline.
- **Done:** test renders all 7 kinds and asserts (a) exactly `degraded`/`failed`/`crashed` carry a
  left-border class, and (b) **the greyscale test** — every row's accessible text alone, ignoring
  color and icon classes, distinguishes it from every other row (AC3, ux-notes §11).
- **Tier:** smart. **Review: yes** — (b) is the design's insurance against its own unsourced
  hypothesis. If it is weakened, the design loses its fallback.

### B22–B23 — live view
- **B22** `LiveRunHeader.tsx` (rewritten) — strip layout, reads `RunSummary.progress` directly
  (**no own events poll** — R12), alive/stalled/disconnected chip with stalled ≠ disconnected.
  **Done:** test asserts no `useRunEvents` call remains (grep-checkable) and the three liveness
  states render distinct text+icon pairs (AC8, AC16). **smart**
- **B23** `RunsPage.tsx` (edited) — wire the cheaper poll; freshness chip from `dataUpdatedAt`
  (R11). **Done:** existing tests pass with updated fixtures. **fast**

### B24–B26 — sidebar / run control (R5 + A3's class iii)
- **B24** `runcontrol/runState.ts` — add `'daemon-down'`/`'daemon-unknown'` to `RunControlState`;
  check `DaemonStatus.state` when an intent is `pending`, **ahead of** the 10-minute `expired`
  fallback (kept as defense-in-depth); decouple the persistent status line from `DONE_WINDOW_MS`
  (C15). **Done:** test asserts a pending intent with `daemon.state !== 'running'` classifies
  within one tick — **no 10-minute wait** (AC9). **smart, review: yes**
- **B25** `runcontrol/useRunControl.ts` — consume `daemonQuery()` from `../wizard/wizard.queries`
  (**reuse, do not duplicate** — verified to exist at `wizard.queries.ts:25`); feed
  `pickRunControlState`. **Done:** new test covers the daemon-down branch end-to-end. **smart**
- **B26** `runcontrol/RunNowButton.tsx` — render `daemon-down` (destructive outline, copy-command
  button, `[Keep queued]`/`[Cancel]`) and `daemon-unknown` (amber outline) per S8; persistent
  last-run status line. **Done:** test asserts the clipboard text is exactly
  `jobbunny serve start`. **smart**

---

## 4. Standing constraints — apply to every brief

- **No new runtime dependency.** Deps stay at `@notionhq/client`, `playwright`, `zod`, `dotenv`.
  A charting library is explicitly **not** pre-approved. Needing one is a stop-and-ask.
- **File caps:** 400 impl / 800 test, enforced over `src/`, `test/`, `ui/src/`, `ui/e2e/`.
- **Colocated tests** — every file pairs with `foo.test.ts`.
- **Layer boundaries** are machine-enforced by `npm run boundaries`. `ui/` may import
  `src/core/**` only for **dependency-free** modules — nothing in this plan should need it.
- **The 10-stage pipeline and its order are frozen.** B5 adds a call; it changes nothing else.
- **No abort-in-flight control** (R16, Won't). Cancel of a still-`pending` intent exists and stays.

## 5. Open risk carried into implementation

**The corpus is 4 days and 4 failures.** A4's reordering reflects *observed* frequency, which is
better than the blueprint's assumed frequency but still thin. A5 (registry structure) is the
mitigation: when the real distribution shifts, a class costs one entry. Do not let a reviewer
argue the registry into a switch statement on grounds of simplicity — the extensibility is the
point, and it was bought with evidence.
