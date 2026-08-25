# Blueprint — UI Design System & Triage Job-Details Overhaul

Slug: `ui-design-system` · Author: product-ui · 2026-08-25
Spec (authoritative): `spec.md` · UX dossier: `ux-notes.md` · Mockup: `mockup.html` (48 `data-qa` ids, S1–S12)
Backend contract: **no BE surface** — the BE stage was skipped (spec AC 14 forbids new API routes; the
archived state gets no Restore control per `ux-notes.md` §9/D11). Every data need in this blueprint
cites an existing type in `ui/src/lib/api/types.ts` or an existing route in
`src/app/features/board/routes.ts`, never an invented endpoint.

Classification carried from spec/UX: **change to existing.** Stack is inherited and settled (spec §4):
React 19, Vite, Tailwind v4 (`@theme` in `ui/src/index.css`), shadcn (`components.json` style
`radix-nova`) over Radix primitives via the `radix-ui` meta-package, CVA for variants, lucide-react
1.28, TanStack Query v5, a hand-rolled hash router, React Hook Form, sonner, Vitest + jsdom + Testing
Library, Playwright e2e over the `rajni` fixture (fixed port 4199). **Reuse-first is NOT suspended**
(this is not the greenfield case) — every mapping row below is checked against the actual inventory.

---

## 0. Stack Summary (with evidence)

| Layer | Fact | Evidence |
|---|---|---|
| Framework | React 19 function components, no class components anywhere touched | `ui/src/features/triage/TriagePage.tsx:36` |
| Styling | Tailwind v4 utility classes + CVA for variants; zero CSS-in-JS, zero CSS modules | `ui/src/components/ui/button.tsx:7-42` (`cva`), `ui/src/index.css:1-5` |
| Component library | shadcn components vendored into `ui/src/components/ui/` (Button, Badge, Card, Input, Select, Skeleton, Tabs, Accordion, Alert, RadioGroup, Popover, Dialog — confirmed by direct read of `button.tsx`, `badge.tsx`, `card.tsx`) | `ui/components.json`; files read directly |
| Routing | Hand-rolled hash router: `Route` discriminated union, `parseHash`/`routeHash`, `useRoute()` via `useSyncExternalStore` | `ui/src/lib/router.ts` (recon'd by executor-fast, confirmed against `TriagePage`/`JobPage` usage of `navigate({ name: 'job', id })`, `useTriageKeyboard.ts:64`) |
| Data fetching | TanStack Query v5 `queryOptions` factories in `ui/src/features/board/board.queries.ts:5-26`; fetchers in `board.api.ts:15-36`; hooks `useJobs`/`useJob`/`useMeta` in `useBoardData.ts:1-15`; tracking mutation with optimistic update in `useTracking.ts:46-93` | read directly |
| State | TanStack Query cache + component state only. One React Context (`SettingsSaveContext`) scoped to Settings, irrelevant to this slice. No zustand/jotai | executor-fast recon, confirmed no other providers in `main.tsx`/`App.tsx` |
| `ui/` → `src/core/**` seam | Only `src/core/datetime/index.ts` (9 call sites) and `src/core/normalize_token/index.ts` (1 site) are imported today, both zero-import files. **`src/core/tracking/vocab.ts` itself has zero imports** (confirmed by direct read, `src/core/tracking/vocab.ts:1-32` — no `import` statement anywhere in the file) — it satisfies the same dependency-free seam and is safe to import from `ui/`. This was PROVISIONAL in spec/`ux-notes.md`; **confirmed here.** | direct read |
| E2e harness | Playwright, `ui/e2e/*.spec.ts`, fixed port via `playwright.config.ts` webServer, seeded `profiles/rajni` DB (`seed.ts` globalSetup). **No dedicated triage spec exists today** — triage is covered by 5 tests inside `ui/e2e/smoke.spec.ts:36-97` (`board loads`, `sidebar branding`, `filter narrows`, `keyboard selection`, `decide persists`). Read directly — see §1 note below. | `ui/e2e/smoke.spec.ts:36-97` |
| File-size caps | 400 impl / 800 test over `ui/src/`, `ui/e2e/`. `DaemonCard.tsx` is at exactly 400 (`ui/src/features/operate/DaemonCard.tsx`, confirmed `wc -l` = 400) but **this spec makes zero edits to it** (grepped for every string this spec could touch — `text-[10px]`, `lane`, `Save`, `Skip` — zero matches), so it is not actually at risk from this work. See §7 file-size risk table for the files that *are* touched near-cap. | direct `wc -l` + grep |

**Load-bearing e2e read (per role brief, at minimum one):** `ui/e2e/smoke.spec.ts:86-97` (`decide persists`)
pins the exact triage decide flow this blueprint must not break: click a row → press `a` → the row's
`aria-selected` flips to `false` (**confirms auto-advance to the next undecided row is EXISTING,
tested behaviour** — `nextUndecided()` in `ui/src/features/triage/decide.ts:18-35`, wired at
`TriagePage.tsx:47-52`) → the row's `data-testid="job-row-status"` element carries
`title="Applied"` → after reload, the tracking `Status` combobox (`aria-label="Status"`) shows
`Applied`. Every rewritten component below preserves `data-testid="job-row"`, `data-job-id`,
`aria-selected`, `data-testid="job-row-status"` + its `title` attribute, `data-search-input` +
`aria-label="Search company"`, and the Status `SelectTrigger`'s `aria-label="Status"` — these are the
exact selectors `smoke.spec.ts` already pins (R25).

---

## 1. Judgment calls made locally (recorded here per role brief; not spec/UX authority)

**Orchestrator rulings, gate round 1 (2026-08-25) — both filed here, not silently absorbed:**

- **(a) Auto-advance to the next undecided row after a decision is KEPT.** `ux-notes.md`'s §11 weakness 1 explicitly says it "deliberately rejected auto-advance," but the shipped code already auto-advances (`nextUndecided()`, `ui/src/features/triage/decide.ts:18-35`, wired at `TriagePage.tsx:47-52`) and this is already e2e-pinned (`ui/e2e/smoke.spec.ts:86-97`, `decide persists` — pressing `a` flips `row1`'s `aria-selected` to `false`). The orchestrator ruled: keep the shipped behaviour — it is smaller blast radius (zero change to `decide()`/`nextUndecided()`) than reversing a working, tested mechanism to match a UX narrative that turns out to be inconsistent with its own dossier (see judgment call 2 below on why S5–S8 don't depict this either way). `ux-notes.md`'s rejection of auto-advance is overruled for this slice. Recorded again in §8, divergence 7.
- **(b) Excitement stays read-only** (judgment call 1 below, product-ui's own divergence 1) — **accepted by the orchestrator as filed**, no change.

1. **Excitement is read-only in the Tracking card, diverging from the mockup's interactive segmented
   control.** `TrackingPatchSchema` (`src/app/features/board/routes.ts:33-43`) is a `z.strictObject`
   with exactly 7 fields — `status`, `compRange`, `notes`, `contact`, `dateApplied`, `nextAction`,
   `nextActionDate`. **No `excitement` field exists or can be added without violating AC 14** ("no new
   API route, request field, or database column"). `JobFacts.tsx:4-6`'s own doc comment already states
   this: *"excitement is pipeline-owned, never an editable control... (spec correction)."*
   `ux-notes.md` D10 characterizes excitement as "a user-authored input, not machine evidence" —
   this is factually incorrect against the code; `excitement` is a pipeline-computed field on
   `BoardJobRow` (`src/ports/board.ts:143`), returned by `GET`, never accepted by `PATCH`. This is not
   a "needs a product/UX call" bounce — AC 14 is an unambiguous Must-level hard constraint that fully
   dictates the resolution (there is no design choice left to make), so I am not blocking on it. The
   `tracking-excitement` zone renders as a **read-only `Badge`** (matching `JobFacts.tsx`'s current
   treatment), positioned in the Tracking card per D10's ordering rationale (which is still valid,
   independent of writability). Recorded in Mockup Divergences §8.
2. **`#/job/:id` does not gain a `DecideBar`.** The mockup's S5–S8 frames use CSS class
   `detail-pane standalone` and each shows a decide-bar. `ux-notes.md` §1f's own "declared exceptions"
   table states the `.standalone` framing exists purely for **mockup scroll economy** ("Scroll-clipping
   so twelve frames fit one scrolling page. The app panes are viewport-height"), not to depict the
   `#/job/:id` route specifically. Spec's own scope fact (§5.4) names only `JobHeader`/`JobFacts` as
   shared with the job page — not `DecideBar` — and R33 (Won't) forbids redesigning the job page's IA.
   `JobPage.tsx` today has no `DecideBar` import at all (confirmed by read). I read S5–S8 as generic
   **triage detail-pane state studies** (JD-expanded, archived, sparse, decided), not as new
   `#/job/:id` chrome. `#/job/:id` keeps its current two-column composition
   (`ui/src/features/job/JobPage.tsx:63-72`) unchanged, receiving only the restyled shared
   sub-components (`JobHeader`, the `JobFacts`-successor zones, `JdText`). This satisfies R24/AC 12
   without an IA change.
3. **The pane's band-word/meter thresholds are not specified anywhere in `ux-notes.md`** (only the
   row's weight thresholds are explicit — "≥75 font-semibold · 50–74 font-medium · <50 font-normal",
   `ux-notes.md` §6). I infer the 4-tier pane band from the mockup's own worked examples (74→Good/3
   bars, 81→Good/3 bars, 51→Fair/2 bars, 39→Weak/1 bar): **`< 50` Weak (1 bar) · `50–69` Fair (2 bars)
   · `70–84` Good (3 bars) · `≥ 85` Strong (4 bars)**, `null` → em dash, no band, no bars. This is
   cosmetic labelling only (R18's Must is "labelled and scaled," satisfied by the `/100` suffix alone)
   — low risk, but flagged since it fills a genuine dossier gap rather than transcribing one.
4. **R26 (`j`/`k` navigation) is already shipped**, contradicting spec's framing of it as a Could not
   yet built. `useTriageKeyboard.ts:45-53` already handles `j`/`k`/arrows, and
   `ui/e2e/smoke.spec.ts:73-83` (`keyboard selection`) already pins it. No implementation step is
   needed for R26 — only preservation (R25).
5. **Two-pair rule is applied loosely, matching the existing `ui/` convention, not `src/`'s strict
   reading.** `ui/src/features/triage/` already holds 8 implementation files with no subfolder split
   or `index.ts` (`TriagePage.tsx`, `DecideBar.tsx`, `decide.ts`, `FilterPopover.tsx`, `JobList.tsx`,
   `JobRow.tsx`, `selection.ts`, `useTriageKeyboard.ts` — confirmed by `ls`). New per-zone files follow
   this same flat, colocated-test convention rather than being forced into subfolders.
6. **Tracking's `<details open>` accordion becomes a plain `Card`.** The mockup shows a static Card,
   never collapsed. The current `<details>` wrapper is always `open` in code today (no collapse ever
   exercised) — converting to `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent` is a pure
   restyle with no behaviour loss, and directly serves R23.
7. **Auto-advance to the next undecided row after a decision is KEPT — orchestrator ruling (a), gate round 1.** `ux-notes.md` §11 weakness 1 states it "deliberately rejected auto-advance," reasoning that a mis-press stays invisible if the pane replaces itself with the next job. The shipped code already does this: `nextUndecided()` (`ui/src/features/triage/decide.ts:18-35`) is called from `decide()` (`TriagePage.tsx:47-52`) on every `onDecide`, and it is already e2e-pinned (`ui/e2e/smoke.spec.ts:86-97`, `decide persists` — pressing `a` flips `row1`'s `aria-selected` to `false`, proving the selection already moves). Reversing this to match the dossier's narrative would mean touching a working, tested selection mechanism for a UX preference that the dossier's own S5–S8 frames don't actually depict either way (they are triage-detail-pane state studies rendered in isolation, per judgment call 2 above — none of them shows what happens to the LIST after a decision). The orchestrator ruled to keep the shipped mechanism unchanged: smaller blast radius, already tested, and the mockup does not actually contradict it. No implementation step touches `decide()`/`nextUndecided()`; steps 15–22 restyle around it. Recorded in §8, divergence 7.

---

## 2. Component Mapping

**Region count check:** the mockup carries **48 unique `data-qa` values** (verified:
`grep -oE 'data-qa="[^"]*"' mockup.html | sort -u | wc -l` → 48; two of them, `job-row` and
`job-row-pip`, are the documented repeating-row ids per `ux-notes.md` §13's "Repeat rule"). The table
below has **48 rows** — one per unique `data-qa` value. **48 = 48, confirmed matching.**

| data-qa | Mockup element | Real component (path) | Props / variants | Verdict | Design Scale values used |
|---|---|---|---|---|---|
| `mode-toggle` | Header-strip dark/light toggle button | — | — | **N/A — mockup-only.** R30 (Won't): no in-app toggle ships; this is explicitly a "review instrument" per the mockup's own copy | — |
| `triage-default` | S1 frame root | `ui/src/features/triage/TriagePage.tsx` (rewritten composition, same file) | `{ profile }` | existing (restyle) | `p-6` page padding, `gap-6` column gap |
| `triage-shell` | Two-pane flex container | `TriagePage.tsx` root `<div className="grid ...">` | — | existing | `gap-6` |
| `job-list` | List pane `<aside>` | `TriagePage.tsx`'s `<section>` list wrapper (unchanged structure) | — | existing | `w-[360px]` clamp `minmax(280px,360px)` (kept from current grid-cols, mockup's fixed 360px is the intent) |
| `job-row` *(×8, repeating)* | One row | `ui/src/features/triage/JobRow.tsx` (rewritten) | `{ row, selected, onSelect }` | existing (rewrite) | `text-sm`/`text-xs`, `py-1.5 px-3`→`py-2 px-3` (mockup), `tabular-nums` |
| `job-row-pip` *(×8, repeating)* | Status glyph | **new** `ui/src/features/triage/StatusPip.tsx` | `{ status: string \| null }` | **new** — no existing primitive renders a 5-state glyph+aria-label; smallest possible single-purpose component | `size-3` icon (`icon-3`) |
| `detail-pane` | Right pane Card | **new** `ui/src/features/triage/DetailPane.tsx` | `{ profile, detail, onDecide, ... }` | **new** — composes existing `Card` + new zone components; wraps zones in the shipped `rounded-xl ring-1` Card idiom, replacing the hand-rolled stack | `Card` (`rounded-xl` 22.4px, `ring-1 ring-foreground/10`) |
| `verdict-header` | Title + score + provenance | `ui/src/features/job/JobHeader.tsx` (rewritten) | `{ job }` | existing (rewrite) | `text-lg` title, `p-4` |
| `match-score` | MATCH / 74 / /100 / meter | **new** `ui/src/features/job/MatchScore.tsx`, used inside `JobHeader.tsx` | `{ score: number \| null }` | **new** | `text-micro` eyebrow, `text-2xl` hero, `text-xs` `/100` |
| `score-meter` | 4-bar meter | sub-element inside `MatchScore.tsx` (`data-qa="score-meter"` on a `<span>` wrapper) | — | new (part of MatchScore) | 12×3px bars (§1f exception, not a spacing step) |
| `provenance-line` | company · lane · date | sub-render inside `JobHeader.tsx` | — | existing (rewrite, new markup) | `text-sm text-muted-foreground` |
| `lane-label` | lane icon + display name | sub-render inside `JobHeader.tsx`, using **new** `ui/src/lib/vocabulary/lanes.ts` | `laneLabel(lane)`, `laneIcon(lane)` | new (vocab helper) + existing icon components | `text-sm`, `icon-3` |
| `signals` | Why it matches / Review flags zone | **new** `ui/src/features/job/JobSignals.tsx` (replaces `JobFacts.tsx`'s bullets) | `{ matchReasons, reviewFlags }` | **new** — reuse-first checked: no existing component renders two visually-asymmetric list kinds; `Badge`/`ul` alone can't express container+icon+rhythm asymmetry | `text-micro` eyebrows, `text-xs`/`text-sm` |
| `match-reasons` | reason chips | sub-render inside `JobSignals.tsx` | — | new (part of JobSignals) | `rounded-4xl` chip, `bg-success/10 text-success-strong` |
| `review-flags` | left-ruled flag block | sub-render inside `JobSignals.tsx` | — | new (part of JobSignals) | `border-l-2 border-destructive pl-3` |
| `eligibility` | 4-cell definition grid | **new** `ui/src/features/job/EligibilityGrid.tsx` | `{ locationCity, workType, seniority, timezone }` | **new** — reuse-first checked: `Card data-size="sm"` is existing, the 4-col grid content is new | `Card size="sm"` (12px padding), `gap-3` grid |
| `skills` | badge wrap + eyebrow | **new** `ui/src/features/job/SkillsList.tsx` | `{ skills: string[] }` | existing `Badge` reused; wrapper/cap logic is **new** | `Badge variant="secondary"`, `gap-2` |
| `skills-more` | "+4 more" toggle | sub-render inside `SkillsList.tsx` (`Button variant="ghost" size="xs"`) | — | existing `Button` reused | `btn-xs` |
| `jd` | Job description Card | `ui/src/features/job/JdText.tsx` (rewritten) | `{ jd, url, expanded, onToggleExpanded }` | existing (rewrite) | `Card`, `max-w-[68ch]` (§1f exception), `max-h-[240px]` clamp |
| `jd-toggle` | Show full/less button | sub-render inside `JdText.tsx` | — | existing `Button variant="ghost" size="sm"` reused | — |
| `tracking` | Tracking Card | `ui/src/features/job/TrackingPanel.tsx` (rewritten: `<details>` → `Card`) | `{ profile, job }` | existing (rewrite) | `Card`, `CardHeader`/`CardTitle`/`CardDescription` |
| `tracking-status` | Status select | sub-element inside `TrackingPanel.tsx` (existing `Select`, `aria-label="Status"` preserved) | — | existing | `Select` (`h-8 rounded-lg`) |
| `tracking-excitement` | Excitement display | sub-render inside `TrackingPanel.tsx` — **read-only `Badge`**, not the mockup's segmented control (see §1.1) | `{ excitement: string \| null }` | existing `Badge` reused (divergence: read-only, not interactive) | `Badge variant="secondary"` |
| `decide-bar` | Sticky Apply/Lead/Pass bar | `ui/src/features/triage/DecideBar.tsx` (rewritten) | `{ job, onDecide }` | existing (rewrite) | `sticky bottom-0`, `border-t bg-card px-4 py-2.5` |
| `decide-apply` | Apply button | sub-element inside `DecideBar.tsx` | — | existing `Button variant="default"` | `Check` icon, `<kbd>a</kbd>` |
| `decide-lead` | Lead button | sub-element inside `DecideBar.tsx` | — | existing `Button variant="outline"` | `Star` icon, `<kbd>s</kbd>` |
| `decide-pass` | Pass button | sub-element inside `DecideBar.tsx` | — | existing `Button variant="outline"` (was `destructive` — R23 fix) | `CircleSlash` icon, `<kbd>x</kbd>` |
| `decide-status-badge` | current status word | sub-element inside `DecideBar.tsx` | — | existing `Badge` | `Badge variant="outline"`/`"on-primary"`-equivalent |
| `triage-loading` | S2 frame root | `TriagePage.tsx` loading branch (both panes) | — | existing (restyle shape-matched skeletons) | `Skeleton` (`bg-muted rounded-md animate-pulse`) |
| `list-skeleton` | 6 skeleton rows | `TriagePage.tsx`'s existing `SKELETON_ROW_KEYS` loop (unchanged count — already 6, matches mockup) | — | existing | `Skeleton` |
| `triage-empty` | S3 frame root | `TriagePage.tsx` / `JobList.tsx` empty branch | — | existing (restyle + copy) | — |
| `list-empty` | "Nothing left to decide" | `ui/src/features/triage/JobList.tsx`'s `rows.length === 0` branch (copy updated; trigger condition unchanged — see §8 divergence) | — | existing (rewrite copy) | `CheckCircle2` icon |
| `triage-error` | S4 frame root | `TriagePage.tsx` error branches (both panes) | — | existing (restyle copy) | — |
| `list-error` | "Couldn't load your board" | `ui/src/features/shared/ErrorRetry.tsx` (existing, reused, copy updated) | `{ message, onRetry, padded }` | existing (copy-only change: "Retry"→"Try again") | `Button variant="outline" size="sm"` |
| `detail-jd-expanded` | S5 frame root | Same `JdText.tsx` in `expanded` state (no separate component — a state, not a screen) | — | existing (state of `jd`) | — |
| `detail-archived` | S6 frame root | `DetailPane.tsx` rendering `ArchivedStrip` + the rest | — | existing (state) | — |
| `archived-strip` | "Archived — out of the queue" strip | **new** `ui/src/features/job/ArchivedStrip.tsx` | `{ archived: boolean }` | **new** — replaces `JobHeader.tsx`'s current inline `' · Archived'` suffix + `opacity-60` | `bg-muted text-muted-foreground text-xs` |
| `detail-sparse` | S7 frame root | Same zone components in their empty-within-populated branches (no separate component) | — | existing (state) | — |
| `detail-decided` | S8 frame root | Same `DetailPane.tsx`/`DecideBar.tsx` in decided state (state, not a screen) | — | existing (state) | — |
| `triage-dark` | S9 frame root | **No new code** — `.dark` class already retints every semantic Tailwind class (`bg-card`, `text-foreground`, etc.) via `ui/src/index.css:118-163`. Verified by construction: this slice changes zero raw hex values | — | existing (proof-of-token-sync, not a build item) | all of §1a (unchanged) |
| `system-reference` | S10 frame root | **new** `docs/product/ui-design-system/reference.md` (doc, not code) | — | **new (doc)** — Q4/R4: no in-app gallery | — |
| `token-table-light` | Light colour swatches | `reference.md` §Colour — light | — | new (doc) | — |
| `token-table-dark` | Dark colour swatches | `reference.md` §Colour — dark | — | new (doc) | — |
| `type-ramp` | Type scale table | `reference.md` §Type ramp | — | new (doc) | — |
| `voice-rules` | 6 voice rules | `reference.md` §Voice | — | new (doc) | — |
| `glossary` | Glossary table | `reference.md` §Glossary | — | new (doc) | — |
| `adopt-strip` | S11 sketch panel | **N/A — mockup-only sketch.** Real adoption lands in each screen's existing files (§6 Adoption steps), not a new component | — | N/A | — |
| `status-legend` | S12 legend + greyscale proof | **N/A — mockup-only reference material** (Q4: no in-app legend). The 5 states it documents are built via `job-row-pip`/`StatusPip.tsx`, already covered above | — | N/A (states covered elsewhere) | — |

**Row count check: 48 rows above = 48 unique `data-qa` values in the mockup. Confirmed matching, per
the artifact contract.**

---

## 3. Layout & Composition

### Triage (`#/triage`) — `TriagePage.tsx`

Unchanged outer grid (`grid-cols-[minmax(280px,360px)_1fr]`, `TriagePage.tsx:97`) and unchanged data
layer (`useJobs`/`useJob`/`useMeta`/`useTriageSelection`/`useTriageKeyboard`/`decide()`/
`nextUndecided()` — none of this is touched; only the render tree of the right-hand section changes).

- Left pane: unchanged structure (`FilterPopover`, search `Input`, sort `Button`s, `JobList`,
  pagination). `JobRow` internals rewritten (pip swap, score band, lane in line 2). Sort-button unicode
  `↑`/`↓` (`TriagePage.tsx:126,135`) → lucide `ArrowUp`/`ArrowDown` (R16).
- Right pane: replaces the current `<div className="flex flex-col gap-6">` stack
  (`TriagePage.tsx:205-211`) with **one** `<DetailPane profile={profile} detail={detail}
  onDecide={decide} />`. `DetailPane.tsx` internally renders, top to bottom, in a `Card`
  (`rounded-xl ring-1`, own scroll, `max-h` viewport-bound not the mockup's `760px` scroll-clip — that
  clip is a mockup-only space-saving device per §1f):
  `ArchivedStrip` (conditional) → `JobHeader` (verdict-header, incl. `MatchScore` + provenance)
  → `JobSignals` → `EligibilityGrid` → `SkillsList` → `JdText` → `TrackingPanel` → sticky
  `DecideBar` (`position: sticky; bottom: 0`, matching C8/Fitts). This is R17's ordering, §10's
  content priority ranks 1–8, applied literally: score/signals first, eligibility next, skills, JD,
  tracking, decide-bar last but pinned via `sticky` so it never scrolls away.
- Responsive strategy: **unchanged from today** — this is a desktop-only local tool (`127.0.0.1`,
  single user); no breakpoint work is in scope (not asked by spec, not shown by mockup beyond the
  existing `lg:grid-cols-4` on the eligibility grid, which only affects that one internal grid, not
  page layout).

### `#/job/:id` — `JobPage.tsx`

**Unchanged 2-column grid** (`grid-cols-[1fr_360px]`, `JobPage.tsx:63`) — no `DetailPane` Card wrapper,
no sticky `DecideBar` (see §1.2). Left column keeps `JobHeader` + `JdText` (both now restyled, JD now
clamped/toggled here too — it is the same shared component; this is expected propagation per spec
§5.4's "for free" framing, not a new IA change). Right column keeps `JobFacts`'s **successor zones**
stacked (`JobSignals`, `EligibilityGrid`, `SkillsList`) + `TrackingPanel`, in that order (AC 12: "same
field ordering as the triage pane").

### Other 7 screens (runs, tracker, analytics, settings, setup/Operate, onboarding, and the
sidebar shell)

**Adoption only — zero layout/IA change** (R13, R33). Each site gets a mechanical swap: an off-scale
type utility → `text-micro`, or a raw lane identifier → the vocabulary module's display label, or (in
`DecideBar`'s case, already covered above) a banned synonym → its reserved word. No new component, no
new composition. See §6 Adoption steps for the exact file list.

---

## 4. State & Data

Every field cited below already exists on `BoardJobRow`/`BoardJobDetail`
(`src/ports/board.ts:134-156`), exposed through `ui/src/lib/api/types.ts:6-16`. **No BE surface** was
authored for this slice (by design — spec AC 14) and none of the following needs one:

| Data | Source | Notes |
|---|---|---|
| `job.title`, `job.company`, `job.url` | `BoardJobRow` (`src/ports/board.ts:137-139`) | unchanged |
| `job.score` | `BoardJobRow.score: number \| null` (`:146`) | drives `MatchScore`'s band/meter (client-derived, no new data — spec §5's own note) |
| `job.matchReasons`, `job.reviewFlags` | `BoardJobRow` (`:147-148`) | drives `JobSignals` |
| `job.locationCity`, `job.workType`, `job.seniority`, `job.timezone` | `BoardJobRow` (`:141-144`) | drives `EligibilityGrid` |
| `job.skills` | `BoardJobRow.skills: string[]` (`:145`) | drives `SkillsList` |
| `job.lane` | `BoardJobRow.lane: string` (`:136`) — **already returned, never rendered** (G5) | drives `lane-label` via `ui/src/lib/vocabulary/lanes.ts` |
| `job.dateFound` | `BoardJobRow.dateFound: string` (`:150`) | drives provenance line, via existing `formatInstant`/`formatInstantTitle` (`src/core/datetime/index.ts`, already imported at `JobHeader.tsx:1-4`) |
| `job.archived` | `BoardJobRow.archived: boolean` (`:151`) | drives `ArchivedStrip` |
| `job.tracking` | `TrackingRow \| null` (`:152`, extends `TrackingFields` — `src/core/tracking/fields.ts:11-19`) | drives `DecideBar`'s status badge + `TrackingPanel`'s form fields. **7 fields only**: `status`, `compRange`, `notes`, `contact`, `dateApplied`, `nextAction`, `nextActionDate` |
| `job.excitement` | `BoardJobRow.excitement: string \| null` (`:142`) | **read-only** — drives the `tracking-excitement` Badge; NOT part of `TrackingPatchBody` (confirmed, `src/app/features/board/routes.ts:33-43`) — see §1.1 |
| `jd.content.rawText` | `BoardJobDetail.jd: JD` (`:155`, `JD` type from `src/core/jd/index.ts`) | drives `JdText` — unchanged source, only render treatment changes |
| Write path | `PATCH /api/profiles/:name/jobs/:id/tracking` via `useTrackingMutation` (`ui/src/features/board/useTracking.ts:46-93`) | **the only** job write surface; `DecideBar`'s `onDecide` calls the existing `decide()` → `trackingMutation.mutate({ jobId, patch: { status: DECIDE_STATUS[action] } })` (`TriagePage.tsx:47-52`), unchanged |
| `meta.statusOptions`, `meta.excitementOptions` | `BoardMetaResponse` (`routes.ts:57-60`) via `useMeta` | unchanged, feeds `TrackingPanel`'s Status select and `FilterPopover` |
| Lane display labels | **new**, client-only, `ui/src/lib/vocabulary/lanes.ts` — a static `Record<string,string>` mirror, no data need | not a BE concern — purely a UI label lookup over the existing `lane: string` field |
| Frozen vocab (tracking statuses, excitement levels) | `src/core/tracking/vocab.ts:9-31` (`STATUS_OPTIONS`, `EXCITEMENT_OPTIONS`) — zero-import, UI-importable (confirmed §0) | mirrored, never renamed (R32) |
| Frozen stage names | `ui/src/features/runs/runProgress.ts:4-15` (`STAGE_ORDER`) | mirrored by the glossary reference doc, not duplicated as data |
| Frozen run-state phrases | `ui/src/features/runs/runOutcome.ts:57-79` (`outcomeLabel()`) | already correct; glossary cites it, doesn't touch it |

No row above has "the backend will provide this." Every value is already on the wire.

---

## 5. Vocabulary module (R7/R8/R9)

New folder `ui/src/lib/vocabulary/` (flat, matching §1.5's convention finding):

- **`triageActions.ts`** — `export const TRIAGE_ACTION_LABELS = { apply: 'Apply', save: 'Lead', skip:
  'Pass' } as const satisfies Record<DecideAction, string>` (imports `DecideAction` from
  `../../features/triage/decide.ts`). Consumed by `DecideBar.tsx`.
- **`lanes.ts`** — `export const LANE_LABELS: Record<string, string> = { linkedin: 'LinkedIn',
  greenhouse: 'Greenhouse', keka: 'Keka' }`; `export function laneLabel(lane: string): string` (falls
  back to the raw string for an unknown lane — never throws); `export function laneIcon(lane: string)`
  returning the lucide component (`Linkedin` for `linkedin`, `Building2` for everything else, matching
  the mockup's icon choices at `mockup.html:353,587,649,693,748`). Consumed by `JobHeader.tsx`,
  `JobRow.tsx`, and `WhereJobsComeFromSection.tsx` (R10 adoption).
- **`index.ts`** — re-exports both, plus re-exports `STATUS_OPTIONS`/`EXCITEMENT_OPTIONS` from
  `../../../../src/core/tracking/vocab.ts` (same relative-import shape `JobHeader.tsx:1-4` already
  uses for `datetime`), so every screen this slice touches has **one** import point (R8).
- **`bannedSynonyms.ts`** — the small, precise list (Q2's rider). Data only:
  ```ts
  export const BANNED_SYNONYMS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
    { pattern: />\s*Skip\b/, reason: '"Skip" — use "Pass" (R11)' },
    { pattern: />\s*Save\s*\(/, reason: '"Save (…)" as a decide-action label — use "Lead" (R11)' },
    { pattern: /[✓✗☆↑↓]/, reason: 'raw unicode glyph — use a lucide icon (R16)' },
  ];
  ```
  **Deliberately narrow**: the `Save` pattern only matches `Save(` (the exact shape of the current
  `☆ Save (s)` button label), never bare `"Save changes"` (Settings' save-bar verb, which must keep
  working — glossary §2's own stated rule). The `Skip` pattern matches `>Skip` (a JSX text-node open),
  not the substring "Skip" anywhere (which would false-positive on code comments/identifiers).
- **`bannedSynonyms.test.ts`** — the source-scan (R9), extending the exact idiom `tokens.test.ts`
  already uses (`readFileSync` + regex over raw source text, zero new dependency): glob every
  `ui/src/**/*.{ts,tsx}` (Node's `fs.readdirSync` recursive walk — no glob dependency needed, matching
  the zero-dependency mandate), for each `BANNED_SYNONYMS` pattern assert **zero matches** across the
  whole tree. **Dry-run requirement (spec §9, mandatory before this test is considered done):** run the
  scan against today's `ui/src/**` BEFORE deleting the `Skip`/`Save`/glyph sites it's meant to catch —
  it must fire on exactly the known sites (`DecideBar.tsx:20,23,26`, `TriagePage.tsx:126,135`) and
  nowhere else. If it fires anywhere else, the pattern is too broad and must narrow before the step is
  marked done.

---

## 6. Implementation Steps

Ordered to keep `npm run ui:check` / `npm run ui:e2e` green at every step. Each step names its file(s),
its done-condition, and — for every screen/state step — its e2e id **in the same step** (no trailing
"write e2e" step, per the state-pinning principle).

### Phase A — Tokens (foundation, no consumers yet)

1. **`ui/src/index.css`** — add to the existing `@theme` block (`:9-63`):
   ```
   --text-micro: 11px; --text-micro--line-height: 16px;
   --text-xs: 12px; --text-xs--line-height: 16px;
   --text-sm: 14px; --text-sm--line-height: 20px;
   --text-base: 16px; --text-base--line-height: 24px;
   --text-lg: 18px; --text-lg--line-height: 28px;
   --text-2xl: 24px; --text-2xl--line-height: 32px;
   ```
   (Tailwind v4's `--text-{name}`/`--text-{name}--line-height` theme-key convention, the same
   mechanism already used for `--radius-*` at `:54-60`.) Only `--text-micro` is new; the other five
   pin the *existing* de-facto values explicitly (R1/R14) — no visual change from pinning alone.
   **Done-condition:** `npm run ui:build` succeeds; `.text-micro` is a generated utility class
   (verify via a throwaway `<div class="text-micro">` in a scratch file rendering at 11px/16px, then
   remove the scratch file).
2. **`ui/src/lib/tokens.test.ts`** — extend with an `it.each` block asserting the 6 `--text-*`
   pairs above exist in `:root` (type is not mode-dependent, so no `.dark` duplicate needed — R3).
   **Done-condition:** `npm test -- tokens.test.ts` green, and editing any one `--text-*` value in
   `index.css` without updating this test fails it (spot-check: temporarily change one value, confirm
   red, revert).
3. **`--text-micro` consumers get `tracking-[0.04em]`, not `tracking-wide`.** No file edits yet in this
   step — recorded here as the exact class pairing every later `text-micro` consumption step must use:
   `className="text-micro font-medium uppercase tracking-[0.04em]"` (matches mockup exactly; Tailwind's
   built-in `tracking-wide` is 0.025em, a different value than the 5 existing `text-[10px]`/`text-[9px]`
   sites use today, so this is a deliberate, named 1–2px + tracking normalization, not silent drift).

### Phase B — Vocabulary module

4. **`ui/src/lib/vocabulary/triageActions.ts` + `.test.ts`** — as specified in §5. **Done-condition:**
   unit test asserts `TRIAGE_ACTION_LABELS.apply === 'Apply'`, `.save === 'Lead'`, `.skip === 'Pass'`.
5. **`ui/src/lib/vocabulary/lanes.ts` + `.test.ts`** — as specified in §5. **Done-condition:** unit
   test asserts `laneLabel('linkedin') === 'LinkedIn'`, `laneLabel('greenhouse') === 'Greenhouse'`,
   `laneLabel('keka') === 'Keka'`, and `laneLabel('unknown-lane') === 'unknown-lane'` (fallback, never
   throws).
6. **`ui/src/lib/vocabulary/index.ts`** — re-export surface as specified in §5. **Done-condition:**
   `import { TRIAGE_ACTION_LABELS, laneLabel, STATUS_OPTIONS, EXCITEMENT_OPTIONS } from
   '../../lib/vocabulary'` type-checks from any `ui/src/features/**` file.
7. **`ui/src/lib/vocabulary/bannedSynonyms.ts` + `bannedSynonyms.test.ts`** — as specified in §5,
   **including the mandatory dry-run**. **Done-condition:** the dry-run's finding (exact match sites)
   is recorded as a code comment above `BANNED_SYNONYMS`; the test is green against the CURRENT tree
   (i.e., it correctly fires only at the known `Skip`/`Save`/glyph sites — this step does NOT yet fix
   those sites, so the test is expected RED until step 12; this step's own done-condition is "the scan
   logic is correct and precise," verified by temporarily commenting out one known site and confirming
   the test goes green for that one pattern, then restoring it).

### Phase C — Shared zone primitives (`ui/src/features/job/`, `ui/src/features/triage/`)

Each is a single new file + colocated test, zero-judgment, independently buildable (no cross-deps
between these except on existing types).

8. **`ui/src/features/job/score.ts` + `.test.ts`** — `export type ScoreBand = 'Strong'|'Good'|'Fair'|
   'Weak'`; `export function scoreBand(score: number): ScoreBand` (`≥85`→Strong, `≥70`→Good, `≥50`→
   Fair, else Weak — §1 judgment call 3); `export function scoreSegments(score: number): number`
   (Strong→4, Good→3, Fair→2, Weak→1). **Done-condition:** unit test asserts the 4 worked examples
   from the mockup (74→Good/3, 81→Good/3, 51→Fair/2, 39→Weak/1).
9. **`ui/src/features/job/MatchScore.tsx` + `.test.tsx`** — `{ score: number | null }`. Renders the
   `MATCH` eyebrow (`text-micro`), hero (`text-2xl tabular-nums` + `text-xs` `/100`), and
   `data-qa="score-meter"` 4-bar meter (filled per `scoreSegments`) + band word (`text-micro`).
   `score === null` → em dash, eyebrow only, no meter (per mockup rule, never a bare `0`).
   **Done-condition:** unit test renders `score={74}` and asserts the text `74`, `/100`, `Good`, and 3
   filled bars are present; renders `score={null}` and asserts `—` with no meter element.
10. **`ui/src/features/triage/StatusPip.tsx` + `.test.tsx`** — `{ status: string | null }`. Maps to
    the 5-state glyph table (`ux-notes.md` §6): `null`→`Circle` hollow/muted, `Lead`→`Star` filled
    primary, `Applied`→`Send` primary, `Recruiter Screen`/`Tech Round`/`Onsite`/`Offer`→`ChevronsRight`
    (primary, success on `Offer`), `Passed`/`Rejected`→`Minus` destructive. Every branch carries
    `aria-label` = the status word (`"Not decided"` for `null`). **Done-condition:** unit test asserts
    all 5 branches render the correct lucide icon name and `aria-label`.
11. **`ui/src/features/job/JobSignals.tsx` + `.test.tsx`** — `{ matchReasons: string[], reviewFlags:
    string[] }`. Renders per the asymmetric-cue table (`ux-notes.md` §5 Zone 2): reason chips
    (`Check` icon, `bg-success/10 text-success-strong`, horizontal wrap) vs a `border-l-2
    border-destructive pl-3` flag block (`AlertTriangle` icon, vertical stack, `text-destructive-strong
    text-sm`). **Asymmetric empty handling** (not symmetric — §5 Zone 2's own rule): zero flags →
    the entire flags block is omitted (no eyebrow, no `· 0`); zero reasons → the eyebrow renders with
    no count, body reads *"No match reasons recorded."*; both zero → one muted line, nothing else.
    **Done-condition:** 4 unit-test branches — both populated, flags-only-empty, reasons-only-empty,
    both-empty — each asserting the exact DOM shape above (this is the flagship's central visual
    problem per spec §15 usability concern (a); get the branch coverage right here, not later).
12. **`ui/src/features/job/EligibilityGrid.tsx` + `.test.tsx`** — `{ locationCity, workType,
    seniority, timezone }: { [k: string]: string | null }`. `Card data-size="sm"` wrapping a
    `grid grid-cols-2 lg:grid-cols-4 gap-3` of 4 labelled cells (`LOCATION`/`WORK TYPE`/`SENIORITY`/
    `TIMEZONE`, `text-micro` labels over `text-sm font-medium` values). Missing value → `—` in
    `text-muted-foreground`, cell never removed (grid never reflows). **Done-condition:** unit test
    renders all-populated and all-null, asserting 4 cells present in both cases, `—` in the null case.
13. **`ui/src/features/job/SkillsList.tsx` + `.test.tsx`** — `{ skills: string[] }`. Eyebrow
    `SKILLS ASKED FOR · N`, `Badge variant="secondary"` wrap capped at 8 visible + a
    `data-qa="skills-more"` ghost `Button size="xs"` reading `+N more` (`aria-expanded` toggling all
    visible). Empty → one muted line *"No skills extracted."*, no card. **Done-condition:** unit test
    with 12 skills asserts exactly 8 badges + a `+4 more` button; clicking it reveals all 12 and the
    button's `aria-expanded` flips to `true`; 0-skills case asserts the muted-line fallback.
14. **`ui/src/features/job/ArchivedStrip.tsx` + `.test.tsx`** — `{ archived: boolean }`. `archived ===
    false` → renders nothing (`null`). `archived === true` → `bg-muted text-muted-foreground text-xs`
    strip reading *"Archived — this job is out of the queue."* **No Restore button** (§1 divergence
    D11/C13 — `archived` is not in `TrackingFields`, the only write is the tracking PATCH). **Done-
    condition:** unit test asserts `null` render for `false`, the exact strip text for `true`, and
    asserts no `<button>` element exists anywhere in the `true` render.

### Phase D — Wire the flagship (triage/job) — each step creates or appends its own e2e coverage
in-task (no trailing "assemble the suite" step — the state-pinning defect the gate flagged in round 1
is fixed by construction here: every screen/state step below ends with a `triage-redesign.spec.ts`
CREATE-or-APPEND and its own `npm run ui:e2e -- triage-redesign` gate)

15. **`ui/src/features/job/JobHeader.tsx` (rewrite in place)** — `{ job: BoardJobRow }`. Renders
    `ArchivedStrip` INSIDE `JobHeader.tsx` (so both the triage pane and `#/job/:id` get it for free) →
    title (`text-lg`, 2-line clamp) + `MatchScore` (right-aligned) on row 1; provenance line (company
    link with `ExternalLink` icon · `lane-label` via `laneIcon`/`laneLabel` · `Found {formatInstant}`
    `tabular-nums`, `title={formatInstantTitle}`) on row 2. **Done-condition + e2e:** **CREATE**
    `ui/e2e/triage-redesign.spec.ts` (new file — this step authors it) with its first test,
    **`e2e-triage-verdict-header`**: navigate `/#/triage`, select `rajni-e2e-1`, assert the
    `data-qa="match-score"` block contains `/100` text, the `data-qa="lane-label"` block contains a
    non-raw display label (e.g. `Greenhouse`, never `greenhouse`), and the company link's `href` still
    points at `job.url`. **Gate:** `npm run ui:e2e -- triage-redesign` green.
16. **`ui/src/features/job/JdText.tsx` (rewrite)** — `{ jd: BoardJobDetail['jd'], url: string,
    expanded: boolean, onToggleExpanded: () => void }`. `Card` wrapper, header-right `Open original ↗`
    link to `url`. Body `max-w-[68ch] text-sm leading-relaxed whitespace-pre-wrap`, clamped
    `max-h-[240px]` with a 48px bottom fade (`linear-gradient(to bottom, transparent, var(--card))`)
    when `!expanded`, `data-qa="jd-toggle"` `Button variant="ghost" size="sm"` reading `Show full
    description`/`Show less` with `ChevronDown`/`ChevronUp`, `aria-expanded={expanded}`. Empty JD →
    *"No description captured for this job."* + the `Open original ↗` link (the one case it's
    load-bearing). **Done-condition + e2e:** **APPEND** to `ui/e2e/triage-redesign.spec.ts`
    **`e2e-jd-expand`**: select a job with a long JD, assert the clamp wrapper has `max-height`
    styling, click `jd-toggle`, assert `aria-expanded="true"` and the clamp class is gone; select a
    **different** job, assert it renders already-expanded (session-sticky — `expanded` is owned by
    `TriagePage.tsx`, step 20, and passed down through `DetailPane`, step 19). **Gate:** `npm run
    ui:e2e -- triage-redesign` green.
17. **`ui/src/features/triage/DecideBar.tsx` (rewrite)** — `{ job, onDecide }`. Three `Button`s using
    `TRIAGE_ACTION_LABELS` from the vocabulary module: `decide-apply` (`variant="default"`, `Check`,
    `<kbd>a</kbd>`), `decide-lead` (`variant="outline"`, `Star`, `<kbd>s</kbd>`), `decide-pass`
    (`variant="outline"` — **not** `destructive`, `CircleSlash`, `<kbd>x</kbd>`). Active decision's
    button carries `aria-pressed="true"`. `decide-status-badge` shows the same word as the button that
    caused it (via `TRIAGE_ACTION_LABELS` reverse-lookup off `job.tracking?.status`, or simply render
    `job.tracking?.status ?? 'Not decided'` directly since the stored value already equals the display
    word post-R11). **Done-condition + e2e:** **APPEND** to `ui/e2e/triage-redesign.spec.ts`
    **`e2e-decide-labels`**: assert the three buttons read exactly `Apply`, `Lead`, `Pass` (never
    `Save`/`Skip`) and that `decide-pass` does NOT carry the `destructive` variant's classes. **Gate:**
    `npm run ui:e2e -- triage-redesign` green AND the EXISTING `ui/e2e/smoke.spec.ts:86-97` (`decide
    persists`) re-run unmodified, green (R25 — this is the pinning test for the underlying decide flow,
    which this step does not touch).
18. **`ui/src/features/triage/StatusPip.tsx` wired into `ui/src/features/triage/JobRow.tsx`
    (rewrite)** — replace `dotClass()`/the 6px dot with `<StatusPip status={row.tracking?.status ??
    null} />` in the existing `data-testid="job-row-status"` slot (**the `data-testid` and `title`
    attribute move onto `StatusPip`'s root span, preserved exactly** — R25). Score display gets the
    weight-band treatment (`≥75` `font-semibold`, `50–74` `font-medium`, `<50` `font-normal
    text-muted-foreground`, `tabular-nums`, `/100` suffix at `text-xs`). Line 2 gains
    `laneLabel(row.lane)` appended after the existing `company · location` text. **Done-condition +
    e2e:** **APPEND** to `ui/e2e/triage-redesign.spec.ts` **`e2e-row-lane-and-pip`**: assert
    `rajni-e2e-1`'s row text includes a lane display label and its `data-testid="job-row-status"`
    element has a non-empty `aria-label`. **Gate:** `npm run ui:e2e -- triage-redesign` green AND the
    EXISTING `ui/e2e/smoke.spec.ts:36-48` (`board loads`) and `:59-71` (`filter narrows`) re-run
    unmodified, green (R25 — both read `data-testid="job-row"` and rely on row count/company text,
    unaffected by the pip/lane swap).
19. **`ui/src/features/triage/DetailPane.tsx` (new)** — composes `JobHeader` (incl. `ArchivedStrip`) →
    `JobSignals` → `EligibilityGrid` → `SkillsList` → `JdText` (receives `jdExpanded`/
    `onToggleJdExpanded` as **props owned by `TriagePage.tsx`**, step 20 — `DetailPane` does not own
    this state itself, it only forwards it) → `TrackingPanel` → sticky `DecideBar`, inside a `Card`.
    Of the five states in `ux-notes.md` §5's "five states" table (default/loading/empty/error/success),
    **loading/empty/error are already handled one level up in `TriagePage.tsx`'s existing conditional
    branches** (unchanged logic), so `DetailPane` itself renders the **default**, **decided**
    (success), and **sparse** (empty-within-populated) cases — the optimistic `<400ms` badge flip and
    PATCH-failure revert are **already implemented** by `useTrackingMutation`'s `onMutate`/rollback
    (`useTracking.ts:46-93`); this step wires that existing state into the new badge, it does not
    re-implement optimistic update.

    **This step also adds the sparse e2e fixture**, since `pins e2e-triage-sparse` and no sparse job
    exists in today's 10-job fixture (all 10 are built via `makeJd()`, which always fabricates
    non-empty `skills`, non-empty `matchReasons`, and non-empty `content.rawText` — confirmed by direct
    read of `ui/e2e/fixtures.ts:29-66`):
    - In `ui/e2e/fixtures.ts`, add an 11th entry to `FIXTURE_JOBS`, built via `JDSchema.parse` directly
      (bypassing `makeJd()`), id **`rajni-e2e-11`**, `identity` only —
      `{ id: 'rajni-e2e-11', lane: 'greenhouse', url: 'https://example.com/jobs/rajni-e2e-11', company:
      'Nimbus Works', title: 'Backend Engineer (Contract)', scrapedAt: scrapedAt(10), location:
      'Remote' }` — with `content`, `structured`, and `evaluation` **all omitted** (all three are
      `.optional()` on `JDSchema`, confirmed `src/core/jd/schema.ts:82-85`, so this parses cleanly and
      yields `score: null`, `matchReasons: []`, `skills: []`, `workType`/`seniority`/`timezone: null`,
      `jd.content: undefined` — matching S7's sparse-job fields exactly, including its one populated
      `LOCATION: Remote` cell via `identity.location`). `hoursAgo: 10` keeps it oldest, appended last,
      so no existing fixture's relative order shifts. No `importTracking` entry for it — it stays
      "Not decided", matching S7's decide-bar.
    - `ui/e2e/seed.ts` needs **no change** — it already does `store.upsertJobs(FIXTURE_JOBS, now)` over
      the whole array, so the 11th job is picked up automatically.
    - **Update the 3 existing count assertions in `ui/e2e/smoke.spec.ts` that hard-code the total
      unfiltered row count** — `:39` (`board loads`, `toHaveCount(10)`), `:62` and `:70` (`filter
      narrows`, the two unfiltered `toHaveCount(10)` checks either side of the filter) — all three
      become `toHaveCount(11)` (R25: "any intentionally changed selector is updated in the same
      change"). Grep `toHaveCount(10)` across `ui/e2e/**/*.spec.ts` first to confirm these 3 are the
      only sites assuming the unfiltered rajni total (confirmed by this blueprint's own recon — no
      other spec file reads the raw triage list by count).

    **Done-condition + e2e:** **APPEND** to `ui/e2e/triage-redesign.spec.ts` three tests:
    **`e2e-triage-default`** (pins S1/`triage-default`): navigate `/#/triage`, select `rajni-e2e-1`,
    assert `detail-pane`, `verdict-header`, `signals`, `eligibility`, `skills`, `jd`, `tracking`,
    `decide-bar` all render in that DOM order (`data-qa` selectors, `toBeVisible()` + relative DOM
    position). **`e2e-triage-decided`** (pins S8/`detail-decided`): press `a`, assert
    `decide-status-badge` reads `Applied` within 400ms and `decide-apply` carries
    `aria-pressed="true"`. **`e2e-triage-sparse`** (pins S7/`detail-sparse`): select `rajni-e2e-11`,
    assert `signals` renders the single muted line *"No match reasons recorded."* with no
    `review-flags` element present, `skills` renders *"No skills extracted."* with zero `Badge`
    elements, `jd` renders *"No description captured for this job."* with the `Open original ↗` link
    still present, and `eligibility`'s `LOCATION` cell reads `Remote` while `WORK TYPE`/`SENIORITY`/
    `TIMEZONE` all read `—`. **Gate:** `npm run ui:e2e -- triage-redesign` green AND the full
    `ui/e2e/smoke.spec.ts` suite green with the 3 updated counts (11, not 10).
20. **`ui/src/features/triage/TriagePage.tsx` (compose)** — replace the current
    `<div className="flex flex-col gap-6">…</div>` block (`:205-211`) with `<DetailPane profile=
    {profile} detail={detail} onDecide={decide} jdExpanded={jdExpanded} onToggleJdExpanded=
    {() => setJdExpanded((v) => !v)} />`; **owns** `jdExpanded` `useState<boolean>(false)` here (resets
    on remount/reload — matches "no storage" — and persists across `select()` calls within the session
    since it's not tied to `selectedId`). Sort-button unicode → lucide (§3). **Done-condition + e2e:**
    **APPEND** to `ui/e2e/triage-redesign.spec.ts` **`e2e-triage-loading`** (pins S2/`triage-loading`):
    intercept the jobs-list fetch via `page.route('**/api/profiles/rajni/jobs*', ...)` — the same
    `page.route`/`route.fulfill` idiom `ui/e2e/operate.spec.ts:41-57` already uses elsewhere in this
    suite — delaying resolution by ~300ms before calling `route.continue()`; navigate to `/#/triage`
    and, within that delay window, assert `list-skeleton` is visible; then let the route resolve and
    assert `job-row` elements have replaced it. **Gate:** `npm run ui:e2e -- triage-redesign` green AND
    the full existing `ui/e2e/smoke.spec.ts` suite (all 12 specs, counts updated per step 19) green —
    this is the composition step's regression gate (R25).
21. **`ui/src/features/job/JobPage.tsx` (adjust)** — swap `JobFacts` for
    `JobSignals`+`EligibilityGrid`+`SkillsList` in the right column, in that order; `JdText` gains its
    new props (`url={jobQuery.data.url}`, local `expanded` `useState<boolean>(false)`, no session
    stickiness needed — single job). **Done-condition + e2e:** **APPEND** to
    `ui/e2e/triage-redesign.spec.ts` **`e2e-job-page-order`** (pins R24/AC 12): navigate directly to
    `/#/job/rajni-e2e-1`, assert `verdict-header`, `signals`, `eligibility`, `skills` all render and
    DOM-precede the `jd` region relative to their triage-pane counterparts' ordering (same relative
    order as step 19's `e2e-triage-default` assertion, applied to this route). **Gate:** `npm run
    ui:e2e -- triage-redesign` green AND the EXISTING `ui/e2e/smoke.spec.ts:160-174` (`full-page detail
    + back`) re-run unmodified, green.
22. **`ui/src/features/job/TrackingPanel.tsx` (rewrite)** — `<details>` → `Card`/`CardHeader`/
    `CardTitle` (*"Tracking"*) `/CardDescription` (*"Fill this in after you decide."*)/`CardContent`.
    Add the read-only excitement `Badge` (§1.1) inside `CardContent`, below the grid. All existing
    commit-on-blur/change logic, `fieldPatch`, `mutation.isPending` "Saving…" indicator: **unchanged**.
    `aria-label="Status"` on the Status `SelectTrigger`: **preserved exactly** (R25). No new e2e id
    owned by this step — the underlying commit/reload behaviour is already pinned by `smoke.spec.ts:
    86-97` (re-run at step 17) and this step's own visual change (`<details>`→`Card`) is covered by
    `e2e-triage-default`'s `tracking` DOM-order assertion (step 19). **Done-condition:** extend (don't
    replace) the existing `ui/src/features/job/TrackingPanel.test.tsx` unit suite for the Card markup +
    the read-only excitement badge; re-run `ui/e2e/smoke.spec.ts:86-97` unmodified, green.
23. **Verification only — no new tests authored in this step.** Run, in order: `npm run ui:e2e` (full
    suite — every spec file including the now-complete `ui/e2e/triage-redesign.spec.ts` assembled
    incrementally across steps 15–21), `npm run ui:check` (typecheck + lint + `ui:build`), and
    `npm run check` (the root gate — `src/` + `ui/` + boundaries, confirms nothing outside `ui/` broke,
    e.g. the `fixtures.ts`/`seed.ts` touch in step 19 stays inside its sanctioned boundary exception).
    **Done-condition:** all three commands exit 0. This step exists purely to confirm the tree is green
    end to end — it is a gate, not a construction step, and it authors zero new test code (the state-
    pinning defect this replaces is fixed by steps 15–21 owning their own tests in-task).


### Phase E — Adoption pass (R13, mechanical, no IA change)

24. **`ui/src/features/settings/sections/WhereJobsComeFromSection.tsx:233`** — `{lane}` →
    `{laneLabel(lane)}` (import from `../../../lib/vocabulary`). **Done-condition:** existing
    `ui/e2e/settings.spec.ts`/`settings-where-you-work.spec.ts` (if they assert checkbox label text)
    still pass; visually the three checkboxes now read `LinkedIn`/`Greenhouse`/`Keka`.
25. **`ui/src/features/settings/SettingsNav.tsx:106`**,
    **`ui/src/features/operate/SetupHealthCard.tsx:181`**,
    **`ui/src/features/runs/detail/DiagnosisPanel.tsx:166`**,
    **`ui/src/features/runs/detail/StageRail.tsx:115`** — each `text-[10px] uppercase tracking-wide`
    → `text-micro` (drops the now-redundant `uppercase tracking-wide`, since `text-micro` already
    bundles them per step 1's generated utility — **note:** since `--text-micro` only generates
    size+line-height via Tailwind's theme mechanism, `uppercase tracking-[0.04em] font-medium` stay as
    separate utility classes alongside `text-micro`, per step 3). **Done-condition:** `npm run
    ui:check` (biome + typecheck) green; no `text-[` arbitrary-size utility remains in these 4 files
    (`grep -n 'text-\[' <file>` returns nothing).
26. **`ui/src/features/runs/detail/FunnelTable.tsx:110`** — `text-[9px] font-normal` → `text-micro`
    (drops the now-covered `font-normal`... note `text-micro`'s generated weight is unset by Tailwind's
    theme mechanism — keep `font-medium` per the token's own definition, or `font-normal` if visually
    required; verify against the rendered funnel superscript badge and pick whichever matches today's
    visual weight, recorded as an executor judgment call if it differs). **Done-condition:** same as
    step 25, applied to this one file.
27. **`ui/src/features/shared/ErrorRetry.tsx:19`** — button label `Retry` → `Try again` (imperative
    verb + object, matches mockup S3/S4 exactly, voice rule 3). **Done-condition:** every consumer
    (`TriagePage.tsx`, `RunsPage.tsx` per the component's own doc comment) shows `Try again`; re-run any
    e2e that asserts the literal string `Retry` and update it in the same change (R25's "any
    intentionally changed selector is updated in the same change").
28. **`ui/src/features/runs/**`** (Runs screen, sketch S11) — **no file changes required.**
    `outcomeLabel()` (`runOutcome.ts:57-79`) already emits the exact reserved words (`"Ran with
    warnings"`, `"Failed at `structure`"`, etc.) — confirmed by direct read. This step exists only to
    record that the audit was done and found nothing to change (R13's "adoption, not redesign" — Runs
    was already compliant).
29. **`ui/src/features/tracker/**`** (Tracker screen, sketch S11) — **no file changes required.**
    `grouping.ts:8` already mirrors `TERMINAL_STATUSES` from `src/core/tracking/vocab.ts`; status
    strings render verbatim from `statusOptions` (already the frozen set). Recorded as an audited
    no-op, same reasoning as step 28. (Reusing `StatusPip` inside `KanbanCard.tsx`'s status icon is
    explicitly **out of scope** here — it would be a Kanban card IA change, not adoption; not requested
    by any Must.)
30. **`ui/src/features/operate/**`** (Operate/setup screen, sketch S11) — covered by step 25
    (`SetupHealthCard.tsx`). No further changes: `DaemonCard.tsx` audited in §0, zero matches, zero
    edits.

### Phase F — Reference document (R4, machine-checked)

31. **`docs/product/ui-design-system/reference.md` (new)** — sections, in order: Colour (light + dark
    tables, transcribed from `ui/src/index.css:65-163` — **not** re-derived by eye, copy the literal
    hex strings), Contrast pairs (the 11-row table from `ux-notes.md` §1a, unchanged — colours are not
    changing in this slice, so the ratios don't need recomputation, only citation), Type ramp (the 6
    steps from `index.css`'s new `@theme` tokens, step 1), Spacing & radii (Tailwind's 4px grid +
    `--radius-*`, unchanged, transcribed from `index.css:54-60`), Voice (the 6 rules, verbatim from
    `ux-notes.md` §2), Glossary (the 11-row table, verbatim from `ux-notes.md` §2, including the
    banned-synonym column — this is the human-readable mirror of `bannedSynonyms.ts`; the two must list
    the same reserved words). **Done-condition:** no step yet machine-checks this — see step 32.
32. **`ui/src/lib/tokens.test.ts` extended (second pass)** — add assertions that
    `docs/product/ui-design-system/reference.md`'s literal text contains each of the 6 `--text-*`
    values and each of the glossary's reserved words (read the `.md` file as raw text, `toContain()`
    checks — same zero-dependency idiom). **Done-condition:** editing a value in `reference.md` without
    updating `index.css` (or vice versa) fails this test — demonstrated once, then reverted, per AC 5's
    own requirement ("editing a token value in `index.css` without updating the document... fails the
    test").

---

## 7. File-size risk table

| File | Current lines | After this slice (estimate) | Risk | Split plan |
|---|---|---|---|---|
| `TriagePage.tsx` | 220 | ~200 (shrinks — the `<div className="flex flex-col gap-6">` stack of 5 components collapses to one `<DetailPane>` call, offset by the lifted `jdExpanded` state + lucide icon swaps) | none | — |
| `DecideBar.tsx` | 31 | ~55 | none | — |
| `JobRow.tsx` | 60 | ~75 | none | — |
| `JobHeader.tsx` | 39 | ~70 (absorbs provenance line + lane label + `ArchivedStrip` composition) | none | if it approaches 150+, extract the provenance-line JSX into its own small file — not needed at current estimate |
| `TrackingPanel.tsx` | 174 | ~185 (Card wrapper is roughly line-neutral vs `<details>`; +excitement badge) | none | — |
| `JdText.tsx` | 12 | ~55 | none | — |
| `DetailPane.tsx` | 0 (new) | ~60 (pure composition, no logic) | none | — |
| `MatchScore.tsx`, `StatusPip.tsx`, `JobSignals.tsx`, `EligibilityGrid.tsx`, `SkillsList.tsx`, `ArchivedStrip.tsx` | 0 (new) | 30–70 each | none | each is single-zone by construction — this is the split plan |
| `DaemonCard.tsx` | 400 (at cap) | 400 (untouched — §0 confirmed zero matches for any string this slice edits) | **none from this slice**; still zero headroom for any *other* future change | out of scope here; flag stands for the next feature that touches it |

No file this slice creates or edits is within 100 lines of the 400 cap. The spec's own flagged risk
(§11 blast-radius table: "Files near the 400-line cap may need the two-pair split") does not
materialize — the split-by-zone architecture in Phase C keeps every new file small by construction.

---

## 8. Mockup Divergences

| # | What the mockup shows | What ships | Justification (feasibility gate) |
|---|---|---|---|
| 1 | `tracking-excitement`: 3-button interactive segmented control, `aria-pressed` states | Read-only `Badge` displaying `job.excitement` | AC 14 hard constraint — `excitement` is not in `TrackingPatchSchema` (`src/app/features/board/routes.ts:33-43`) and adding it would be a new request field, forbidden. Not a design choice; §1.1. **Orchestrator ruling (b), gate round 1: accepted as filed, no change.** |
| 2 | S5–S8 `detail-pane standalone` frames each include a `decide-bar` | `#/job/:id` (`JobPage.tsx`) never renders a `DecideBar` | §1.2 — the `.standalone` CSS class is a documented mockup-only scroll-economy device (`ux-notes.md` §1f), not a depiction of the job-page route; R33 protects the job page's IA; spec's own scope fact names only `JobHeader`/`JobFacts` as shared. |
| 3 | `mode-toggle` header button | Not built | R30 (Won't), and the mockup's own copy says "review instrument only — no theme toggle ships." |
| 4 | S10 (`system-reference`), S11 (`adopt-strip`), S12 (`status-legend`) render as HTML/CSS panels inside the mockup | S10 → `docs/product/ui-design-system/reference.md` (a doc); S11/S12 → no shipped artifact at all (S11 is proof-of-scope for adoption steps already covered by real files; S12's legend is explicitly not shipped per Q4) | Q4: "canonical reference document... No in-app gallery." The mockup renders everything because mockups always render every frame; the product deliverable for these three frames is documentation/audit, not a component. |
| 5 | S1's list pane and detail pane are `max-height: 760px` with internal scroll | The real panes are viewport-height, unclamped | `ux-notes.md` §1f's own declared exception: "Scroll-clipping so twelve frames fit one scrolling page. The app panes are viewport-height." Not a real constraint. |
| 6 | `triage-empty` (S3) implies the row list can be non-empty while `undecidedCount` is 0 ("your last run added 11 jobs; you've decided on all of them") | The empty branch triggers on `rows.length === 0` (today's exact condition, copy updated only) | Changing the trigger to "0 undecided but rows.length > 0" would be a default-query/IA change (filtering behaviour) beyond restyle, not requested by any Must and not evidenced by any R. Recorded as an assumption in §1, not silently redesigned around. |
| 7 | `ux-notes.md` §11 weakness 1 says auto-advance was "deliberately rejected" | The shipped auto-advance-to-next-undecided-row (`decide.ts:18-35`, wired at `TriagePage.tsx:47-52`) is KEPT unchanged | **Orchestrator ruling (a), gate round 1.** The mechanism is already shipped and already e2e-pinned (`ui/e2e/smoke.spec.ts:86-97`); S5–S8 don't actually depict list behaviour either way (they're isolated detail-pane state studies per divergence 2); reversing a working, tested mechanism to match a UX narrative is larger blast radius than keeping it. §1 item 7. |

---

## 9. Requirements Coverage

| Req | MoSCoW | Step(s) | e2e id (screen/state Musts) |
|---|---|---|---|
| R1 (type scale, tokens) | Must | 1, 2 | — (token-level, pinned by `tokens.test.ts`, not a screen state) |
| R2 (colour documented, AA both modes) | Must | 31 (reference.md), no code change — colours unchanged | — |
| R3 (tokens.test.ts extended) | Must | 2, 32 | — |
| R4 (canonical reference doc, machine-checked) | Must | 31, 32 | — |
| R5 (tabular numerals) | Should | 9, 15, 18 (MatchScore, JobHeader, JobRow all use `tabular-nums`) | `e2e-triage-verdict-header` |
| R6 (voice rules) | Must | 31 (doc); 27 ("Try again") | — |
| R7 (glossary of reserved words) | Must | 5, 6, 31 | — |
| R8 (glossary as code, `ui/src/lib/vocabulary/`) | Must | 4, 5, 6 | — |
| R9 (Vitest source-scan, banned synonyms) | Must | 7 | — |
| R10 (lane display labels, never raw) | Should | 5, 15, 18, 24 | `e2e-row-lane-and-pip` |
| R11 (Apply/Lead/Pass relabel) | Must | 4, 17 | `e2e-decide-labels`, `smoke.spec.ts:86-97` (unmodified) |
| R12 (shortcut hints correct, keys unchanged) | Must | 17 (labels only — `useTriageKeyboard.ts` untouched) | `smoke.spec.ts:73-83` (unmodified, R25) |
| R13 (all 8 screens adopt tokens+vocab) | Must | 15–30 | full `npm run ui:e2e` green (step 23) |
| R14 (5 off-scale values eliminated) | Must | 25, 26 | `npm run ui:check` grep-for-`text-[` gate |
| R15 (state never colour-alone) | Must | 10 (StatusPip shape), 9 (MatchScore meter+weight), 11 (JobSignals container+icon+rhythm) | `e2e-triage-default`, `e2e-row-lane-and-pip` |
| R16 (lucide only, no raw glyphs) | Should | 17 (DecideBar icons), 20 (sort-button arrows), 7/formalized by the banned-synonym glyph pattern | `e2e-decide-labels` |
| R17 (pane ordered by decision) | Must | 19, 21 | `e2e-triage-default`, `e2e-job-page-order` |
| R18 (score labelled + scaled) | Must | 9, 15 | `e2e-triage-verdict-header` |
| R19 (reasons/flags visually distinct) | Must | 11 | covered by `e2e-triage-default`'s `signals` assertion + `JobSignals.test.tsx`'s 4-branch unit coverage |
| R20 (lane surfaced) | Must | 5, 15 | `e2e-triage-verdict-header` |
| R21 (JD measure-capped, disclosed) | Must | 16 | `e2e-jd-expand` |
| R22 (list status not colour-only) | Must | 10, 18 | `e2e-row-lane-and-pip` |
| R23 (shared `Card`, Pass not destructive) | Should | 19 (Card), 17 (Pass variant), 22 (TrackingPanel Card) | `e2e-decide-labels`, `e2e-triage-default` |
| R24 (`#/job/:id` verified, shared components) | Must | 21 | `e2e-job-page-order`, `smoke.spec.ts:160-174` (unmodified) |
| R25 (existing e2e selectors keep passing) | Must | every step's "re-run unmodified" clause | `smoke.spec.ts` full suite (step 20's gate) |
| R26 (`j`/`k` navigation) | Could | **already shipped** — no step needed (§1 judgment call 4) | `smoke.spec.ts:73-83` (pre-existing) |
| R27, R28, R29, R30, R31, R32, R33 | Won't | not built | — |

**Should-level coverage (spec also lists these, included for completeness):** R5, R10, R16, R23 — all
mapped above.

No Must is unmapped.

---

## 10. Risks & Assumptions

- **Assumption (§1.6):** converting `TrackingPanel`'s `<details open>` to a plain `Card` is safe
  because the accordion is never collapsed in current usage (confirmed by read — no `open={false}`
  anywhere, no test asserts collapse behaviour). If a future change relies on collapsibility, that's a
  new requirement, not a regression from this slice.
- **Assumption (§8 divergence 6):** `triage-empty`'s trigger condition stays `rows.length === 0`
  rather than `undecidedCount === 0`. If the orchestrator judges the mockup's copy ("you've decided on
  all of them") to require the latter, that's a scope addition needing its own Must/AC, not something
  this blueprint invents.
- **Risk:** `FunnelTable.tsx:110`'s exact font-weight after the `text-[9px]`→`text-micro` swap (step
  26) isn't fully determined by the token (Tailwind's `--text-*` theme keys don't carry weight) —
  flagged for the executor to visually confirm against today's render rather than assume.
- **Risk (inherited from spec §11):** R13/R14's sweep touches file text across the whole tree via the
  banned-synonym scan (step 7) and 6 mechanical swap sites (steps 25–27). Mitigated by: the scan's
  narrow, dry-run-verified patterns (step 7); every swap site has an exact `file:line` citation (no
  grep-and-hope); and the full existing e2e suite re-runs unmodified at steps 20/23 as the regression
  gate.
- **Out of this blueprint's control:** the riskiest assumption named in spec §9 ("that a self-imposed
  source-scan gate survives contact with its own author") is a product/process risk, not an engineering
  one — nothing in this blueprint can mitigate it further than the dry-run discipline already built
  into step 7.

---

## 11. Engineering Quality Gates

- **Determinism:** every new component (`MatchScore`, `StatusPip`, `JobSignals`, `EligibilityGrid`,
  `SkillsList`, `ArchivedStrip`) is a pure function of props — no internal data fetching, no `Date.now()`
  inside render (dates are pre-formatted by the caller via existing `formatInstant`). Same `job` props
  → same render, always. `JdText`'s `expanded` is a controlled prop, not internal state, for the same
  reason.
- **Fault tolerance:** the existing error boundary is at `TriagePage.tsx`'s query-level branches
  (`isError`/`detailQuery.isError`, unchanged) — one broken job's `detailQuery` failure shows
  `ErrorRetry` in the detail pane only; the list pane keeps working (existing behaviour, preserved).
  `TrackingPanel`'s PATCH failure surfaces inline (`aria-invalid` + `text-destructive-strong` message,
  value retained) via the existing `useTrackingMutation` rollback — unchanged mechanism, restyled
  presentation only.
- **Design-token sync:** zero hardcoded hex in any new/rewritten file — every colour is a semantic
  Tailwind class (`bg-success/10`, `text-destructive-strong`, `bg-muted`, etc.) resolving through
  `ui/src/index.css`'s `:root`/`.dark` blocks; every spacing/size value in Phase C/D components is
  drawn from `ux-notes.md`'s Design Scale (§1b type ramp, §1c 4px spacing grid, §1d radii) — no
  arbitrary `text-[Npx]` introduced anywhere by this slice (that's the whole point of R14).
- **Micro-optimizations:** `JobRow` (rendered ×N per list, N ≤ 50 per `DEFAULT_QUERY.limit`) stays a
  single flat DOM tree per row (`StatusPip` adds one `<span>`+`<svg>`, replacing the old dot `<span>` —
  net +1 node per row, not a re-render trigger since `JobRow` already re-renders only on
  `selected`/`row` prop change, unchanged). `MatchScore`'s 4-bar meter is 4 static `<span>`s, no
  animation, no re-render cost beyond the parent's own score-change re-render. No new `useEffect` is
  introduced anywhere in Phase C — every new component is prop-driven.
- **Asynchronous UX:** the loading skeleton (S2/`triage-loading`) wires to `jobsQuery.isPending`
  (list) and `detailQuery.isPending` (detail) — both pre-existing TanStack Query states, no new fetch
  introduced. The optimistic `<400ms` decide-badge flip (S8/`detail-decided`) wires to
  `useTrackingMutation`'s existing `onMutate` optimistic cache write (`useTracking.ts:46-93`) — this
  slice restyles the badge that reflects that state, it does not touch the mutation's optimistic-update
  mechanism.

---

## 12. Mockup conformance — final check

Re-read against the mockup after drafting this blueprint:
- Decide bar: exactly 3 buttons (Apply/Lead/Pass) — matches, no 4th button invented.
- Eligibility grid: exactly 4 cells (Location/Work type/Seniority/Timezone) — matches.
- Skills: cap 8 + "+N more" — matches.
- List rows: no meter in the row (only in the pane) — matches; row score is text+weight only, per
  `ux-notes.md` §6's explicit (different) thresholds from the pane's band — both honoured, not
  conflated (§1 judgment call 3 documents why they differ).
- Job-row-pip and job-row are the only two repeating ids; every other id resolves to exactly one
  element — matches §2's row-count check.
- Three load-bearing, justified departures (excitement writability, job-page decide-bar, auto-advance kept over the dossier's rejection of it — the last two now orchestrator-ruled, gate round 1) are all listed in §8, not silently built around; the remaining four rows in §8 are administrative (mockup-only chrome, doc-vs-component mapping) rather than behavioural.

No rule in this blueprint contradicts what the mockup shows beyond the seven divergences in §8.
