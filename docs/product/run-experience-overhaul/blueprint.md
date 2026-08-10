# Blueprint — Run Experience Overhaul

Slug: `run-experience-overhaul` · Author: product-ui · 2026-08-10
Spec: `docs/product/run-experience-overhaul/spec.md` (authoritative)
UX: `docs/product/run-experience-overhaul/ux-notes.md` + `mockup.html` (frozen design — this
document plans it, it does not redesign it)
Scope executed here: **R1–R9 (Must)**, R10–R12 (Should, scoped per findings below), R19 (verdict:
**cut** — see §4).

**Feasibility verdict (per spec's Four-Risks scorecard, "product-ui confirms"): CONFIRMED, with
three named exceptions carried as explicit divergences, not silent redesigns:**
R19 is cut (disproportionate new scope for a conditional Should); R10 is descoped to what the
current fail-soft write contract can actually produce (a real architectural ceiling, not a UI
choice); R6 class (i) is a best-effort heuristic the pipeline's own code deliberately declines to
assert with certainty — which is exactly why R6 ships a mandatory raw fallback. Everything else in
R1–R9 is directly buildable from data that already exists, and R3's schema-shape review (AC5) is
satisfied by §3 below before any line of it is called done.

---

## 0. The three findings that reshape the brief

The parent brief asked three things to be checked hands-on. All three changed the shape of the
plan, for the better in two cases.

1. **R3's progress record does not exist yet — designed fresh in §3.** `runProgress.ts:17-41`
   (`ui/src/features/runs/runProgress.ts`) confirms the regex-over-log-prefix guess exactly as
   described. `src/pipeline/runner/guard.ts:87-96` confirms `beat()`/`armStall` only resets a
   stall timer and emits nothing. A new `run_progress` table is designed below, sized so within-
   stage counters (R17, later) need zero further migration.
2. **R19 is cut.** `jobs` (migrations.ts:20-53) carries no run-attribution column, and
   `date_found`/`synced_at` are both overwritten on every re-sync
   (`store.ts:23-34`'s `UPSERT_SQL`), so neither can serve as a "which run produced this row" proxy
   once a job persists across runs. A precise answer IS reconstructable — the `sync` stage's own
   checkpoint payload (`checkpoints` table, `stage='sync'`) holds exactly the JD records that
   survived the "already on board" drop, i.e. the new ones — but reaching it requires a new
   `BoardStore`/`ports/board.ts` method against a table the board has never read, plus a new UI
   capability (filtering the job list by an explicit id set) that does not exist today. That is
   disproportionate scope for a conditional Should sitting outside the Must slice. **Cut. Nothing
   else depends on it** (per the spec's own conditional). Documented as a future slice in §7.
3. **R9 is a bounded read-side query, not new instrumentation.** `run_events.data_json` already
   carries structured soft-error context (`source.ts:225-229`, `guard.ts:44-49`, and the LinkedIn
   breaker's own `ctx.logger.warn(..., { reopenAt, tripCount })` at `lane.ts:154-158`) via
   `RunStoreLogger` (`src/ops/observability/log/loggers.ts:106-179`), which already flushes every
   `warn`/`error` call into `run_events`. No new write-side work. §5 designs the bounded grouping
   query.

A fourth, unplanned finding materially cheapens R5: **`GET /api/daemon` already exists**
(`src/app/features/daemon/routes.ts`, wired to `readBoardDaemonStatus`,
`src/cli/wire/board_daemon.ts`) and is **already consumed** by the UI today —
`ui/src/features/wizard/wizard.api.ts:11-14`'s `getDaemonStatus()` and
`ui/src/features/wizard/wizard.queries.ts:25-29`'s `daemonQuery()`. R5 is wiring an existing,
already-typed query into `runcontrol`, not new backend work.

---

## 1. Stack Summary (change-to-existing — recon, not convention-authoring)

- **Frontend:** React 19, Vite 8, Tailwind v4, shadcn/Radix (`ui/src/components/ui/`: badge,
  button, card, dialog, form, input, popover, progress, select, separator, skeleton, switch, tabs,
  textarea — **no `table.tsx`**, confirmed by directory listing; the funnel is a raw `<table>` per
  `ux-notes.md §5`, matching `RunDetailView.tsx:31` today). Custom hash router
  (`ui/src/lib/router.ts`, no router lib). TanStack React Query v5
  (`ui/src/features/runs/runs.queries.ts`, `queryOptions` idiom). `sonner` toasts, lucide icons.
  Vitest + Playwright + testing-library.
- **Design tokens:** `ui/src/index.css` — `--primary:#7b5ea7`, `--muted:#f1ecf8`,
  `--destructive:#d64545`, `--success:#4caf6e`/`--success-strong:#26703f`, `--radius:1rem`
  (lines 30-93). **No `--amber`/warning token exists today** — the mockup's degraded/stalled amber
  (`#c98a2e`) is new and must be added as a token, not a hardcoded hex (§8, step 1).
- **Backend serving the SPA:** Node ESM/TS7, zod, `node:sqlite` (WAL). Layered
  `core/ports/adapters/pipeline/ops/app/cli`, mechanically enforced by
  `npm run boundaries` (dependency-cruiser). Board server is `src/app/` behind
  `src/ports/board.ts`'s `BoardSource`/`BoardStore`, wired once in `src/cli/wire/board.ts` +
  `board_daemon.ts`.
- **Run observability today:** `runs` + `run_events` tables (`migrations.ts:54-79`, schema v6),
  read via `RunStoreReader` (`ports/run_store.ts:67-83`), implemented by `SqliteRunStore`
  (`src/adapters/db/sqlite/runs/store.ts`, 381 lines — every writer method fail-soft,
  `warnOnce`-and-return pattern, e.g. `heartbeat()` at lines 193-202). Per-stage funnel metrics
  live only inside `result_json` (`RunResultSchema`, `src/ops/observability/run/result.ts:4-20`),
  narrowed defensively on the UI side (`ui/src/features/runs/runResult.ts`) since the port
  boundary keeps it `unknown`.
- **Two-pair rule — DOES apply in `src/`, does NOT apply in `ui/src/features/`.** Evidence:
  `src/app/features/runs/routes.ts:1-9`'s own header comment ("two-pair rule keeps this slice at
  exactly one impl file plus `index.ts`") and every `src/app/features/*/` folder has exactly an
  `index.ts` + one impl file. By contrast, **no folder under `ui/src/features/` has an `index.ts`
  at all**, and several already exceed 2 impl files today with no split (`wizard/` has 8,
  `shell/` has 9, `hub/` and `tracker/` have 4 each) — confirmed by directory listing. This is a
  real divergence from the literal CLAUDE.md wording; §8 treats it as a proportionality judgment
  call for `ui/`, not a mechanical gate, and is flagged again in NOTES.
- **File-size cap (400 impl / 800 test) DOES apply** across `src/`, `ui/src/`, `ui/e2e/` — every
  new/edited file below is sized with this in mind; two edits (`store.ts`, `routes.ts`) get a
  companion extraction file specifically to stay under it.

---

## 2. Component Mapping

| Mockup element | Real component / file | Props / variants | Existing or new + why |
|---|---|---|---|
| S1/S2 run row | `ui/src/features/runs/RunsList.tsx` | rewritten to render 7-way outcome treatment via new `runOutcome.ts` | **Existing, rewritten** — current file renders 4 plain columns only |
| S1/S2 outcome vocabulary logic | `ui/src/features/runs/runOutcome.ts` | pure fn: `RunSummary`/`RunDetail` + `SoftErrorSummary` → 1 of 7 kinds | **New** — no existing module computes this; `runResult.ts` only narrows opaque blobs |
| S2 live strip | `ui/src/features/runs/LiveRunHeader.tsx` (kept filename, rewritten) | strip layout, mounts only with data, offers not steals | **Existing, rewritten** — today it's a full-width header, not a strip, and it drives itself off regex progress |
| S4 stage rail (detail) | `ui/src/features/runs/detail/StageRail.tsx` | `stages`, `failedStage`, `currentStage?` | **New** — no rail exists today; `RunDetailView.tsx` has no stage visualization at all |
| S2 stage rail (strip, compact) | same `StageRail.tsx`, `variant="strip"` prop | `role="img"` non-interactive mode per ux-notes §4 a11y | New (shared with detail rail — one component, two render modes, keeps file count down) |
| S3–S6 funnel table | `ui/src/features/runs/detail/FunnelTable.tsx` | extracted+upgraded from `RunDetailView.tsx`'s inline `FunnelTable` | **Existing logic, extracted to new file** — today's version has no retention bar, no farm/reconcile special-casing |
| S4/S5/S6 diagnosis panel | `ui/src/features/runs/detail/DiagnosisPanel.tsx` | `verdict: RunDiagnosis` (from `runDiagnosis.ts`) | **New** — no diagnosis surface exists; today's failure UI is one red line (`RunDetailView.tsx:145-150`) |
| Diagnosis classification | `ui/src/features/runs/runDiagnosis.ts` | pure fn: `RunDetail` + `SoftErrorSummary` → 1 of 5 classes or fallback | **New** |
| S3–S6 evidence/disclosure | `ui/src/features/runs/detail/EvidenceSection.tsx` | wraps existing `EventsList` (extracted from `RunDetailView.tsx`) + soft-error summary | **Existing `EventsList`, reused; new wrapper** |
| S7 telemetry-missing | `runOutcome.ts`'s `'unrecorded'` kind + a guard in `RunDetailView.tsx` | renders only the dashed card, no rail/funnel/evidence | **New treatment, scoped down — see §7 divergence** |
| S8 sidebar Run Now block | `ui/src/features/runcontrol/RunNowButton.tsx` | new states: `daemon-down`, `daemon-unknown`; persistent status line | **Existing, extended** |
| S8 daemon health | `ui/src/features/wizard/wizard.queries.ts`'s `daemonQuery()` | reused as-is, imported into `runcontrol` | **Existing — already built, already typed, just unconsumed there** |
| Funnel raw `<table>` | Tailwind utility classes only | — | matches existing idiom (`RunDetailView.tsx:31`, no shadcn Table component in the repo) |
| Amber/warning tint | `ui/src/index.css` new `--amber`/`--amber-foreground` tokens + `--color-amber` Tailwind mapping | — | **New token pair** — none exists; §8 step 1 |

---

## 3. State & Data — R3's progress record (reviewed here, per AC5, before any code)

### 3.1 The record

New table, migration v6 → v7 (`src/adapters/db/sqlite/store/migrations.ts`):

```sql
CREATE TABLE run_progress (
  run_id           INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  stage            TEXT    NOT NULL,
  stage_index      INTEGER NOT NULL,   -- 1-based position within stage_total
  stage_total      INTEGER NOT NULL,   -- 10 today; recorded, never hardcoded downstream
  stage_started_at TEXT    NOT NULL,   -- ISO 8601 UTC
  updated_at       TEXT    NOT NULL,   -- last write (also a per-stage heartbeat, R4's "in stage Xs")
  item_current     INTEGER,            -- NULL today; R17 (Won't, this slice) fills this in later
  item_total       INTEGER             -- NULL today; same
);
```

**One row per run, upserted** on every stage transition (at most 10 writes per run — cheap, no
unbounded growth, no separate cleanup/TTL logic needed since it lives and dies with its `runs` row
via `ON DELETE CASCADE`). `item_current`/`item_total` are nullable from day one — R17's future work
is an `UPDATE` against existing columns, never a new migration. **This satisfies AC5.**

Port additions (`src/ports/run_store.ts`):

```ts
export interface RunProgress {
  stage: string;
  stageIndex: number;
  stageTotal: number;
  stageStartedAt: string;
  updatedAt: string;
  itemCurrent: number | null;
  itemTotal: number | null;
}
```

- `RunStoreWriter` gains `recordProgress(runId: number, progress: { stage: string; stageIndex: number; stageTotal: number; stageStartedAt: string }): void` — same fail-soft contract as every other writer method on this port (file header: "WRITER methods are fail-soft ... a failure warns once on stderr and never throws").
- `RunSummary` gains `progress: RunProgress | null` (not `RunDetail`-only — the **list** view needs it too, so a running row in `RunsList` can show `structure 5/10` without a second query; this is also what makes R12's poll consolidation possible, see §7).

### 3.2 Writer

New file `src/adapters/db/sqlite/runs/progress.ts` (+ colocated test) — pure SQL/row-mapping
helpers (upsert statement text, `mapProgressRow`), kept OUT of `store.ts` specifically because
`store.ts` is already 381/400 lines (mirrors why `board_daemon.ts` was split out of `board.ts` —
same file-size-cap reasoning, cited in that file's own header comment). This keeps
`src/adapters/db/sqlite/runs/` at 2 impl files (`store.ts` + `progress.ts`), still inside the
two-pair rule that folder already follows.

`store.ts`'s `recordProgress()` mirrors `heartbeat()`'s exact shape (lines 193-202):

```ts
recordProgress(runId: number, progress: ProgressInput): void {
  if (runId === -1) return;
  const db = this.open();
  if (!db) return;
  try {
    db.prepare(UPSERT_PROGRESS_SQL).run(...progressRowValues(runId, progress));
  } catch (err) {
    this.warnOnce(`SqliteRunStore.recordProgress failed: ${String(err)}`);
  }
}
```

`listRuns()`/`getRun()` are extended with a `LEFT JOIN run_progress ON run_progress.run_id = runs.id`
and `mapProgressRow` populates `RunSummary.progress` (null when no join row — an already-finished
run's stale progress row is harmless to keep and simply ignored by the UI when `status !== 'running'`).

### 3.3 Runner call site (R3's one pipeline-touching change)

`src/pipeline/runner/run.ts`, immediately beside the existing heartbeat call (line 60-62, inside the
per-stage loop, **before** `guardStage` runs):

```ts
if (ctx.runId !== undefined) {
  ctx.runStore.heartbeat(ctx.runId, new Date().toISOString());
  ctx.runStore.recordProgress(ctx.runId, {
    stage: stage.name,
    stageIndex: index + 1,
    stageTotal: stages.length,
    stageStartedAt: new Date().toISOString(),
  });
}
```

**Blast radius:** identical shape to the call directly above it, which already ships. Same
fail-soft contract (adapter never throws), same call frequency (once per stage, ≤10×/run), no new
control flow, no change to `resultStages`/`RunResult`/checkpoint writing. `runPipeline`'s own
"never throws" contract (file header) is preserved because `recordProgress` cannot throw by
construction (its adapter implementation catches internally, matching `heartbeat`).

**AC6 (fault-injection test), concretely:** extend `src/pipeline/runner/run.test.ts` (which already
has a "checkpoint-store write throw fails the run" test at line 358, proving the harness supports
this pattern) with a **new, contrasting** test: a stub `RunStoreWriter` whose `recordProgress`
throws must NOT fail or stall the run — assert the run still returns `outcome: 'passed'`. This
is the test that proves the asymmetry with checkpoints (spec's explicit design intent) is real, not
just asserted.

---

## 4. R19 verdict — cut (per spec Amendment A2's explicit condition)

**Feasibility check result: jobs are NOT attributable to a specific run via any column in the
`jobs` table** (`migrations.ts:20-40` — no `run_id`/`source_run_id` column exists), and the two
proxy columns that might seem to help do not: `date_found` and `synced_at` are BOTH overwritten on
every re-sync (`store.ts:23-34`, `UPSERT_SQL`'s `ON CONFLICT ... DO UPDATE SET ... date_found =
excluded.date_found, synced_at = excluded.synced_at`), so neither can distinguish "new to the
board this run" from "already existed, touched again this run."

A precise reconstruction IS possible — the `sync` stage's own checkpoint payload
(`checkpoints` table, `WHERE run_date=?, time_dir=?, stage='sync'`) holds exactly the JD records
that survived the "already on board" drop this run, because `run.ts:74-83` checkpoints every
stage's OUTPUT and `buildFunnel`'s `jobsOut` for `sync` is precisely that surviving set. But
reaching it requires: (a) a new `BoardStore`/`ports/board.ts` read method against `checkpoints`, a
table the board has never read before (today's split is deliberately `jobs`/`runs`/`run_events`
only); (b) parsing an opaque, pipeline-owned payload shape at the board layer; and (c) a **new UI
capability** — filtering the tracker/triage job list by an explicit id set — that does not exist
anywhere in the SPA today.

That is materially more scope than the "bounded read-side query over an already-exposed table"
bar R1/R8/R9 clear, and it sits outside the R1–R9 Must slice as a conditional Should. **Cut for
this slice, per the spec's own instruction** ("cut it if infeasible — nothing else depends on it").
Recorded as a follow-up candidate in §9, gated on either (a) a `jobs.source_run_id` column (a
write-side, pipeline-touching change requiring its own blast-radius review) or (b) the
checkpoint-join read path plus an id-set filter UI, sized as its own slice.

**Divergence from mockup:** the `[View them →]` link (S3 outcome header, callout C7) is **not
built**. The outcome header renders the yield sentence and high-match badge only.

---

## 5. R9 — soft-error aggregation (read-side, bounded)

New pure function `src/app/features/runs/soft_errors.ts` (+ colocated test) —
`groupSoftErrors(events: RunEventRow[]): SoftErrorSummary`, where:

```ts
export interface SoftErrorGroup {
  key: string;        // e.g. "source.linkedin" (scope) or "source.linkedin·acme corp" (scope+company)
  label: string;       // human label for the disclosure row, e.g. "source: empty job shell (linkedin)"
  count: number;
  sample: string;      // one representative event msg
}
export interface SoftErrorSummary {
  total: number;                 // warn+error count
  groups: SoftErrorGroup[];      // sorted by count desc
}
```

Grouping key: `data.scope` (from `withScope`'s nesting, e.g. `"farm.linkedin"`) combined with
`data.company` when present, else `data.lane`, else the bare scope. This is a pragmatic bucketing
over genuinely heterogeneous `data_json` shapes (confirmed by recon: the breaker-open warn carries
`{reopenAt, tripCount}`, per-URL warns carry `{lane, company, error}` roughly — there is no single
uniform schema), not a strict typed union — documented as such in the function's own doc comment.

This lives in `src/app/features/runs/` (not `ops/` or `core/`) specifically because
`app-only-ports-core` forbids `app/` from importing `ops/`, and the function's only import is the
`RunEventRow` type from `ports/run_store.ts` (already legal for `app/`). It is a **new, second impl
file** in `src/app/features/runs/` alongside `routes.ts` — still inside that folder's two-pair
budget (currently 1 impl file + `index.ts`).

New route, bounded scan (`src/app/features/runs/routes.ts`):

```
GET /api/profiles/:name/runs/:id/soft-errors
```

Implementation: `store.listRunEvents(id, { limit: SOFT_ERROR_SCAN_LIMIT })` (new constant,
`SOFT_ERROR_SCAN_LIMIT = 2000` — well above any realistic personal-scale run's warn+error volume,
same "hundreds not millions" scale reasoning `reconcile.ts`'s own doc comment uses for its DB-wide
timeout), filtered to `level in ('warn','error')`, passed through `groupSoftErrors`. This is the
"bounded query" the spec's backend-dependency table asks for (§ Backend dependencies, R9 row).

Response type `GetSoftErrorsResponse = SoftErrorSummary`, exported from
`src/app/features/runs/index.ts`, re-exported type-only from `ui/src/lib/api/types.ts` (matching
the existing pattern for every other run response type there).

UI side: `ui/src/features/runs/softErrors.api.ts` (new, mirrors `runs.api.ts`'s shape exactly) +
a `softErrorsQuery`/`softErrorsKeys` addition to `runs.queries.ts` + a `useSoftErrors` hook added to
`useRunsData.ts`.

---

## 6. Layout & Composition per screen

**S1/S2 (`RunsPage.tsx`, no route change — same `#/runs`):** unchanged grid
(`minmax(300px,360px) 1fr`, existing `grid-cols-[minmax(280px,360px)_1fr]` at `RunsPage.tsx:89`).
Live strip (`LiveRunHeader.tsx`, rewritten) mounts conditionally between the page header and the
two-pane grid — `runningRow && <LiveRunHeader .../>` already exists at `RunsPage.tsx:88`; the
change is what that component renders (strip, not a full header) and how it gets its data (the
polled `RunSummary.progress` field, no separate events poll — see §7's R12 note). Auto-select-
newest-on-load behavior (`RunsPage.tsx:58-62`) is unchanged — it is exactly what makes "the live
run is offered, not stolen" work: if the user already has an OLDER run selected when a live run
starts, `selectedId` is untouched (the effect only fires `if (selectedId === null)`), so the strip's
`[View]` affordance is the only way to jump to it.

**S3–S7 (`RunDetailView.tsx`):** fixed panel order enforced structurally — the component becomes a
thin composer:

```
outcome header (inline, unchanged position)
  → <DiagnosisPanel verdict={diagnosis} />          (absent when kind === 'produced')
  → <StageRail stages={...} failedStage={...} />    (absent when kind === 'unrecorded')
  → <FunnelTable stages={...} />                     (absent when kind === 'unrecorded')
  → <EvidenceSection summary={...} events={...} />   (absent when kind === 'unrecorded')
```

`kind === 'unrecorded'` short-circuits to the S7 dashed-card-only render (§7 divergence note on
scope) before reaching any of the four panels — matching ux-notes' "rendering empty versions of
those would itself be the lie R10 forbids."

**S8 (`RunNowButton.tsx` + `Sidebar.tsx`):** no layout change — same `runnow-block` slot at
`Sidebar.tsx:122`. New states render inside the existing container; the persistent status line
(§7) replaces the current `DONE_WINDOW_MS`-gated line, always present once any run has ever
completed.

**Responsive strategy:** none of this changes — the board is a local, single-viewport desktop tool
(127.0.0.1, no responsive breakpoints exist anywhere in the current shell); this slice does not
introduce any.

---

## 7. State & Data — full inventory

| Data | Source of truth | Existing / prerequisite |
|---|---|---|
| Run rows (status, timing, kind) | `runs` table via `RunStoreReader.listRuns/getRun` | Existing |
| Per-stage funnel (in/out/drops/elapsed) | `result_json` on `runs`, parsed via `runResult.ts` | Existing; `FunnelStage` type extended with `elapsedMs`/`attempts` (both already in `RunResultSchema`, just not surfaced to the UI narrowing type yet) |
| Failure (stage/error/lastCheckpoint) | `failure_json` on `runs` | Existing |
| Stage progress (R3) | new `run_progress` table, riding on `RunSummary.progress` | **New — §3** |
| Soft-error aggregate (R9) | new `GET .../runs/:id/soft-errors` | **New — §5, read-side only** |
| Daemon health (R5) | `GET /api/daemon` via `daemonQuery()` | **Existing, unconsumed by runcontrol until now** |
| Run intents (queued/expired/cancel) | `run-intents` routes, existing | Existing, unchanged |
| Yield → jobs link (R19) | — | **Cut — §4** |
| Telemetry-missing marker (R10) | — | **Descoped — see below** |

### R12 — poll consolidation, concretely

Three independent 2500ms interval definitions exist today: `useRunControl`'s `pollFlag` (runs +
intents + detail + events, all keyed off the same flag but as 4 separate queries),
`RunsPage.tsx:48-51`'s own `useRuns` poll, and `LiveRunHeader.tsx:31`'s own dedicated
`useRunEvents` poll (needed ONLY because stage position had to be derived from events). Once R3
lands, **stage position rides on the already-polled `RunSummary.progress` field** — `LiveRunHeader`
no longer needs its own events subscription at all for stage/position purposes (it still needs
events for nothing else — heartbeat freshness already comes from `RunSummary.heartbeatAt`, already
on the row it already has). This removes one of the three pollers outright. The remaining two
(`runs` list poll, `run-intents` poll) already share a query key across `RunsPage` and
`useRunControl` when both are mounted (TanStack Query dedupes identical `queryKey` + interval
subscribers to one network request), so the practical count drops from "3 uncoordinated interval
definitions, one of which is now provably unnecessary" to "2 coordinated, already-deduped polls."
Freshness chip (R11): render `Updated <formatElapsed(dataUpdatedAt)> ago` from the runs-list
query's own `dataUpdatedAt`, plus a disconnected state when `isError` — no new data source needed,
this is a `useRuns` return-value read, matching S9's `Live strip · Error (Disconnected)` tile.

### R10 — descoped to what the write contract can actually produce

**Finding:** `RunStoreWriter`'s degraded path (`ports/run_store.ts:44-46`: "Returns -1 when the
store is degraded (open failed)") means `startRun` failing produces **no row at all** — every
subsequent writer call on that `runId` (`-1`) early-returns
(`store.ts:194`: `if (runId === -1) return;`, repeated on every method). A run whose db "open"
failed leaves **zero trace** in the `runs` table — not a partial row, not a marker, nothing. The
mockup's S7 scenario (a real, selectable, timestamped row reading "Telemetry missing") requires a
row to exist; under the current contract, the one case Current-State-defect-#4 actually describes
(open failed) cannot produce one, by definition — you cannot write a "the db is unreachable" marker
into the db that is unreachable.

The only OTHER path that could look "unrecorded" — a row that starts, then goes fully silent for
the rest of the run (heartbeat/finishRun calls fail-soft after a real row exists) — already resolves
to the existing `crashed` derivation (stale-heartbeat rule, `store.ts`'s `deriveStatus`), which is
in fact a MORE honest signal than a generic "unrecorded" label would be.

**Scope decision:** R10 (Should) is **not built as a distinct 7th visual/row state** in this slice.
Building it honestly would require a new, durable, always-writable "run attempt" ledger independent
of the per-profile db's own health (mirroring how the daemon's pidfile already survives db
unavailability) — real, out-of-proportion new backend scope for a Should, and not something a UI
slice should fake by inventing a row that the backend cannot actually produce. Recorded as a
backend-slice candidate in §9. `runOutcome.ts` still defines the `'unrecorded'` kind (cheap, and
future-proofs the type) but there is currently no reachable input that produces it — its render
path (§6) exists and is tested with a synthetic fixture, but nothing in the live system emits it
yet. This is a **partial cut**, not a full one: the kind and its render exist; the backend signal
that would trigger it does not.

### R6 class-by-class detectability (verified per class, per spec's own risk flag)

| Class | Signal, verified | Confidence |
|---|---|---|
| (ii) breaker open | `run_events` warn row, exact message `'linkedin lane: throttle breaker is open — skipping this fire without launching a browser'`, `data: {reopenAt, tripCount}` (`lane.ts:154-158`) | **High** — unambiguous, structured |
| (iii) daemon down | `GET /api/daemon` `state !== 'running'`; **no run row exists for this class** (A3) — surfaces only in the sidebar block + live strip, never `RunDetailView` | **High** — direct read |
| (v) Chrome not found | `failure.error` containing `'no Chrome executable found'` (`launcher.ts:105-108`'s exact thrown message) | **High** — unambiguous substring |
| (iv) zero-yield-healthy | derived health gate (all 10 `result.stages` present, no `failure_json`, no breaker-open warn this run, soft-error count under a threshold) + biggest-drop stage from `FunnelStage.dropsByRule` | **High** — pure derivation over already-verified fields |
| (i) expired login | `failure.stage === 'source'` and `failure.error` matching the `'linkedin lane: all N attempted url(s) failed this run'` pattern (`evidence.ts:120-125`) | **Best-effort, explicitly imprecise** — see below |

**Class (i) divergence, named plainly:** `evidence.ts:44-51`'s own doc comment states the closest
available signal (`zero-cards`, i.e. the search-results DOM found nothing) is "NOT always an
expired session... a healthy session failed this guard because card title/company selectors had
drifted, not because of a logout wall" — the pipeline's own code **deliberately declines** to
assert "login expired" over this evidence, reporting distinct candidate causes instead of guessing
one. Building class (i) as a confident diagnosis would fabricate certainty the underlying system
does not have. **Resolution: implement it as a best-effort pattern match exactly as R6/R7 already
require** — "no invented diagnosis" is not violated because the match is transparent about what it
detected (the aggregate all-URLs-failed shape), and any run whose failure text doesn't match this
or the other four patterns falls through to the mandatory raw fallback (S6) rather than being
forced into a wrong bucket. This is the **exact scenario R6's fallback path exists for** — not a
blocker, a designed-for outcome. Not returned as `blocked` because the spec's own riskiest-
assumption section anticipates this precisely ("If real failures are mostly long-tail, R6 degrades
to R7... this is the assumption to validate first").

---

## 8. Implementation Steps

Dependency-ordered, one file of primary focus each, objectively checkable done-condition.

**Backend — R3 (progress record)**

1. `src/ports/run_store.ts` — add `RunProgress` interface; extend `RunStoreWriter` with
   `recordProgress()`; add `progress: RunProgress | null` to `RunSummary`.
   **Done:** file typechecks; `RunStore` implementers now show a missing-method error (expected,
   fixed by step 3).
2. `src/adapters/db/sqlite/store/migrations.ts` — append the v6→v7 `run_progress` migration (§3.1
   SQL verbatim); bump `LATEST_SCHEMA_VERSION` to `7`.
   **Done:** `migrations.test.ts` passes with a new assertion that a fresh db lands at
   `user_version = 7` and `run_progress` exists.
3. `src/adapters/db/sqlite/runs/progress.ts` (+ `progress.test.ts`) — `UPSERT_PROGRESS_SQL`,
   `progressRowValues()`, `mapProgressRow()`.
   **Done:** unit tests cover upsert-on-conflict and null-row mapping.
4. `src/adapters/db/sqlite/runs/store.ts` (+ `store.test.ts`) — implement `recordProgress()`
   (fail-soft, mirrors `heartbeat()`); extend `listRuns`/`getRun` SQL with the `LEFT JOIN
   run_progress`; wire `mapProgressRow`.
   **Done:** `SqliteRunStore` satisfies `RunStore` again; existing + new tests green; a thrown
   error inside the prepared statement is caught and warned, never propagated (unit test).
5. `src/pipeline/runner/run.ts` (+ `run.test.ts`) — add the `recordProgress` call beside
   `heartbeat` (§3.3 verbatim); add the fault-injection test (AC6).
   **Done:** `run.test.ts`'s new test passes — a throwing `recordProgress` stub still yields
   `outcome: 'passed'`.

**Backend — R9 (soft errors)**

6. `src/app/features/runs/soft_errors.ts` (+ `soft_errors.test.ts`) — `groupSoftErrors()`.
   **Done:** unit tests cover empty input, single group, multi-group sort-by-count, and a
   malformed/missing `data` field degrading to an `'unknown'` bucket rather than throwing.
7. `src/app/features/runs/routes.ts` (+ `routes.test.ts`) — add the `GET .../runs/:id/soft-errors`
   handler (`SOFT_ERROR_SCAN_LIMIT = 2000`); `src/app/features/runs/index.ts` — export
   `GetSoftErrorsResponse`.
   **Done:** route test hits the new endpoint against a seeded db and asserts grouped output;
   `makeRunsRoutes` return array includes the new `RouteDef`.

**Frontend — data layer**

8. `ui/src/lib/api/types.ts` — add `GetSoftErrorsResponse` (and `SoftErrorGroup`/`SoftErrorSummary`
   if exported separately from the backend feature's `index.ts`) to the re-export list.
   **Done:** typechecks; no runtime import (type-only, `verbatimModuleSyntax`).
9. `ui/src/features/runs/softErrors.api.ts` (new, mirrors `runs.api.ts`) — `getSoftErrors(profile,
   id)`.
   **Done:** matches `runs.api.ts`'s `getJson`/`profileBase` idiom exactly.
10. `ui/src/features/runs/runs.queries.ts` — add `softErrorsKeys`/`softErrorsQuery`;
    `ui/src/features/runs/useRunsData.ts` — add `useSoftErrors`.
    **Done:** follows `runQuery`/`useRun`'s existing pattern (`enabled: id > 0`).
11. `ui/src/features/runs/runProgress.ts` (+ test) — **delete** `STAGE_PREFIX`/`parseStageProgress`
    (the regex derivation); replace with a thin accessor `stageProgressFrom(run: RunSummary):
    RunProgress | null` reading `run.progress` directly. Keep `heartbeatFreshness` unchanged.
    **Done:** grepping `ui/src` for `STAGE_PREFIX` and `/^([a-z]+):/` returns nothing (**AC4**,
    literally checkable).
12. `ui/src/features/runs/runResult.ts` — extend `FunnelStage` with `elapsedMs: number` and
    `attempts: number` (already present in `RunResultSchema`, just not carried through the UI
    narrowing type); add `getBiggestDrop(stages: FunnelStage[]): { stage: string; rule: string;
    count: number } | null` and `computeRetention(stages)` (excludes `reconcile` and `farm` by
    name, per §7's confirmed special-casing).
    **Done:** unit tests for biggest-drop tie-breaking and retention-excludes-farm-and-reconcile.

**Frontend — pure classification logic**

13. `ui/src/features/runs/runOutcome.ts` (new, + test) — `classifyOutcome(run: RunSummary |
    RunDetail, softErrors: SoftErrorSummary | undefined): OutcomeKind` where `OutcomeKind =
    'produced' | 'empty' | 'degraded' | 'failed' | 'crashed' | 'running' | 'unrecorded'`. Implements
    the health gate exactly as ux-notes §1 states it: `status==='passed' && lastStage.jobsOut===0 &&
    result.stages.length===10 && !failure && no-breaker-open-warn && softErrorRate<threshold` →
    `'empty'`; same but gate fails → `'degraded'`. `'unrecorded'` is defined but currently
    unreachable per §7 — covered by a synthetic-fixture test only.
    **Done:** table-driven unit test, one case per kind, including the empty-vs-degraded gate
    boundary (AC3's literal scenario: two zero-yield runs, one healthy one not, must classify
    differently).
14. `ui/src/features/runs/runDiagnosis.ts` (new, + test) — `classifyFailure(run: RunDetail,
    softErrors: SoftErrorSummary): DiagnosisVerdict` implementing the 5-class table from §7
    (class iii excluded — it never reaches this function, per A3), falling back to
    `{ kind: 'fallback', rawError, lastCheckpoint }` when nothing matches.
    **Done:** one test per class (i, ii, iv, v) plus one asserting an unmatched failure falls
    through to `'fallback'` with no invented `kind` (**AC11**, literally checkable).

**Frontend — components (§2's mapping, dependency order: leaves first)**

15. `ui/src/index.css` — add `--amber`/`--amber-foreground` tokens (§1) + `--color-amber` Tailwind
    mapping, following the existing `--success`/`--destructive` pattern exactly (lines 30-93).
    **Done:** no new hex literal appears anywhere outside this file for the amber treatment.
16. `ui/src/features/runs/detail/StageRail.tsx` (new, + test) — 10 segments, 3/3/4 grouping,
    `done`/`current`/`pending`/`failed` states only (**no `skipped` state** — §9 divergence),
    `<ol>`/`<button>` a11y in `variant="detail"`, `role="img"` non-interactive in
    `variant="strip"`.
    **Done:** a11y test asserts `aria-current="step"` on the current segment and one
    `aria-label` per segment matching ux-notes §4's exact format.
17. `ui/src/features/runs/detail/FunnelTable.tsx` (new, + test, extracted+upgraded from
    `RunDetailView.tsx`) — retention bar (Tailwind background-width, zero new deps), farm's
    outward-bar-with-info-marker special case, reconcile's `n/a · state-sync only` special case,
    `not reached` rows for stages past a failure.
    **Done:** test covers all three special cases plus the ordinary in→out case (**AC13**).
18. `ui/src/features/runs/detail/DiagnosisPanel.tsx` (new, + test) — renders per
    `DiagnosisVerdict`, exactly one primary action, calm treatment (no button) for the healthy-
    empty case.
    **Done:** test asserts exactly one `btn-primary`-equivalent per non-calm verdict, zero for
    calm (**AC10, C8**).
19. `ui/src/features/runs/detail/EvidenceSection.tsx` (new, + test) — soft-error summary line +
    existing `EventsList` behind a disclosure (reuses `RunDetailView.tsx`'s current `EventsList`
    function, moved here unchanged).
    **Done:** disclosure closed by default, count in the trigger label matches
    `SoftErrorSummary.total` (**AC14**).
20. `ui/src/features/runs/RunDetailView.tsx` (rewritten, + test) — compose steps 16-19 into the
    fixed 5-panel order (§6); `kind==='unrecorded'` short-circuit render.
    **Done:** panel order asserted by DOM position in a test; failing/crashed/produced/empty
    fixtures each render the correct panel set (**AC12**).
21. `ui/src/features/runs/RunsList.tsx` (rewritten, + test) — 7-way outcome row using
    `runOutcome.ts`, weight-not-hue treatment (left border + tint only on urgent rows), redundant
    text channel on every row, `farm`-safe subline never showing a literal `0` for that stage.
    **Done:** a test renders all 7 kinds and asserts (a) exactly the urgent 3 (`degraded`/`failed`/
    `crashed`) have a left-border class, (b) every row's accessible text alone (ignoring color/
    icon classes) distinguishes it from every other row — the greyscale test from ux-notes §11
    (**AC3**).
22. `ui/src/features/runs/LiveRunHeader.tsx` (rewritten, + test) — strip layout, reads
    `RunSummary.progress` directly (no own events poll — R12), alive/stalled/disconnected chip
    (R11, stalled≠disconnected distinction).
    **Done:** test asserts no `useRunEvents` call remains in this file (grep-checkable) and the
    three liveness states render distinct text+icon pairs (**AC8, AC16**).
23. `ui/src/features/runs/RunsPage.tsx` (edited) — wire the (now cheaper) poll, freshness chip
    (R11).
    **Done:** freshness chip renders `dataUpdatedAt`-derived text; existing tests pass with
    updated fixtures.

**Frontend — sidebar / run control (R5, R15-Could)**

24. `ui/src/features/runcontrol/runState.ts` (edited, + test) — add `'daemon-down'` /
    `'daemon-unknown'` to `RunControlState`; precedence checks `DaemonStatus.state` when an
    intent is `pending`, ahead of the 10-minute `expired` fallback (kept as defense-in-depth, not
    the primary signal); **decouple the persistent status line from `DONE_WINDOW_MS`** — the last-
    finished run's outcome is always available for display (C15), independent of the primary
    button's own idle/queued/running state.
    **Done:** a test asserts a pending intent with `daemon.state !== 'running'` classifies as
    `daemon-down`/`daemon-unknown` within one tick — no 10-minute wait (**AC9**).
25. `ui/src/features/runcontrol/useRunControl.ts` (edited, + test) — consume `daemonQuery()` from
    `../wizard/wizard.queries` (reused, not duplicated); feed into `pickRunControlState`.
    **Done:** existing tests pass with a daemon-status fixture added; new test covers the
    daemon-down branch end-to-end.
26. `ui/src/features/runcontrol/RunNowButton.tsx` (edited, + test) — render `daemon-down`
    (destructive outline, `[Copy: jobbunny serve start]`, `[Keep queued]`/`[Cancel]`) and
    `daemon-unknown` (amber outline) states per S8; persistent last-run status line replacing the
    windowed one.
    **Done:** test renders both new states and asserts the copy-command button's clipboard text
    matches exactly `jobbunny serve start`.

---

## 9. Requirements Coverage

| # | Requirement | MoSCoW | Delivered by |
|---|---|---|---|
| R1 | Yield headline + high-match badge on every run row | **Must** | Steps 13, 21 (`runOutcome.ts`, `RunsList.tsx`) |
| R2 | 5(+2)-way visually distinct outcome vocabulary, weight-not-hue, redundant text | **Must** | Steps 13, 15, 21 (`runOutcome.ts`, tokens, `RunsList.tsx`) |
| R3 | First-class stage-progress record, no schema change needed for R17 later | **Must** | Steps 1–5 (§3 in full) |
| R4 | Live view: stage, position, time-in-stage, elapsed, alive/stalled | **Must** | Steps 11, 22 (`runProgress.ts`, `LiveRunHeader.tsx`) |
| R5 | Daemon health checked at queue time, surfaced in seconds | **Must** | Steps 24–26 (reusing existing `GET /api/daemon` + `daemonQuery()`) |
| R6 | 5-class diagnosis + next action, closed set, clean fallback | **Must** | Step 14 (`runDiagnosis.ts`) + Step 18 (`DiagnosisPanel.tsx`); class (iii) surfaces via Steps 24–26 per A3 |
| R7 | Raw failure surfacing, summary-first, full log on demand | **Must** | Steps 18–20 (`DiagnosisPanel.tsx` fallback path, `EvidenceSection.tsx`, panel order) |
| R8 | Funnel legible at a glance, `farm`'s `jobsIn:0` explicit, never a literal 0 | **Must** | Steps 12, 17 (`runResult.ts`, `FunnelTable.tsx`) |
| R9 | Soft errors aggregated per run, grouped by cause | **Must** (A1) | Steps 6, 7, 9, 10, 19 (backend + data layer + `EvidenceSection.tsx`) |
| R10 | Telemetry-missing disclosed, never rendered as a complete empty run | Should | **Partially cut** — kind + render path exist (Step 13, 20) but no reachable backend signal produces it; see §7 |
| R11 | Freshness indicator; poll failure distinct from idle | Should | Steps 22, 23 (stalled≠disconnected, freshness chip) |
| R12 | Three pollers consolidated to one coordinated source | Should | Step 22 (removes the dedicated events poll) + §7's poll-consolidation note |
| R13 | Recent-runs trend | Could | Not built this slice |
| R14 | Per-stage duration encoded visually | Could | Not built this slice; `StageRail.tsx` (step 16) is built with the `flex-1`→`flex-grow:<elapsedMs>` upgrade path left open, no markup change needed later |
| R15 | Deduped-intent toast | Could | Not built this slice |
| R19 | Yield → jobs link | Should, conditional | **Cut** — §4 |

---

## 10. Mockup Divergences (each justified against the feasibility gate)

1. **`[View them →]` link (R19) — not built.** §4. Achievable-with-disproportionate-work, cut per
   the spec's own explicit condition; nothing else depends on it.
2. **S7 "Telemetry missing" — kind defined, but not reachable from live data.** §7. This is a
   genuine architectural ceiling (fail-soft degrade-to-no-op cannot produce a row to render), not a
   UI simplification — flagged as a backend-slice candidate (§11), not silently dropped.
3. **Rail "skipped" (diagonal-stripe) segment state — not built.** The mockup's own annotation
   attributes this to "the LinkedIn breaker skips lanes" — but that skip happens to a **lane inside
   the `source` stage**, not to a whole pipeline **stage** in the frozen 10. No stage in
   `RunResult.stages` is ever legitimately "skipped" as a unit — a stage either completes (present
   in `stages[]`) or the run fails at it (absent, shown via `failure.stage`). Building a "skipped"
   segment would require inventing a signal that does not exist. `StageRail.tsx` ships with
   `done`/`current`/`pending`/`failed` only. The breaker-open information itself is NOT lost — it
   surfaces correctly via R6 class (ii)'s diagnosis panel, which is the design's own primary vehicle
   for exactly this fact.
4. **Class (i) "expired LinkedIn login" is a best-effort pattern match, not a certain diagnosis.**
   §7. Justified divergence: the underlying pipeline code deliberately declines to assert this
   cause with confidence over ambiguous evidence; R6's mandatory raw fallback exists precisely for
   this case and is exercised by it, not defeated by it.
5. **R10's status line decoupling from `DONE_WINDOW_MS`** (step 24) is a genuine behavior change
   beyond a pure port: today's sidebar status line disappears after 10 minutes; ux-notes' C15
   requires it to persist indefinitely (zero-click daily answer from any route). Named explicitly
   because it changes existing, tested behavior in `runState.ts`, not just adds to it.

---

## 11. Risks & Assumptions

- **R9's grouping key is a heuristic over heterogeneous `data_json` shapes**, not a typed schema —
  acceptable because the disclosure UI only needs a stable, sensible bucket + count + one sample,
  never a machine-consumed contract. If a future warn call site adds yet another shape, the
  grouping degrades gracefully to a broader bucket (scope alone), never throws.
- **R6 class (i)'s false-positive/false-negative rate is unvalidated against real failure history**
  in this pass (no live `harish`/`rajni` failure-run corpus was queried during this recon — the
  spec's own recommendation to "classify the failure rows already in the runs table before writing
  any diagnosis code" is validation work for whoever implements step 14, not something this
  blueprint can discharge in the abstract).
- **The two-pair rule's non-application to `ui/src/features/`** (§1) is treated here as an
  observed convention, not re-litigated — if a future repo-wide push tightens `ui/` to the same
  rule as `src/`, the `detail/` subfolder introduced in step 16-20 is already a head start on that
  direction, not a wrong bet.
- **`SOFT_ERROR_SCAN_LIMIT = 2000`** is a judgment call, not a measured ceiling — no real run's
  warn+error volume was inspected during this recon. If a genuinely pathological run exceeds it,
  the aggregate under-counts (never crashes, never mis-groups) — an acceptable fail-soft direction
  matching the rest of this port's posture.

---

## 12. Engineering Quality Gates

- **Determinism:** `runOutcome.ts`/`runDiagnosis.ts` are pure functions of `(RunSummary|RunDetail,
  SoftErrorSummary)` — same input, same classification, every time. No `Date.now()`/`Math.random()`
  inside either; `now` is threaded as an explicit parameter wherever elapsed-time math is needed
  (matching `runState.ts`'s existing `now: number` parameter idiom at line 38).
- **Fault tolerance:** the board's existing pane-scoped `ErrorRetry` (`RunsPage.tsx:21-38`) stays
  the error boundary for both list and detail panes — no new boundary needed since nothing here
  changes the query-error surface shape (new queries fail the same way existing ones do, `isError`
  + retry). User-visible failure state: pane-scoped "Couldn't load this run" / "Couldn't load
  runs", list stays usable (unchanged behavior, verified by existing tests at `RunsPage.test.tsx`).
- **Design-token sync:** zero hardcoded hex anywhere in new components — the one new color (amber)
  is added to `ui/src/index.css` first (step 15) and every subsequent component references
  `text-amber`/`border-amber`/`bg-amber/8` etc. via the Tailwind mapping, matching how
  `--destructive`/`--success` are already consumed.
- **Micro-optimizations:** `StageRail.tsx` and `FunnelTable.tsx` are pure presentational components
  over already-computed arrays (no per-render recomputation of retention/biggest-drop — those are
  computed once in `runResult.ts`'s helpers and passed down as props). `RunsList.tsx`'s outcome
  classification runs once per row per render; with realistically ≤100 rows (`runsQuery`'s existing
  `limit: 100`) this is not memoized — premature to add `useMemo` at this scale, matching the
  existing file's own lack of memoization for its current per-row formatting calls.
  Re-render trigger: the runs-list poll (R12) is the only interval-driven re-render source once
  `LiveRunHeader`'s dedicated events poll is removed (step 22) — one fewer re-render source than
  today.
- **Asynchronous UX:** the S9 skeleton/empty/error/success matrix maps 1:1 onto existing
  `RunsQuery.isPending`/`isError`/`data` states (`RunsPage.tsx`'s existing pattern, step 23 extends
  it, does not replace it). The diagnosis panel deliberately does **not** skeleton (ux-notes C13,
  step 18) — it renders only once `detailQuery.data` has arrived, same gating `RunDetailView`
  already uses (`detail` is `undefined` until the query resolves, `RunsPage.tsx:69-72`).

---

## Appendix — files touched, at a glance

**New (13):** `src/adapters/db/sqlite/runs/progress.ts`(+test),
`src/app/features/runs/soft_errors.ts`(+test), `ui/src/features/runs/softErrors.api.ts`,
`ui/src/features/runs/runOutcome.ts`(+test), `ui/src/features/runs/runDiagnosis.ts`(+test),
`ui/src/features/runs/detail/StageRail.tsx`(+test),
`ui/src/features/runs/detail/FunnelTable.tsx`(+test),
`ui/src/features/runs/detail/DiagnosisPanel.tsx`(+test),
`ui/src/features/runs/detail/EvidenceSection.tsx`(+test)

**Edited (13):** `src/ports/run_store.ts`, `src/adapters/db/sqlite/store/migrations.ts`(+test),
`src/adapters/db/sqlite/runs/store.ts`(+test), `src/pipeline/runner/run.ts`(+test),
`src/app/features/runs/routes.ts`(+test), `src/app/features/runs/index.ts`,
`ui/src/lib/api/types.ts`, `ui/src/features/runs/runs.queries.ts`,
`ui/src/features/runs/useRunsData.ts`, `ui/src/features/runs/runProgress.ts`(+test),
`ui/src/features/runs/runResult.ts`(+test), `ui/src/features/runs/RunDetailView.tsx`(+test),
`ui/src/features/runs/RunsList.tsx`(+test), `ui/src/features/runs/LiveRunHeader.tsx`(+test),
`ui/src/features/runs/RunsPage.tsx`, `ui/src/features/runcontrol/runState.ts`(+test),
`ui/src/features/runcontrol/useRunControl.ts`(+test),
`ui/src/features/runcontrol/RunNowButton.tsx`(+test), `ui/src/index.css`

No route change (`ui/src/lib/router.ts` untouched — `#/runs` upgraded in place, per spec Q5).
No new runtime dependency (raw `<table>`, Tailwind-only retention bars, no charting library).
