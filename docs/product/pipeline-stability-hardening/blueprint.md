# UI Blueprint — Pipeline Stability Hardening

Slug: `pipeline-stability-hardening` · Author: product-ui · 2026-08-13
Consumes: `spec.md` (frozen, 27 requirements / 21 AC), `ux-notes.md` + `mockup.html` (frozen, 55
`data-qa` ids), `blueprint-be.md` (frozen, authoritative server surface — every data claim below
cites a step or table from it, never invents around it).

**Scope reminder (binding):** the Telegram message shapes (T1–T6, `tg-icon-legend`) are backend
plaintext, not React components — out of scope here, planned in `blueprint-be.md` only. This
blueprint plans exactly four React surfaces: deferred entries in run history, the catch-up run
label (list + detail), the catch-up banner (variant 2b only — **no Stop button**), and the daemon
degraded state (global banner + Settings → Schedule status).

---

## 0. Stack Summary (evidence)

Change-to-existing; classification and stack are settled, no stack question.

- **Framework:** React 19, Vite 8, TypeScript strict (`ui/package.json:22`; `ui/vite.config.ts:10-11`;
  `ui/tsconfig.json:8-9`). Board SPA at `ui/`, built via `npm run ui:build` into `ui/dist/`, served by
  `jobbunny board`.
- **Styling:** Tailwind v4, CSS-variable config, no `tailwind.config.*`. Tokens declared
  `ui/src/index.css:64-149` (light `:root` 64-106, dark `.dark` 108-149); `--radius: 1rem` at
  `index.css:97` — matches ux-notes §3's radii table exactly (`rounded-lg` = 16px = the row/card
  default, `rounded-xl` = 22.4px). No spacing tokens declared; Tailwind's undeclared 4px grid is the
  scale, confirmed against `RunsList.tsx`/`LiveRunHeader.tsx`'s own literal utility usage
  (`gap-2`, `px-3`, `py-3`, `size-4`, etc.).
- **Routing:** hand-rolled hash router, `ui/src/lib/router.ts:3-69`. `ROUTES` is a fixed literal union
  (`triage`/`tracker`/`runs`/`analytics`/`setup`/`onboarding`/`settings`/`job`); `useRoute()` reads
  `window.location.hash` via `useSyncExternalStore`; `navigate(route)` writes it. **No new route is
  introduced by this feature** — every mockup screen reshapes an existing route (`#/runs`,
  `#/settings/schedule`) or the persistent shell chrome, matching ux-notes §5's "no new page" framing.
- **State/data:** TanStack React Query v5 (`ui/package.json`). Per-feature `*.queries.ts` (returns
  `queryOptions(...)`) + `*.api.ts` (thin `getJson` wrappers) + a `use*Data.ts` hook file that adds
  `refetchInterval`. Confirmed pattern: `ui/src/features/runs/runs.queries.ts:13-45` +
  `ui/src/features/runs/runs.api.ts:12-29` + `ui/src/features/runs/useRunsData.ts:4-18`; daemon status
  mirrors it at `ui/src/features/wizard/wizard.queries.ts:25-29`. No Redux/Zustand — React Query's
  cache is the only client state store; local UI state (toggles, dismiss flags) is plain `useState`.
- **Data fetching:** `ui/src/lib/api/client.ts:24-85` — `request<T>()` wraps `fetch`, throws
  `ApiError(status, code, message)` on non-2xx or a malformed body. `getJson`/`postJson`/`patchJson`/
  `putJson`/`deleteJson` are the only verbs used anywhere in `ui/src`. Response types are **type-only
  imports from `src/app/features/*/index.ts`** for the runs/board/config/profiles domains
  (`ui/src/lib/api/types.ts:6-36`) — but the **daemon/wizard domain hand-duplicates its own mirror
  type** in `ui/src/features/wizard/wizard.types.ts:147-160` rather than importing
  `ports/board.ts`'s `DaemonStatus`/`DaemonProfileSchedule`. This is a real, load-bearing asymmetry
  (see §3) — the two new fields BE adds to `DaemonProfileSchedule` (blueprint-be.md step 0.8) do
  **not** reach the UI automatically; the hand-duplicated mirror must be edited too, or TypeScript
  will silently drop them even though the JSON payload carries them.
- **Component inventory** (`ui/src/components/ui/`, all shadcn/radix, confirmed by direct read):
  `accordion.tsx` (Radix disclosure, installed commit `aad87fd`, not yet consumed by any feature
  component — first real consumer is `EvidenceSection.tsx`'s import, confirmed via
  `grep -rl components/ui/accordion ui/src` → one hit), `badge.tsx` (CVA variants: default/secondary/
  destructive/success/running/outline/ghost/link — none produce `bg-accent`+`text-primary`, see §1
  row for the Catch-up pill), `button.tsx` (variants default/outline/secondary/ghost/destructive/link;
  sizes default/xs/sm/lg/icon*), `card.tsx` (heavier `rounded-xl ring-1` container — **not** the
  pattern `RunsList.tsx`'s rows actually use, which is a plain `rounded-lg border bg-card` div; the
  deferred group and catch-up banner follow the row idiom, not `Card`), `dialog.tsx`, `form.tsx`,
  `input.tsx`, `popover.tsx`, `progress.tsx` (thin Radix wrapper, already consumed by
  `LiveRunHeader.tsx:95`), `select.tsx`, `separator.tsx`, `skeleton.tsx` (already consumed by
  `RunsPage.tsx:184`), `switch.tsx`, `tabs.tsx`, `textarea.tsx`. **No new primitive is required** —
  confirmed independently, not inherited from ux-notes' claim: every interaction this feature needs
  (disclosure, badge, button, progress, skeleton) already has an installed primitive.
- **E2E harness:** Playwright, `ui/playwright.config.ts` (`testDir: ./e2e`, `baseURL 127.0.0.1:4199`,
  spawns `jobbunny board` as the web server). Spec files are `ui/e2e/*.spec.ts`. **Read first-hand:**
  `ui/e2e/run-experience.spec.ts` (711 lines) and its sibling fixture file `ui/e2e/run-fixtures.ts`
  (257 lines) — the idiom every state-pinning step below reuses: `page.route('**/api/profiles/rajni/
  runs*', ...)` stubs intercept the real API, `pinProfile()` seeds `localStorage.jobbunny.profile =
  'rajni'` via `addInitScript`, and assertions target `data-testid`/`data-run-id` locators (e.g.
  `run-fixtures.ts:66-68`'s `rowLocator`). Every e2e in this blueprint is planned as a new stub
  function in `run-fixtures.ts` (or a small sibling `daemon-fixtures.ts` for the Phase 0 surfaces) —
  never a seeded row in `rajni`'s committed sqlite fixture, matching the file's own header comment
  ("never by seeding a run into rajni's shared sqlite fixture").
- **Unit test harness:** Vitest + `@testing-library/react`, colocated `*.test.tsx` (confirmed:
  `ui/src/features/runs/RunsList.test.tsx:1-9`).

---

## 1. Component Mapping

**Completeness assertion.** The mockup declares **55** unique `data-qa` ids (independently verified:
`grep -o 'data-qa="[^"]*"' mockup.html | sort -u | wc -l` → 55, no duplicates). Of these:

- **8** are Telegram message-shape ids (`tg-first-failure`, `tg-failure-reminder`, `tg-new-signature`,
  `tg-deferred-day`, `tg-deferred-day-no-catchup`, `tg-catchup-digest`, `tg-daemon-degraded`,
  `tg-icon-legend`) — backend plaintext per the task's binding scope statement, not React components.
- **1** is `efficiency-comparison` — the mockup's own "today vs designed" documentation table
  (dossier §7), presentational scaffolding for the mockup artifact itself, not board UI.
- **46** are board-UI ids and are this blueprint's scope.

**46 in-scope ids ↔ 46 rows below. 9 out-of-scope ids are listed in the table's final section with an
explicit reason each, not silently dropped.** 46 + 9 = 55. Complete.

Legend: **P0** = Phase 0 (D2, no migration), **P1** = Phase 1 (migration-bearing). Verdict is one of
**existing** (reuse, attribute-additive), **existing-extend** (existing file/component gains new
props/branches), **new** (new file, composing only existing primitives), or **excluded** (mockup
shows it; this blueprint deliberately does not build it, justified in §6).

### S1 — Runs page, deferred day (Phase 1)

| `data-qa` | Mockup element | Real component | Props / variant | Verdict | Design Scale |
|---|---|---|---|---|---|
| `runs-page` | app shell root | `ui/src/features/runs/RunsPage.tsx` root `<div>` | add `data-qa="runs-page"` alongside existing (untestid'd) root | existing | — |
| `runs-day-reassurance` | day summary line | new `<p>` in `RunsPage.tsx`, derived from `runsQuery.data` + `useDeferredSlots` | text: `{date} · {runCount} run(s), {deferredCount} slots deferred, {failedCount} failed` | new (inline function, no new file) | `text-xs text-muted-foreground` |
| `run-row-catchup` | catch-up run row | `RunsList.tsx`'s existing row, extended | when `row.catchupSlots != null`: adds `data-qa="run-row-catchup"`, a `Badge` "Catch-up", subline override "Stood in for N slots" | existing-extend | `text-2xl font-heading` (number), `badge` CVA override (see below) |

### Deferred group (Phase 1) — 19 ids

| `data-qa` | Mockup element | Real component | Props / variant | Verdict | Design Scale |
|---|---|---|---|---|---|
| `deferred-group` | group container | new `ui/src/features/runs/DeferredGroup.tsx`, composes `Accordion`/`AccordionItem` | `type="single" collapsible defaultValue="deferred"` | new | `rounded-lg border border-dashed border-border bg-card px-3 py-2 gap-1` |
| `deferred-group-header` | icon+count+reason+numslot row | static content inside `DeferredGroup.tsx` (not the trigger — see §6 divergence 2) | `CirclePause` (lucide, same import family as `RunsList.tsx`'s `Circle`/`CircleAlert`) + text | new | `text-sm font-medium` / `text-sm text-muted-foreground` |
| `deferred-group-reason` | supporting sentence | static `<p>` in `DeferredGroup.tsx` | `deferred_slots[0].reason` (or a fixed group sentence, see §3) | new | `text-xs text-muted-foreground` |
| `deferred-group-toggle` | collapse/expand control | `AccordionTrigger` (existing primitive) | static accessible label + built-in chevron (see §6 divergence 2) | existing (primitive) | `text-xs text-primary` |
| `deferred-slot-entry-{1..5}` | 5 slot rows | `.map()` over `deferred_slots` rows inside `AccordionContent`, `data-qa={\`deferred-slot-entry-${i+1}\`}` | one row per slot, index-suffixed to match the mockup literally | new | `pl-4 text-xs` |
| `deferred-slot-time-{1..5}` | slot time | span inside each entry, `data-qa={\`deferred-slot-time-${i+1}\`}` | `HH:MM` | new | `text-xs` |
| `deferred-slot-reason-{1..5}` | slot reason | span inside each entry, `data-qa={\`deferred-slot-reason-${i+1}\`}` | `reason` string, or `"reason unavailable"` fallback (R23 metric) | new | `text-xs` |

### Catch-up banner (Phase 1) — 8 ids

| `data-qa` | Mockup element | Real component | Props / variant | Verdict | Design Scale |
|---|---|---|---|---|---|
| `catchup-banner` | banner root | `LiveRunHeader.tsx`, extended | additive `data-qa="catchup-banner"` alongside existing `data-testid="live-run-header"`, active when `run.kind === 'catchup'` | existing-extend | `gap-2 border-b border-border bg-muted/30 px-4 py-3` (unchanged) |
| `catchup-banner-label` | "Catch-up run — farm 2/10" | same element as existing `data-testid="live-run-stage"`, text branches on `run.kind` | additive `data-qa` | existing-extend | `text-sm font-medium` |
| `catchup-banner-standin` | "Standing in for N slots (...)" | new line in `LiveRunHeader.tsx`, rendered only when `run.kind === 'catchup'` | `run.catchupSlots.join(', ')` | existing-extend | `text-xs text-muted-foreground` |
| `catchup-banner-progress` | progress bar | existing `<Progress>` (already at `LiveRunHeader.tsx:95`) | additive `data-qa` | existing | — |
| `catchup-banner-why` | "Chrome is open because…" | new line in `LiveRunHeader.tsx`, catch-up only | fixed copy | existing-extend | `text-xs text-muted-foreground` |
| `catchup-banner-eta` | "~19 min left" | existing heartbeat-row text, catch-up branch | renders `~{Math.round(remainingMs / 60000)} min left` when the new `estimatedDurationMs` **prop** is non-null, where `remainingMs = Math.max(0, estimatedDurationMs - elapsedMs)`, computed client-side every render off the same `now`/elapsed value `LiveRunHeader` already derives (never a second clock read, never negative) — falls back to the existing elapsed-only copy ("Alive" pattern) when the prop is `null` (`blueprint-be.md` step 1.18: not-running or `sampleSize < MIN_DURATION_SAMPLE_SIZE`, one fallback path for both). **Source, precisely (§3):** `estimatedDurationMs` is NOT on `run` (a `RunSummary` from the runs-list endpoint) — it is only on `RunDetail`/`RunDetailResponse` via `GET .../runs/:id` (step 1.18). `LiveRunHeaderProps` gains a new optional `estimatedDurationMs?: number \| null` prop, and `RunsPage.tsx` threads it in from its **already-fetched** `detailQuery` (`useRun(profile, selectedId)`, the same query `RunDetailView` uses) — passed only when `detailQuery.data?.id === runningRow.id` (the selected run's detail happens to be the running one, the common case per RunsPage's own "default-select-newest" behavior); otherwise `undefined`, which `LiveRunHeader` treats identically to `null` (elapsed-only fallback) | existing-extend | `text-xs text-muted-foreground` |
| `catchup-banner-stop-unavailable` | "Runs to completion — about 19 min left." | new span in `LiveRunHeader.tsx`, catch-up + `variant 2b` only | `Runs to completion — about {n} min left.` when the estimate resolves; `Runs to completion.` (no minutes clause) when it doesn't — same clamped `remainingMs` computed once and reused, not a duplicate calculation | new (small) | `text-xs font-medium text-muted-foreground` |
| `catchup-banner-stop` | Stop button (variant 2a) | **not built** | — | **excluded** — see §6 divergence 1 | — |

### Run detail, catch-up (Phase 1) — 3 ids

| `data-qa` | Mockup element | Real component | Props / variant | Verdict | Design Scale |
|---|---|---|---|---|---|
| `run-detail-catchup` | wrapping region | `RunDetailView.tsx`'s `OutcomeHeader`, extended — wraps the badge+covered-slots pairing inline (mockup shows it as an isolated demo card; the real app embeds it, per ux-notes §5 S3's own "existing detail view plus two additions" framing — not a divergence) | rendered when `run.kind === 'catchup'` | existing-extend | — |
| `run-detail-catchup-badge` | "Catch-up" badge | `Badge` (existing primitive, override className) | see badge-styling note below | existing | `badge` |
| `run-detail-covered-slots` | "Covered slots: …" | new `<p>` in `OutcomeHeader` | `run.catchupSlots.join(', ')` | existing-extend | `text-xs text-muted-foreground` |

**Badge styling note (both `run-row-catchup`'s pill and `run-detail-catchup-badge`):** none of
`badge.tsx`'s CVA variants (`default`/`secondary`/`destructive`/`success`/`running`/`outline`/`ghost`/
`link`) produce the mockup's `bg-accent` + `text-primary` combination. Rather than add a ninth CVA
variant for one badge, both mapping rows use `<Badge variant="outline" className="border-transparent
bg-accent text-primary">Catch-up</Badge>` — an existing-primitive reuse with a Tailwind override,
both classes already-declared Design Scale tokens (`--accent`, `--primary`), zero new CSS.

### Daemon degraded (Phase 0) — 10 ids

| `data-qa` | Mockup element | Real component | Props / variant | Verdict | Design Scale |
|---|---|---|---|---|---|
| `daemon-degraded-banner` | global shell strip | new `ui/src/features/shell/DaemonDegradedBanner.tsx` | reads `daemonQuery()`, renders when the current profile's `entry.degraded === true` | new | `bg-attention/10 border-b border-attention` |
| `daemon-degraded-cause` | cause line | `<p>` in the same component | `entry.degradedReason` | new (same file) | `text-xs text-attention-strong` |
| `daemon-degraded-remedy` | "Fix: restart the daemon —" | `<p>` in the same component | fixed copy | new (same file) | `text-xs text-attention-strong` |
| `daemon-degraded-command` | command block | `<div>` in the same component, styled per `Step6Launch.tsx:104-110`'s `DaemonStartHint` precedent (same `font-mono` + `bg-muted/50` treatment — pattern reused, code **not** shared across features, see §8 NOTES) | `jobbunny serve stop && jobbunny serve start` | new (same file) | `font-mono text-xs bg-muted/50 px-3 py-2` |
| `daemon-degraded-copy-button` | Copy button | `Button` (existing primitive, `variant="ghost" size="sm"`) + local `copied` `useState`, same clipboard pattern as `Step6Launch.tsx`'s `handleCopy` | `navigator.clipboard.writeText(...)` | existing (primitive) + new (local logic) | — |
| `schedule-daemon-status` | status line container | `ScheduleSection.tsx`, extended | new block below the existing `schedule-next-run` line | existing-extend | `settings-panel` idiom already used by the section |
| `schedule-daemon-status-healthy` | "Running · last tick Ns ago" | same block, `daemon.data` branch | `entry.degraded === false` | existing-extend | `text-sm` |
| `schedule-daemon-status-degraded` | "Degraded — schema vN > vM" + fix line | same block | `entry.degraded === true` | existing-extend | `text-sm text-attention-strong` |
| `schedule-daemon-status-loading` | skeleton | existing `Skeleton` primitive | `daemon.isLoading` | existing | `h-8 w-40` (matches `Step6Launch.tsx:305`'s own skeleton size) |
| `schedule-daemon-status-error` | "Can't reach the daemon API" + Retry | same block | `daemon.isError` | existing-extend | `text-sm text-destructive` |

### Runs list states (Phase 1, bundled with the RunsPage work) — 3 ids

| `data-qa` | Mockup element | Real component | Verdict | Design Scale |
|---|---|---|---|---|
| `runs-list-empty` | "No runs recorded yet" | `RunsList.tsx`'s existing `data-testid="runs-empty"` div, additive `data-qa` | existing | — |
| `runs-list-loading` | 3× skeleton | `RunsPage.tsx`'s existing skeleton block (`RunsPage.tsx:182-186`), additive `data-qa` on the wrapper | existing | — |
| `runs-list-error` | `ErrorRetry` | `RunsPage.tsx`'s existing `ErrorRetry` component, additive `data-qa` on its wrapper | existing | — |

### Out of scope (9 ids, accounted for, not built here)

| `data-qa` | Reason |
|---|---|
| `tg-first-failure`, `tg-failure-reminder`, `tg-new-signature`, `tg-deferred-day`, `tg-deferred-day-no-catchup`, `tg-catchup-digest`, `tg-daemon-degraded` | Backend-rendered Telegram plaintext (`formatDigest`/`composeFailureNotice`/`composeDeferredDaySummary`, `blueprint-be.md` steps 1.11/1.11a/1.14-1.16). No `parse_mode`, no React component exists to build. |
| `tg-icon-legend` | The mockup's own documentation table explaining the icon vocabulary across surfaces — not a shipped UI region on either the board or Telegram. |
| `efficiency-comparison` | The mockup's own "today vs designed" contrast table (dossier §7) — mockup-artifact scaffolding, not board UI. |

**46 rows above + 9 out-of-scope rows = 55. Matches the mockup's independently-verified count.**

**Wired-action note, no `data-qa` id (not a completeness-table entry, still a named target):** the
mockup's daemon-degraded strip also shows a dismiss `<button class="degraded-close" aria-label=
"Dismiss for this session">` (`mockup.html:694`) with **no `data-qa` attribute** — it is out of the
55-id completeness count by construction, but "wired actions only" still applies to every interactive
element the mockup shows. Target: clicking it sets `DaemonDegradedBanner`'s local `dismissed`
`useState` to `true`, unmounting the banner for the remainder of the session (page-load lifetime — a
reload or a fresh `entry.degraded` transition to `true` after a prior dismiss re-shows it, matching
"dismissible per-session only, undismissible across sessions"). Given `aria-label="Dismiss for this
session"`, it needs a stable selector for its own test even without a `data-qa` id: use
`page.getByRole('button', { name: 'Dismiss for this session' })` in e2e, `getByRole` in the unit test.

---

## 2. Layout & Composition

### Shell-level prerequisite (Phase 0, must land before `DaemonDegradedBanner` mounts)

**Recon finding, not in either dossier:** `daemon-degraded-banner` is specced as "a global strip at
the top of the shell" (ux-notes §5 S4), but **eight** page-root files independently hardcode
`h-screen` (confirmed: `grep -rl h-screen ui/src/features/*/[A-Z]*.tsx` → `Shell.tsx`, `Sidebar.tsx`,
`RunsPage.tsx`, `TriagePage.tsx`, `TrackerPage.tsx`, `HubPage.tsx`, `JobPage.tsx`,
`WizardPage.tsx`). Inserting a banner as a sibling above `<Page>` inside today's unconstrained
`<main className="flex-1">` would make `main`'s natural height exceed the viewport (banner height +
a still-100vh page root), while `Sidebar`'s own independent `h-screen` stays pinned — a real
double-scrollbar/height-mismatch bug, not a cosmetic one. This is "achievable with work," not a
product/UX gap, so it is resolved here rather than bounced:

- `Shell.tsx`'s outer `<div className="flex">` becomes `<div className="flex h-screen flex-col
  overflow-hidden">`, with `<DaemonDegradedBanner profile={profile} />` as its first child and the
  existing `<div className="flex flex-1 overflow-hidden">` (Sidebar + main) as its second.
- `Sidebar.tsx:60`'s `h-screen` → `h-full` (it now sits inside an already-`h-screen`-constrained
  parent; keeping `h-screen` would make it 100vh again, inside a shorter box).
- Every page-root's own `h-screen` → `h-full`: `RunsPage.tsx`, `TriagePage.tsx`, `TrackerPage.tsx`,
  `HubPage.tsx`, `JobPage.tsx`. `WizardPage.tsx` renders full-screen outside this wrapper
  (`Shell.tsx:136-138`'s early return) and is unaffected — no change there.
- This is a one-time structural fix; it does not recur per future banner.

### S1 — Runs page (`ui/src/features/runs/RunsPage.tsx`)

Nesting, top to bottom, inside the existing left column (`<section className="overflow-y-auto
border-r">`, unchanged):

1. Existing header (`Runs` title, freshness chip, Refresh) — unchanged.
2. **New:** `runs-day-reassurance` `<p>`, directly under the header, above the list.
3. **New:** `useDeferredSlots(profile, today)` query result feeds both the day-reassurance line and
   `DeferredGroup`.
4. `RunsList` (existing), receiving the same `listRows` as today — no structural change to how rows
   are hydrated. The catch-up badge/subline live **inside** `RunsList.tsx`'s existing row renderer,
   gated on `row.catchupSlots != null` — a catch-up run is still a `produced`/`failed`/etc.
   `OutcomeKind` (its `kind: 'catchup'` field is a label, not a new outcome species; `classifyOutcome`
   in `runOutcome.ts` is **unchanged**).
5. **New:** `DeferredGroup` renders **once**, positioned by placing it as a synthetic row: `RunsPage`
   passes it as a sibling immediately after the newest run in `listRows`'s render (matching S1's
   documented order: catch-up row, then deferred group, then older runs), not merged into
   `RunsList`'s own `rows` array (deferred slots are not `RunSummary`/`RunDetail` — mixing types
   would break `RunsList`'s `isRunDetail` narrowing). Concretely: `RunsList` stays runs-only;
   `RunsPage` renders `<RunsList .../>` then `{deferredRows.length > 0 && <DeferredGroup rows=
   {deferredRows} />}` as a second, separate block directly below it. **Divergence from a literal
   reading of the mockup's single `.list-col` flex container:** functionally identical vertical
   order, implemented as two sibling components instead of one merged list — necessary because
   `RunsList`'s existing type contract (`Row = RunSummary | RunDetail`) cannot represent a deferred
   slot without widening a type used by five other call sites; not worth the blast radius for a
   purely-visual ordering that two adjacent block-level components already achieve.
6. `LiveRunHeader` renders when `runningRow` exists, **extended in place** (not a separate
   `CatchupBanner` component) — same conditional as today (`RunsPage.tsx:160-168`), branching
   internally on `runningRow.kind === 'catchup'`.

### S2 — Catch-up banner extension (`ui/src/features/runs/LiveRunHeader.tsx`)

`LiveRunHeader` gains no new top-level prop beyond what `run` (now typed with the additive
`catchupSlots: string[] | null` field, `blueprint-be.md` step 1.4) already carries — the component
branches on `run.kind === 'catchup'` internally, exactly the same shape as its existing `liveness`
branch. No new component file: ux-notes §5 S2 is explicit that this "extends the existing
`LiveRunHeader`," and the disconnected/stalled states shown in the mockup's "remaining states" panel
for the catch-up banner are **the same liveness treatment `LiveRunHeader` already has** — building a
second component would duplicate that logic, not compose it.

### S3 — Run detail catch-up (`ui/src/features/runs/RunDetailView.tsx`)

`OutcomeHeader` (currently rendering the label/number and the meta cluster) gains one more
conditional block, rendered when `run.kind === 'catchup'`: the `Badge` + covered-slots line, placed
inside the existing `flex items-baseline gap-2` label row (badge) and directly below the header
(covered-slots paragraph) — matching S3's own framing of "two additions in the outcome header."

### S4 — Daemon degraded (Phase 0, two independent placements)

- **Global strip:** `DaemonDegradedBanner.tsx`, new file, rendered once in `Shell.tsx` (see the
  shell-level prerequisite above). Reads the shared `daemonQuery()` cache — the **same** query
  `ScheduleSection` already reads (`wizard.queries.ts:25-29`'s fixed key `['daemon']`), so no
  duplicate fetch is introduced.
- **Settings → Schedule:** `ScheduleSection.tsx`, extended — a new block directly below the existing
  `schedule-next-run` paragraph, reading the same `daemon` query the component already holds
  (`ScheduleSection.tsx:37`).

---

## 3. State & Data

Every datum below cites `blueprint-be.md` by step number — no invented contract.

| UI datum | Source | BE contract |
|---|---|---|
| Deferred slots for a date | `GET /api/profiles/:name/deferred-slots?date=YYYY-MM-DD` | `blueprint-be.md` step 1.17, `ListDeferredSlotsResponse { rows: DeferredSlotRow[]; total: number; date: string }` |
| `DeferredSlotRow.reasonCode` / `.reason` | same response | step 1.2 — `reasonCode` is the machine-stable key for icon/species selection (UI must key branching off `reasonCode`, never parse `reason` text — `blueprint-be.md` Notes for product-ui) |
| `RunSummary.catchupSlots` / `RunDetail.catchupSlots` | `GET /api/profiles/:name/runs`, `GET .../runs/:id` (existing routes, unchanged paths) | step 1.4-1.5 — additive `string[] \| null` field |
| `DaemonProfileSchedule.degraded` / `.degradedReason` | `GET /api/daemon` (existing route) | step 0.8 — additive fields on the existing per-profile schedule entry |
| Catch-up ETA / duration estimate (`estimatedDurationMs`) | `GET /api/profiles/:name/runs/:id` (existing route, unchanged path — **not** the runs-list route) | step 1.18, `RunDetailResponse extends RunDetail { estimatedDurationMs: number \| null }`, populated only when `status === 'running'`, from a median of ≥`MIN_DURATION_SAMPLE_SIZE` (3) same-shape historical runs (backend-verified against the live DB: excluded re-fire runs show 20 skips/2–6 harvests, retained runs 0–6 skips/78–93 harvests, zero overlap; resulting 28.8 min median sits inside the observed 28.2–45.9 min full-run range) |
| Stop-catch-up action | **no endpoint exists, not built** | `blueprint-be.md` §10 Out of Scope: R11 not delivered, variant 2a explicitly not the shipping variant |

**Remaining time is computed client-side, deliberately (coordinator instruction, this session):**
`remainingMs = Math.max(0, estimatedDurationMs - elapsedMs)`, recomputed every render from
`estimatedDurationMs` (fetched once per detail-query resolution, effectively static for the run's
lifetime) and `elapsedMs` (already ticking locally off the shared `now`/`startedAt` `LiveRunHeader`
uses for its existing elapsed display — no new timer). A server-computed "remaining" value would go
stale the instant it arrived between polls; the clamp (`Math.max(0, ...)`) guarantees the UI never
displays a negative number even once `elapsedMs` exceeds the estimate. `estimatedDurationMs === null`
covers exactly two cases, treated identically by the UI (no third branch, no error state): the run
is not `status === 'running'`, or fewer than `MIN_DURATION_SAMPLE_SIZE` (3) eligible historical runs
exist yet.

**Type-layer gap that must be closed (not covered by any BE step, a pure UI-side fact):**
`ui/src/features/wizard/wizard.types.ts:147-160` hand-duplicates `DaemonProfileSchedule`/
`DaemonStatus` rather than importing the `ports/board.ts` types the way `ui/src/lib/api/types.ts`
does for the runs/board domains. BE's step 0.8 adds `degraded`/`degradedReason` to
`ports/board.ts`'s `DaemonProfileSchedule` — **this blueprint's implementation step 0.1 (§4) must
add the same two fields to the UI's own hand-duplicated mirror**, or the JSON payload will carry them
while TypeScript silently can't see them. Flagged explicitly so it isn't discovered at review time.

**Deferred group's "reason" sentence, resolved:** `deferred-group-reason`'s copy in the mockup
("Job Bunny declined to start these runs because the host was asleep.") is a single sentence for the
whole group, but the data is per-slot (`DeferredSlotRow.reason`, potentially differing per row if a
mixed host-asleep/network-unreachable day occurs). Rule: when every row in the day's `rows` shares
the same `reasonCode`, render that reason's sentence once (mockup's literal case); when `reasonCode`s
differ across rows, render a generic fallback ("Job Bunny declined to start several runs today —
see below for each reason.") and rely on the per-row `deferred-slot-reason-{n}` spans (which always
carry the real per-row text) to disambiguate. This is a UI judgment call the dossiers don't resolve
explicitly — recorded here, not silently decided in code.

---

## 4. Implementation Steps

Two phases. Phase 1 does not start until Phase 0 has shipped (mirrors `blueprint-be.md`'s own
phase-ordering rule — the UI's Phase 1 work depends on `catchupSlots`/`deferred-slots` data that only
exists after BE's Phase 1 migration lands).

### Phase 0 — daemon degraded (D2), no backend migration

**0.1 — Extend the UI's daemon-status mirror type.**
File: `ui/src/features/wizard/wizard.types.ts`. Add to `DaemonProfileSchedule` (line 147-151):
`degraded: boolean; degradedReason: string | null;` — matching `blueprint-be.md` step 0.8's port
shape field-for-field. No runtime code change; `getDaemonStatus()` (`wizard.api.ts:12`) already
returns whatever JSON the server sends.
Done when: a colocated `wizard.types.test.ts` (new, one assertion) round-trips a fixture object with
both fields through `DaemonProfileSchedule` and confirms `tsc --noEmit` (via `npm run ui:check`)
passes with the fields present — this step's only purpose is making the compiler see fields the
server already sends.

**0.2 — Shell layout prerequisite.**
Files: `ui/src/features/shell/Shell.tsx`, `ui/src/features/shell/Sidebar.tsx`,
`ui/src/features/runs/RunsPage.tsx`, `ui/src/features/triage/TriagePage.tsx`,
`ui/src/features/tracker/TrackerPage.tsx`, `ui/src/features/hub/HubPage.tsx`,
`ui/src/features/job/JobPage.tsx`. Apply the restructuring in §2's "Shell-level prerequisite"
exactly: outer shell div gains `h-screen flex-col overflow-hidden`; `Sidebar.tsx` and every listed
page's root `h-screen` becomes `h-full`.
Done when: every existing e2e suite that visits `#/triage`, `#/tracker`, `#/runs`, `#/setup`,
`#/job/:id` (`smoke.spec.ts`, `run-experience.spec.ts`, `runcontrol.spec.ts`, `shell.spec.ts`) still
passes unchanged — a pure regression bar, since this step changes zero visible behavior by itself
(no banner exists yet to observe).

**0.3 — `DaemonDegradedBanner` component.**
File: `ui/src/features/shell/DaemonDegradedBanner.tsx` (new) + colocated
`DaemonDegradedBanner.test.tsx`. Reads `useQuery(daemonQuery())`, finds
`entry = data?.profiles.find(p => p.profile === profile)`. Renders `null` when `entry` is undefined
or `entry.degraded === false`, or when a local `dismissed` `useState` is `true` for the session.
Renders the five `data-qa` ids from §1's table when `entry.degraded === true`. Copy button mirrors
`Step6Launch.tsx`'s `handleCopy` pattern (`navigator.clipboard.writeText`, 2s "Copied" `useState`
reset via `setTimeout`) — duplicated locally per §8's NOTES judgment call, not imported.
Done when: a unit test asserts (a) `entry.degraded: false` renders nothing (queried via
`screen.queryByTestId` returning `null`); (b) `entry.degraded: true` renders the cause/remedy text
verbatim from `entry.degradedReason` — **asserting the rendered text equals the fixture's
`degradedReason`, not merely that some text exists**; (c) clicking the copy button calls
`navigator.clipboard.writeText` with the exact command string and flips the button's own text to
"Copied" — the effect, not the button's presence; (d) clicking the dismiss button
(`getByRole('button', { name: 'Dismiss for this session' })`) unmounts the banner
(`queryByTestId`/`queryByRole` returns `null` immediately after the click) — the dismiss action's
actual effect, not merely that the button renders.

**0.4 — Wire `DaemonDegradedBanner` into `Shell.tsx`.**
File: `ui/src/features/shell/Shell.tsx`. Render `<DaemonDegradedBanner profile={profile} />` as the
first child of the new outer wrapper from step 0.2, before the Sidebar+main row.
Done when: `ui/e2e/shell.spec.ts` gains a new test — stub `GET /api/daemon` (new helper
`stubDaemonStatus(page, profiles)` added to `ui/e2e/run-fixtures.ts`) returning one profile with
`degraded: true, degradedReason: 'schema v8 > build v7'`; navigate to `#/triage`; assert the banner
(`page.getByTestId('daemon-degraded-banner')` — wait, use `[data-qa="daemon-degraded-banner"]`
locator) is visible **and** that `[data-qa="daemon-degraded-cause"]` contains the exact fixture
reason text; assert clicking `[data-qa="daemon-degraded-copy-button"]` writes the command to the
clipboard (Playwright's `page.evaluate(() => navigator.clipboard.readText())`, matching how
`Step6Launch.test.tsx`/existing clipboard tests in this repo already verify copy actions, if any
precedent exists — otherwise assert the button's own text flips to "Copied" as the observable
effect). **e2e id: `shell.spec.ts` — "shell: a degraded daemon shows the global banner with cause,
remedy, and a working copy button."**

**0.5 — `ScheduleSection` daemon status block.**
File: `ui/src/features/settings/sections/ScheduleSection.tsx`. Below the existing
`schedule-next-run` paragraph (line ~114-119), add the four-state block from §1's table, reading the
same `daemon` query the component already holds (`daemon.isLoading`/`daemon.isError`/
`daemon.data`). `entry` resolution is identical to step 0.3's.
Done when: a unit test (extend `ScheduleSection.test.tsx`) asserts the healthy variant renders
"Running · last tick Ns ago" **computed from the fixture's actual `lastTickAt`/`nextRunAt`**, not a
hardcoded string, and the degraded variant renders `entry.degradedReason` verbatim plus the remedy
command in `font-mono`.

**0.6 — Settings e2e for the degraded schedule status.**
File: `ui/e2e/settings.spec.ts`. New test, reusing `stubDaemonStatus` from step 0.4: navigate to
`#/settings/schedule`, stub a degraded profile, assert `[data-qa="schedule-daemon-status-degraded"]`
is visible with the exact reason text, and that the healthy-state fixture instead shows
`[data-qa="schedule-daemon-status-healthy"]` with zero `degraded` markup present (mutually exclusive
render, not both mounted and one hidden).
**e2e id: `settings.spec.ts` — "settings: schedule section shows the daemon's degraded state with
cause and remedy."**

### Phase 1 — deferred entries, catch-up labeling, catch-up banner (migration-bearing)

Phase 1 UI work does not start until BE's Phase 1 (migration + `deferred_slots`/`catchup_slots_json`)
has shipped — the endpoints below do not exist before that.

**1.1 — Deferred-slots data layer.**
Files: `ui/src/features/runs/deferredSlots.api.ts` + `deferredSlots.queries.ts` (new, mirroring
`runs.api.ts`/`runs.queries.ts`'s exact split). `listDeferredSlots(profile, date?)` calls
`getJson<ListDeferredSlotsResponse>` against `blueprint-be.md` step 1.17's route.
`deferredSlotsKeys.list(p, date)` + `deferredSlotsQuery(p, date)` follow `runsKeys`/`runsQuery`'s
naming exactly. `ListDeferredSlotsResponse`/`DeferredSlotRow` types come from
`ui/src/lib/api/types.ts` as new **type-only re-exports** from `src/app/features/runs/index.ts` (the
existing pattern for the runs domain — not the wizard domain's hand-duplication).
Done when: a colocated `deferredSlots.api.test.ts` proves `listDeferredSlots` builds the correct
query string for a given date and omits it when absent (mirrors an existing `runs.api.test.ts`-style
test if one exists, else a new minimal one).

**1.2 — `useDeferredSlots` hook.**
File: `ui/src/features/runs/useRunsData.ts`, extended with one more export:
`useDeferredSlots(profile, date)` wrapping `deferredSlotsQuery`, no poll interval (matches
`useRuns`'s own default — deferred slots for a past/current day don't need a live poll; `RunsPage`'s
existing manual-refresh button already covers it).
Done when: existing `useRunsData.ts` exports still typecheck; the new export is covered by the same
test file pattern as the other three hooks there (if one exists) or a new minimal test.

**1.3 — `DeferredGroup` component.**
File: `ui/src/features/runs/DeferredGroup.tsx` (new) + colocated test. Implements the structure from
§1/§2: `Accordion` wrapping one always-open `AccordionItem`, static header content, always-rendered
five-or-fewer entries inside `AccordionContent`, `AccordionTrigger` as the toggle (§6 divergence 2).
Props: `{ rows: DeferredSlotRow[] }`. Never renders when `rows.length === 0` (R25 — never empty by
construction, matching the mockup's own "Never empty by construction" states-table entry).
Done when: a unit test asserts (a) five rows render five `deferred-slot-entry-{1..5}` elements, each
with the correct `deferred-slot-time-{n}`/`deferred-slot-reason-{n}` text — **the count assertion is
`toHaveLength(5)` on the actual rendered entries, not a prose comment claiming five exist**; (b) a
row with `reason: ''` (an empty string, simulating the BE gap ux-notes §11 item 4 flags) renders
"reason unavailable" in that entry, not a blank string — asserted via `getByText`, which fails if
the text is empty; (c) clicking the toggle collapses the entries (`AccordionContent` unmounts/hides,
verified via `queryByText` on one entry's time string returning `null` after the click) and clicking
again restores them.

**1.4 — Wire `DeferredGroup` into `RunsPage`.**
File: `ui/src/features/runs/RunsPage.tsx`. Add `useDeferredSlots(profile, today)`; compute
`deferredCount`/`failedCount` for the day-reassurance line; render `runs-day-reassurance` and
`<DeferredGroup rows={deferredQuery.data?.rows ?? []} />` per §2's ordering. Loading state: a single
`Skeleton h-12` (not three) when `deferredQuery.isPending` — the mockup's own "never five, or loading
itself would look like an alarm" rule. Error state: an inline retry matching `runs-list-error`'s own
shape, scoped to just the deferred region (not the whole page — a deferred-slots fetch failure must
not blank the runs list).
Done when: **`ui/e2e/pipeline-stability.spec.ts` (new file, mirrors `run-experience.spec.ts`'s
structure and reuses `run-fixtures.ts`'s `pinProfile`/`stubRunsList` helpers plus a new
`stubDeferredSlots(page, rows)` added to `run-fixtures.ts`)** — test "runs page: a day with 5 deferred
slots and a catch-up run shows five reason-carrying entries and zero failed rows": stub 1 catch-up
`runs` row + 5 `deferred_slots` rows, navigate to `#/runs`, assert
`page.locator('[data-qa="deferred-slot-entry-1"]')` through `-5` are each visible with non-empty text
content (`await expect(locator).not.toHaveText('')`), and assert
`page.locator('[data-testid="run-row"][data-outcome-kind="failed"]')` has count 0 — **the AC19
assertion made literal, not asserted by counting DOM nodes generically.**
**e2e id: `pipeline-stability.spec.ts` — "runs page: a day with 5 deferred slots and a catch-up run
shows five reason-carrying entries and zero failed rows."**

**1.5 — Catch-up row extension in `RunsList`.**
File: `ui/src/features/runs/RunsList.tsx`. When `row.catchupSlots != null`: add
`data-qa="run-row-catchup"` to the row's root `<div>` (additive to `data-testid="run-row"`), insert a
`Badge` ("Catch-up", styling per §1's badge note) into the `run-label-line` flex row, and override
`subline` to `` `Stood in for ${row.catchupSlots.length} slot${row.catchupSlots.length === 1 ? '' :
's'}` `` — taking precedence over the existing `emptySubline`/`degradedSubline` branches (a catch-up
row's subline is always the stand-in count, regardless of its underlying produced/empty/degraded
classification).
Done when: a unit test (extend `RunsList.test.tsx`) asserts a `produced` row with
`catchupSlots: ['14:00','16:30','19:00']` renders the "Catch-up" badge text and the subline "Stood in
for 3 slots" **verbatim**, and that a row with `catchupSlots: null` renders neither — the negative
case is required, not just the positive one (guards against the badge always rendering).

**1.6 — `LiveRunHeader` catch-up extension, including the ETA computation.**
File: `ui/src/features/runs/LiveRunHeader.tsx`. `LiveRunHeaderProps` gains one new optional field:
`estimatedDurationMs?: number | null` (source and wiring rule per §3 — sourced from `RunsPage`'s
already-fetched run-detail query, **not** a new fetch here). Branch on `run.kind === 'catchup'`:
label text becomes `` `Catch-up run — ${progress.stage} ${progress.stageIndex}/${progress.stageTotal}`
`` (or "Catch-up run — starting…"); insert `catchup-banner-standin` and `catchup-banner-why` lines.
Compute once per render, alongside the existing `formatElapsed`/`now` derivation (no second clock
read): `elapsedMs = now - Date.parse(run.startedAt)`; `remainingMs = estimatedDurationMs != null ?
Math.max(0, estimatedDurationMs - elapsedMs) : null`. When `liveness === 'alive'` and
`run.kind === 'catchup'`: render `catchup-banner-eta` as `` `~${Math.round(remainingMs! / 60000)} min
left` `` when `remainingMs !== null`, else the elapsed-only fallback (`` `${formatElapsed(...)}
elapsed` ``); render `catchup-banner-stop-unavailable` from the **same** `remainingMs` value (shared
variable, not recomputed) as `` `Runs to completion — about ${n} min left.` `` or, when `null`,
`"Runs to completion."`. The existing `stalled`/`disconnected` branches are **unchanged** (reused
as-is per §2 — no ETA render in either, matching the mockup's own states table, which shows ETA only
in the alive/default variant). Root `<div>` gains additive `data-qa="catchup-banner"`.
Done when: a unit test (extend `LiveRunHeader.test.tsx`) asserts, as the specific effect of the
computation, not the presence of any element:
(a) given `run.startedAt` fixed such that `elapsedMs` is a known value (e.g. mock `Date.now()` or pass
a fixed `startedAt` 8 minutes before a controlled "now") and `estimatedDurationMs: 1_140_000` (19 min),
`catchup-banner-eta` renders exactly `"~11 min left"` — **the arithmetic result, asserted as literal
text**, not merely that the element exists;
(b) the same fixture's `catchup-banner-stop-unavailable` renders exactly `"Runs to completion — about
11 min left."` — proving both elements share one computed value, not two independent (and possibly
inconsistent) ones;
(c) given `elapsedMs` **exceeding** `estimatedDurationMs` (e.g. 25 elapsed minutes against a 19-minute
estimate), `catchup-banner-eta` renders `"~0 min left"` — **never a negative number** — proving the
`Math.max(0, ...)` clamp is real, not merely described;
(d) given `estimatedDurationMs: null`, `catchup-banner-eta` renders the elapsed-only copy and contains
no "min left" substring, and `catchup-banner-stop-unavailable` renders exactly `"Runs to completion."`
with no minutes clause — the fallback path, asserted by its actual text, not by the absence of a
crash;
(e) `catchup-banner-standin` contains all three slot times **joined exactly as the mockup shows**
(comma-space separated);
(f) `catchup-banner-stop` is **never** present in the rendered output for any catch-up run — an
explicit negative assertion, since this is the one element the hard constraint forbids building;
(g) a non-catchup `kind: 'run'` running row renders none of the catch-up-only `data-qa` ids
(regression: today's live-run behavior, including its existing "Alive" copy, is untouched).

**1.6a — Thread `estimatedDurationMs` from `RunsPage` into `LiveRunHeader`.**
File: `ui/src/features/runs/RunsPage.tsx`. At the existing `<LiveRunHeader .../>` call site
(`RunsPage.tsx:161-167`), add
`estimatedDurationMs={detailQuery.data?.id === runningRow.id ? detailQuery.data.estimatedDurationMs :
null}` — reusing the `detailQuery` (`useRun(profile, selectedId)`) `RunsPage` already holds for
`RunDetailView`, per §3's sourcing rule. No new query.
Done when: a unit/integration test on `RunsPage` (or an extension of its existing test file) asserts
that when the selected run's detail resolves and matches the running row's id, `LiveRunHeader`
receives the detail's `estimatedDurationMs` value unchanged (a pass-through assertion, checking the
prop actually reaches the child with the right value — not merely that `RunsPage` renders without
error); and that when the selected id does **not** match the running row (e.g. the operator clicked
an older row while a catch-up runs in the background), `LiveRunHeader` receives `null`, not a stale
or mismatched estimate.

**1.7 — e2e for the catch-up banner.**
File: `ui/e2e/pipeline-stability.spec.ts`. New test "runs page: a running catch-up shows the
computed remaining time and never renders a stop control": stub a `running`, `kind: 'catchup'` row
with `catchupSlots`, and stub its `GET .../runs/:id` detail response
(`stubRunDetail`, extended to accept `estimatedDurationMs`) with a known `estimatedDurationMs` and a
`startedAt` chosen so the expected remaining minutes is a round, assertable number; assert
`[data-qa="catchup-banner-eta"]` renders that exact `"~N min left"` text (the computed value, not a
placeholder), assert `[data-qa="catchup-banner-standin"]` text contains every slot time, and assert
`page.locator('[data-qa="catchup-banner-stop"]')` has count 0 (the negative assertion, e2e-level, not
just unit-level — this is the constraint the QA "computed-style diff" is specifically primed to catch
if it's missed). A second test in the same file, "runs page: a running catch-up with no duration
estimate shows elapsed-only," stubs `estimatedDurationMs: null` and asserts the fallback copy exactly,
with no "min left" substring anywhere in the banner.
**e2e id: `pipeline-stability.spec.ts` — "runs page: a running catch-up shows the computed remaining
time and never renders a stop control" / "runs page: a running catch-up with no duration estimate
shows elapsed-only."**

**1.8 — `RunDetailView` catch-up extension.**
File: `ui/src/features/runs/RunDetailView.tsx`. `OutcomeHeader` gains the badge + covered-slots block
per §2 S3, rendered when `run.kind === 'catchup'`.
Done when: a unit test (extend `RunDetailView.test.tsx`) asserts a `catchup` run's detail view
contains `run-detail-catchup-badge` with text "Catch-up" and `run-detail-covered-slots` with the
joined slot list, and that a non-catchup run's detail view contains neither.

**1.9 — e2e for run detail catch-up.**
File: `ui/e2e/pipeline-stability.spec.ts`. New test "run detail: a catch-up run shows what it covered
without leaving the page": select the catch-up row from step 1.4's fixture, assert
`[data-qa="run-detail-covered-slots"]` text lists the same slots the banner/list row showed —
**cross-surface consistency**, not just presence.
**e2e id: `pipeline-stability.spec.ts` — "run detail: a catch-up run shows what it covered without
leaving the page."**

---

## 5. Requirements Coverage

Only Musts with a direct UI delivery surface are mapped (D1/D1b's gate/probe/ledger requirements and
D3's dedup requirements are entirely backend, covered in `blueprint-be.md` §7 — restated here would
duplicate, not add, coverage).

| Req | MoSCoW | UI delivery | e2e / test |
|---|---|---|---|
| R10 — catch-up identifiable in the board, states slot count | Must | Steps 1.5 (list), 1.6 (banner), 1.8 (detail) | `pipeline-stability.spec.ts` steps 1.7, 1.9; unit tests in 1.5/1.6/1.8 |
| R11 — stop a catch-up from the board | Should, **not delivered** | N/A — `catchup-banner-stop` explicitly excluded (§1, §6) | Negative assertion in step 1.6/1.7 proves it's absent |
| R14 — board daemon status shows degraded + cause + remedy | Must | Steps 0.3/0.4 (global banner), 0.5/0.6 (Settings status) | `shell.spec.ts` step 0.4; `settings.spec.ts` step 0.6 |
| R21 — deferred slots visible in board, never page individually | Must (board half) | Steps 1.3/1.4 (`DeferredGroup`) | `pipeline-stability.spec.ts` step 1.4 |
| R22 — deferred slot shown with a status distinct from `failed`, never as a failure | Must | Step 1.3 — `DeferredGroup` renders no `OutcomeKind`/badge at all, joining `RunsList`'s existing chroma-free `unrecorded` species framing (no code change to `runOutcome.ts` — a deferred slot is never passed through `classifyOutcome`) | `pipeline-stability.spec.ts` step 1.4 (asserts zero `failed` rows) |
| R23 — every deferred entry carries required, non-empty reason text | Must | Step 1.3's "reason unavailable" fallback | Unit test in step 1.3, part (b) |
| R25 — a gated-then-succeeded slot shows only the successful run, not a deferred entry | Must | Trusted from BE (step 1.7's `deriveExpiredUnserved` — a served slot is never a candidate); UI has nothing to filter, it renders exactly what `listDeferredSlots` returns | Covered by BE's own AC20 test; UI has no independent behavior to pin beyond "render what the endpoint returns," already exercised by step 1.4's fixture |

AC15 ("board's daemon status reads degraded, names cause and remedy") is directly pinned by
`shell.spec.ts` step 0.4 and `settings.spec.ts` step 0.6. AC19 ("board shows five entries with
non-empty reason, zero failed") is directly pinned by `pipeline-stability.spec.ts` step 1.4. AC11
("catch-up distinguishable in board... states slots stood in for") is pinned by steps 1.7/1.9 (the
digest half of AC11 is `blueprint-be.md`'s concern).

---

## 6. Mockup Divergences

1. **`catchup-banner-stop` (variant 2a) is not built.** Hard constraint, backed by
   `blueprint-be.md` §10 Out of Scope: R11 is a Should, stopping a catch-up requires routing it
   through the cancellable `run_intents` path, which scheduled/catch-up spawns explicitly do not use
   (`daemon.ts:120-125`). Variant 2b (`catchup-banner-stop-unavailable`) is the shipping variant,
   confirmed explicitly by the coordinator in `.state.md`. Building the button would be exactly the
   "inert button that looks actionable" defect class this package's prior post-mortem was written
   about.
2. **`deferred-group-toggle`'s label does not swap "Collapse"/"Expand" text.** The mockup's vanilla
   JS toggles the text content on click; the real build uses the shadcn `AccordionTrigger` primitive,
   whose built-in chevron icon (`ChevronDownIcon`/`ChevronUpIcon`, `accordion.tsx:48-55`) already
   communicates expanded/collapsed state via `aria-expanded`, with a static accessible label. Reusing
   the primitive's own state-communication mechanism is reuse-first over hand-rolling the mockup's
   bespoke text-swap logic; the a11y outcome (a single focusable disclosure, per ux-notes §9) is
   identical or stronger (native `aria-expanded`, not a manually-toggled string).
3. **Telegram surfaces (T1–T6, `tg-icon-legend`) and `efficiency-comparison` are not built as React
   components at all** — plain scope boundary (backend plaintext / mockup documentation), not a
   feasibility compromise. See §1's Out-of-scope table.

**Resolved, no longer a divergence (coordinator update, this session):** `catchup-banner-eta` /
`catchup-banner-stop-unavailable`'s "~19 min left" / "about 19 min left" copy was drafted against
this blueprint's first pass as degrading to elapsed-only, since no duration-estimate endpoint existed
at draft time. `blueprint-be.md` step 1.18 now adds `RunDetailResponse.estimatedDurationMs` (median
of ≥3 same-shape historical runs, backend-verified against the live DB: 28.8 min median vs. 28.2–45.9
min observed full-run durations, zero overlap between the excluded re-fire runs and the retained
sample). The mockup's copy is now mapped, not degraded — see §1's amended rows and §4 step 1.6. The
`null`-means-elapsed-only fallback path this blueprint originally designed is **kept**, now scoped to
exactly the two cases `blueprint-be.md` step 1.18 names (not running, or `sampleSize <
MIN_DURATION_SAMPLE_SIZE`) rather than "no backend exists at all."

No other rule in this blueprint contradicts a count, grouping, pairing, or hierarchy the mockup
shows — re-checked against `mockup.html` directly after drafting §1-§4 (five deferred entries always
rendered individually inside one visual group; the catch-up row is the one visually distinct element
on S1; the daemon-degraded banner is the only amber element on screen).

---

## 7. Risks & Assumptions

- **Shell layout restructuring (§2, step 0.2) is real, bounded work with a non-trivial blast
  radius (7 files) for what both dossiers call a small addition.** Flagged rather than silently
  absorbed: it is a one-time fix, each change is a single Tailwind class swap, and the done-condition
  is a full regression pass of the existing e2e suite — but it is genuinely more than "add one
  component," and a reviewer should expect it as its own reviewable diff within Phase 0, not buried
  inside `DaemonDegradedBanner`'s own commit.
- **`deferred-group-reason`'s mixed-reason-code fallback (§3) is a UI judgment call**, not specified
  by either dossier or `blueprint-be.md` — a day with both `host-asleep` and `network-unreachable`
  deferrals is possible (a suspend-gap tick followed by a reachable-but-unreachable-DNS tick later the
  same day) and neither document says what the group header sentence should say in that case. Resolved
  here with a generic fallback sentence; flagged as a product/UX call if the actual copy matters more
  than functional correctness.
- **`CirclePause` (lucide-react icon) was not runtime-verified** — `ui/node_modules` is not installed
  in this checkout, so the icon's presence in the pinned `lucide-react@^1.28.0` could not be confirmed
  by import. It is a standard, long-standing lucide icon name; verify at implementation time (`npm
  run ui:check` will fail loudly on an unresolved import if it's somehow absent — low risk, cheap to
  catch).
- **`SUSPECTED_SUSPEND_GAP_MS` and the ETA gap are backend/product judgment calls already flagged in
  `blueprint-be.md` §9** — not re-litigated here; the UI has nothing to tune for either.

---

## 8. Engineering Quality Gates

- **Determinism:** every new/extended component follows the existing single-`now`-per-render idiom
  already established in `LiveRunHeader.tsx:76`/`RunsList.tsx:176` (`const now = Date.now()`/`new
  Date()`, read once, passed down) — `DeferredGroup`, `DaemonDegradedBanner`, and the catch-up
  extensions never call `Date.now()`/`new Date()` a second time inside a nested child; same props
  (`daemon.data`, `runsQuery.data`, `deferredQuery.data`) always render the same tree. The catch-up
  ETA is the sharpest instance of this rule: `remainingMs` is a pure function of `estimatedDurationMs`
  (fetched once) and the one shared `elapsedMs`, clamped with `Math.max(0, ...)` — same two inputs
  always produce the same displayed minutes, and the clamp makes "never negative" a property of the
  function, not a hope.
- **Fault tolerance:** no new React error boundary is introduced — the existing `isError`/
  `ErrorRetry` pattern (`RunsPage.tsx`) already scopes fetch failures to the pane that failed, never
  the whole page. `useDeferredSlots`'s error state gets its own inline retry (step 1.4), scoped to
  just the deferred region, so a `deferred-slots` 500 cannot blank the runs list next to it.
  `DaemonDegradedBanner`'s own query failing degrades to rendering nothing (fail-quiet, matching
  `daemonQuery()`'s existing no-refetchInterval, no-error-UI posture at every other consumer) rather
  than surfacing a second, competing error banner.
- **Design-token sync:** every class added in §1's mapping table is an existing Tailwind utility tied
  to an already-declared `index.css` variable (`text-muted-foreground`, `border-dashed`,
  `border-border`, `bg-attention/10`, `text-attention-strong`, `bg-accent`, `text-primary`,
  `rounded-lg`, `font-mono`, `bg-muted/50`) — zero hardcoded hex, zero new CSS variable, matching
  `RunsList.tsx`'s own `TREATMENT` table convention exactly. Every spacing value (`gap-1`, `gap-2`,
  `px-3`, `py-2`, `pl-4`) is one of ux-notes §3's confirmed 4px-grid steps.
- **Micro-optimizations:** `DeferredGroup` renders at most 5 entries (bounded by R9's one-coalesced-
  catch-up-per-day rule — the count can never grow unbounded), a cheap static `.map()`, no
  virtualization needed. `CatchupBanner`'s extension reuses `LiveRunHeader`'s existing re-render
  trigger (`RunsPage`'s own `LIVE_POLL_MS` poll) — no new `setInterval`/timer. `DaemonDegradedBanner`
  and `ScheduleSection` share one `daemonQuery()` cache entry (confirmed fixed key `['daemon']`) — no
  duplicate fetch from adding the banner.
- **Asynchronous UX:** `runs-list-loading` ↔ `runsQuery.isPending`; the deferred group's single
  skeleton ↔ `useDeferredSlots(...).isPending` (never five skeletons — step 1.4); `schedule-daemon-
  status-loading` ↔ `daemon.isLoading`. No optimistic updates anywhere in this feature — every new
  surface is read-only (no mutation), so there is no optimistic-UI state to wire, unlike e.g.
  `useDocForm`'s save flow elsewhere in this codebase.

---

## NOTES

- **`DaemonStartHint` (Step6Launch.tsx:91-113) is a pattern precedent, not shared code.** It is a
  private, unexported function local to the wizard feature. Extracting a cross-feature
  `CopyableCommand` component would be the more DRY choice now that a second consumer exists, but the
  repo has no established "shared, non-shadcn component" folder convention (`ui/src/components/`
  contains only `ui/`, the shadcn primitives) — introducing one is a repo-wide convention decision
  out of this blueprint's proportional scope for a ~15-line clipboard snippet. Duplicated instead,
  flagged here so a reviewer can make the call to extract later if a third consumer appears.
- **`wizard.types.ts`'s hand-duplicated `DaemonStatus` mirror (vs. the runs/board domain's
  type-only-import convention) is a pre-existing inconsistency**, not introduced by this blueprint —
  surfaced because it is directly load-bearing for step 0.1, not because it needs fixing here.
- **Greenfield/reuse-first note:** this is a change-to-existing repo with a full, read component
  inventory — reuse-first was NOT suspended; every new file composes only already-installed
  primitives (§0's inventory), confirmed independently rather than inherited from ux-notes' claim.
- **`RunsList.tsx`'s `OutcomeKind` union is deliberately untouched.** A catch-up run's `kind` field
  (`'run' | 'stage' | 'reconcile' | 'catchup'`, additive per `blueprint-be.md` step 1.4) is orthogonal
  to its `OutcomeKind` (`produced`/`failed`/etc.) — the mockup's own `run-row-catchup` uses the
  `.produced` treatment class, confirming a catch-up run is still classified normally and merely
  labeled. Treating `'catchup'` as an eighth `OutcomeKind` would have been the wrong model; caught by
  reading `mockup.html:454-461` directly rather than assuming from the id name alone.

## AMENDMENT — coordinator, this session — ETA closed

`catchup-banner-eta`/`catchup-banner-stop-unavailable` were drafted in this blueprint's first pass as
degrading to elapsed-only (no backend estimate existed at draft time — declined independently by UX,
product-be, and this blueprint, each correctly, given what existed at the time). `blueprint-be.md`
step 1.18 has since added `RunDetailResponse.estimatedDurationMs` (median of ≥3 same-shape historical
runs; backend-verified separation between re-fire and full runs, 28.8 min median inside the observed
28.2–45.9 min range). Updated: §1's `catchup-banner-eta`/`catchup-banner-stop-unavailable` mapping
rows (now compute a real clamped remaining-time value, sourced from a new `LiveRunHeader` prop, not
from `run` itself); §3 (new `estimatedDurationMs` datum row + a "computed client-side, deliberately"
note explaining the staleness/clamp rationale); §4 steps 1.6 (full rewrite: the computation, the
`null`-fallback's now-exact two cases, effect-asserting done-conditions) and new step 1.6a (threading
the estimate from `RunsPage`'s existing detail query — no new fetch); §4 step 1.7 (e2e now pins the
computed value and the fallback separately); §6 (divergence 3 removed, renumbered, replaced with a
"Resolved, no longer a divergence" note); §8 Determinism gate (names the ETA clamp as the sharpest
example of the single-`now` rule). **Also fixed while in this file:** a pre-existing bug where every
cross-reference to the Mockup Divergences section said "§7" instead of "§6" (5 occurrences) — caught
because two of them sat next to text this amendment was already touching. **Confirmed unchanged:**
the 46-in-scope/9-excluded completeness split (no `data-qa` id was added, removed, or moved — only
the backing implementation of two existing rows changed), the phase split (ETA stays Phase 1, per
instruction), the `catchup-banner-stop` exclusion (untouched), the `h-screen` prerequisite, and every
other section not named above.
