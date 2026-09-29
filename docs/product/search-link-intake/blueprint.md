# Blueprint (UI) — search-link-intake

Slug `search-link-intake` · Author: product-ui · 2026-09-28 · Mode: UNATTENDED (every open
implementation call is decided below, logged as ASSUMED (unattended); no question is left open —
no conflict found against spec.md/ux-notes.md/blueprint-be.md, so no blocked verdict is returned).
Inputs: `spec.md`, `ux-notes.md`, `mockup.html`, `blueprint-be.md`, `.state.md` (all in this
directory), `docs/product/personas.md`.

**Classification: change to existing.** `ui/` is a mature React SPA already implementing 11 of the
12 Settings sections and the full run-detail surface this feature extends — reuse-first applies in
full; no conventions-authoring mode.

---

## 1. Stack Summary

Evidence is a direct read of this pass (not `.state.md`'s BE-layer digest, which covers the server
side only).

- **Framework/build:** React 19, Vite (`ui/package.json`), TypeScript strict (erasable-syntax-only,
  matching CLAUDE.md). No build step beyond `vite build` → `ui/dist/`.
- **Styling:** Tailwind v4 via `@theme inline` in `ui/src/index.css` — every ux-notes §1 Design
  Scale token exists verbatim as a CSS custom property: `--background`/`--foreground`/`--card`/
  `--muted`/`--muted-foreground`/`--border`/`--primary`/`--ring` (`ui/src/index.css:68-103`),
  `--success`/`--success-strong` (:96,98), `--destructive`/`--destructive-strong` (:83,92),
  `--attention`/`--attention-strong` (:93,95), `--sidebar`/`--sidebar-accent` (:110,114),
  `--radius-sm`/`--radius-lg`/`--radius-xl`/`--radius-4xl` (:54-60). A separate `--amber`/
  `--amber-foreground` token also exists (`ui/src/index.css:99-100,147-148`) with **different**
  hex values from `--attention` — `DiagnosisPanel.tsx`'s existing warning tint uses `amber`, not
  `attention`. This feature's new attention-tinted surfaces (R13 notice, duplicate/misfile row
  notes, the run-detail bad-links panel) use `--attention`/`--attention-strong` per ux-notes §1,
  deliberately distinct from `DiagnosisPanel`'s `amber` register (see §2 row `run-bad-links-panel`).
- **Routing:** hash-based custom router, no React Router (`ui/src/lib/router.ts:1-84`).
  `navigate({ name: 'settings', section: 'where-jobs-come-from' })` → `#/settings/where-jobs-come-from`
  (`:63-64,68-70`); `SettingsSection` already lists `'where-jobs-come-from'` (`:17`) — no route change
  needed anywhere in this blueprint.
- **State/data-fetching:** TanStack React Query v5. Every config doc round-trips through
  `configDocQuery`/`useConfigMutation` (`ui/src/features/settings/config.queries.ts`,
  `ui/src/features/settings/useConfigMutation.ts:14-22`) — `useConfigMutation`'s `mutationFn` is
  `putConfigDoc`, and `onSuccess` writes the PUT response straight into the query cache
  (`useConfigMutation.ts:18-19`), so a widened PUT response (BE blueprint Step 7) is available to
  the caller as `mutation.data` for free. Dirty-tracking is `useSectionSaveState`
  (`ui/src/features/settings/save/useSectionSaveState.ts:47-79`) — `isDirty` = a `JSON.stringify`
  compare of `initialValue`/`currentValue`, `save()` blocks on a non-empty `validate()` result,
  `discard()` returns `initialValue`. `useDocForm` is the JSON-doc-only variant
  (`ui/src/features/settings/useDocForm.ts:44-120`); `search_urls.md` is markdown, so it bypasses
  `useDocForm` exactly as it does today, going straight through `configDocQuery`/
  `useConfigMutation` (unchanged pattern).
- **REVISED — PUT-echo contract (blueprint-be §2 "UI contract" row, judge item 1, HIGH).** BE's
  revision fixed a real bug: `writeConfigDoc` (BE Step 6) and `routes.ts`'s `putHandler` (BE Step 7)
  now return/echo the text **actually stored**, which for `search_urls.md` is the NORMALIZED text
  (post re-file/clean/merge), not the request body — a duplicate merge or a re-file can make the
  stored doc differ in shape from what the client submitted (e.g. 2 submitted rows collapsing to 1
  stored row). Because `useConfigMutation`'s `mutateAsync` resolves to exactly this echoed
  `ConfigGetResponse`, this blueprint's save flow (§5 Step 6) must **re-seed `state`/`savedState`
  from the response's `text`**, never assume the locally-submitted rows are what landed in the DB —
  otherwise the card would keep showing a row the server already merged away until the next reload.
  This is new, explicit content in this revision (see §5 Step 6's rewritten save flow).
- **Cross-boundary types:** the UI never duplicates a server response type — it re-exports it
  type-only from `src/app/features/**` (`verbatimModuleSyntax`, erased at compile time):
  `ConfigGetResponse` from `src/app/features/config/index.ts`
  (`ui/src/lib/api/types.ts:18-21`) and `RunDetail`/`SoftErrorSummary`/etc. from
  `src/app/features/runs/index.ts` (`:30-41`). This means **BE blueprint Step 7's widening of
  `ConfigGetResponse` to `{ text; report?: SearchUrlsSaveReport }` reaches the UI with zero UI type
  work** — a straight sequencing dependency (this blueprint's save-report rendering needs BE Step 7
  merged/typed first), not a data gap.
- **`RunDetail.result` stays `unknown` at the UI boundary by deliberate existing convention** —
  `ui/src/features/runs/runResult.ts:1-7`'s own doc comment: "opaque `unknown` at the port
  boundary... The UI... narrows defensively rather than importing the zod schema." Every existing
  reader (`getFunnelStages`, `getFailedStage`, `getFailureError`, `newMatchCount`) is a hand-written
  type-guard in that one file. This blueprint adds one more (`getLinkSoftErrors`, §5 Step 9),
  matching the file's own established pattern exactly — **no dependency on BE blueprint Step 13's
  exact zod shape**, defensive narrowing absorbs it either way.
- **`ui/` importing dependency-free `src/core/**`:** already a live pattern, not a new seam —
  `ui/src/features/runs/RunDetailView.tsx:6` imports `'../../../../src/core/datetime/index.ts'`
  directly. BE blueprint Step 1 places `src/core/linkedin_url/` under the same CLAUDE.md exception
  (plain `URL`, zero imports) specifically so this feature's UI can import it the same way. A file
  under `ui/src/features/settings/sections/` is one directory deeper than `runs/`, so its import
  path is `'../../../../../src/core/linkedin_url/index.ts'` (5 `../`, one more than the cited
  4-`../` precedent) — confirm the exact dot-count mechanically at implementation time by counting
  directories from the new file to the repo root; it is a fixed, checkable computation, not a
  judgment call.
- **e2e harness:** Playwright (`ui/playwright.config.ts`), driven against the **real board server**
  over `profiles/rajni`'s seeded fixture (port 4199, `npm run ui:e2e` builds then runs
  `--project=shared-docs` then `--project=default`). Read directly: `ui/e2e/settings.spec.ts:1-173`
  — every test captures the doc it's about to mutate via `page.request.get`, edits through the real
  form, asserts the saved server state via `page.request.get` again (never the form alone), and
  restores the original doc in a `finally` (`seed.ts`'s `globalSetup` wipes `config_docs` once per
  whole suite run, not per test — a leftover mutation leaks into every later test). The file's own
  existing test at `:146-173` is this feature's direct predecessor: it fills the URL/Label fields
  of `WhereJobsComeFromSection`'s search-url row, saves, and asserts the server text contains the
  new bullet line. `ui/e2e/run-experience.spec.ts` uses a **second, route-stubbing** idiom instead
  of the real server for run-detail states — `mountSingleRun(page, { row, detail })`
  (`ui/e2e/run-fixtures.ts:260-278`) stubs `GET /runs`, `GET /runs/:id`, `/soft-errors`, `/events`
  via `page.route`, letting a test hand-craft `detail.result` directly
  (`ui/e2e/run-experience.spec.ts:212-231` builds a `produced` run this way). `RunDetailFixture`
  (`run-fixtures.ts:105-106`) currently types `result` as `{ stages: FunnelStage[] } | null` —
  needs a one-line, additive-optional widening for this feature's run-detail tests (§5 Step 10).
- **data-qa convention:** confirmed — `data-qa` (not `data-testid` alone) is the repo's own
  mockup-pairing attribute, already dual-applied on real components, e.g. `SaveBar.tsx:55`
  (`data-qa="save-bar"` + `data-testid="save-bar"`), `WhereJobsComeFromSection.tsx:222`
  (`data-qa="where-jobs-lanes-card"`).

---

## 2. Component Mapping

**Region count check:** the mockup's own data-qa map (ux-notes §11) names **25 distinct data-qa
base families**; a fresh grep of `mockup.html` for every `data-qa="..."` value collapses to the
same 25 families once per-row/per-state numeric and state suffixes (`-1`..`-5`, `-typing`,
`-clean`, `-cleaned`, `-duplicate`, `-refused`, `-misfiled`, `-default`, `-empty`, `-loading`,
`-error`, `-success`, `-save-error`) are stripped. The table below has **25 rows** — count matches.

Two families are **id-naming divergences, not gaps**: the mockup's `settings-savebar`/
`settings-save-success`/`settings-validation-summary` map to the **already-shipped**
`SaveBar`/`ValidationSummary` components, whose real, already-tested `data-qa` values are
`save-bar`/`save-success-line`/`validation-summary` (`SaveBar.tsx:55,89`,
`ValidationSummary.tsx:61`). Renaming the shipped ids to match the mockup's illustrative names
would break every other section's existing e2e coverage keyed to those exact strings — reuse wins;
the mockup's names are informal shorthand, not a new contract. Noted again in §7.

| data-qa (mockup family) | mockup element | real component (path) | props / variant | verdict | Design Scale |
|---|---|---|---|---|---|
| `search-urls-card` | card shell | `SearchUrlsCard` (new, `ui/src/features/settings/sections/SearchUrlsCard.tsx`) inside `Card`/`CardHeader`/`CardTitle`/`CardContent` (existing, `components/ui/card.tsx`) | `profile`, `rows`, `displayStates`, callbacks | **new** — no card currently owns the helper text + misfile notice + skeleton/error branches together; existing `Card` primitive is reused inside it (not re-invented) | `p-4 gap-4`, `rounded-xl` |
| `search-urls-helper` | helper line | new `<p>` inside `SearchUrlsCard` | static copy | **new** (one line, no component warrants it) | `text-xs`, `--muted-foreground` |
| `search-urls-misfile-notice` | R13 attention strip | new `<div>` inside `SearchUrlsCard`, matching the **existing ad-hoc notice idiom** already used 3+ places (`WhereYouWorkSection.tsx:208`, `PacingPresetCard.tsx:107`, `DaemonCard.tsx:297` — all `border-l-2 border-l-attention bg-attention/10 p-3/p-4`, no shared `Notice` component exists in the repo) | count text + `Button` (existing, `variant="outline"`) | **new**, but **zero new idiom** — mirrors 3 existing call sites' exact class pattern; verdict is "new" only because no component wraps that markup anywhere in the repo (an add-primitive `Notice` component was considered and rejected — proportionality: 3 existing call sites already accept the duplication, a 4th doesn't earn a shared abstraction) | `p-4`, `gap-3`, `--attention`/`--attention-strong` |
| `search-urls-refile-button` | "Re-file N links" | `Button` (existing, `variant="outline"`) inside the notice above | `disabled={isRefiling}`, label swaps to "Re-filing…" | **existing** | `h-9` (`size="default"`≈mockup's 36px) |
| `search-url-row` | one row card | new `SearchUrlRow` (`ui/src/features/settings/sections/SearchUrlRow.tsx`) | `row`, `display` (from `classifyRowsForDisplay`), `onChangeUrl/onChangeLabel/onBlurUrl/onRemove/onRemoveNow` | **new** — today's inline row JSX (`WhereJobsComeFromSection.tsx:246-298`) becomes this component so the file stays under the 400-line impl cap once row sub-state rendering (6 states) is added | `rounded-lg border p-3 gap-1` |
| `search-url-input` | URL field | `Field`/`FieldControl`/`Input`/`FieldError` (existing, `components/ui/form.tsx`, `components/ui/input.tsx`) | `id={`where-jobs-search-urls.${i}`}`, `invalid`, `onBlur` (new handler) | **existing** | `h-8`, `flex-1` |
| `search-url-label-input` | Label field | `Field`/`FieldControl`/`Input` (existing) | `className="w-48"` | **existing** | `w-48` |
| `search-url-remove` | remove ✕ | `Button` (existing, `variant="ghost" size="icon"`) | `aria-label="Remove {label}"` | **existing** | `size-8` (≈32px) |
| `search-url-page-type-badge` | page-type badge | `Badge` (existing, `variant="outline"`) | `title`/`aria-label` = `` `Page type: ${label} (${page})` `` | **existing** | `h-5`, `rounded-4xl` |
| `search-url-row-note` | cleaned/duplicate/misfiled note | new `<span>` inside `SearchUrlRow`, `aria-live="polite"` wrapper (matches mockup's `.row-line2[aria-live=polite]`) | text + tone class (`text-muted-foreground` vs `text-attention-strong`) | **new** (2-state text span, not a component) | `text-xs` |
| `search-url-error` | refused FieldError | `FieldError` (existing, `components/ui/form.tsx:95-115`) | children = `FIELD_ERROR_COPY` (**fixed this revision, MEDIUM copy-mismatch item** — Step 2's own fixed constant, ux-notes C4's exact copy; never BE's `refused: `-prefixed wire string, which is now used only to identify a server-refused row, not displayed) | **existing** | `text-sm` (component's own fixed size) |
| `search-url-duplicate-remove` | "Remove now" link | new `<button>` styled as a link (`text-primary underline-offset-4`, matches `Button variant="link"`'s existing utility pattern but as a bare button per mockup's `.link-btn`, inline in the row note) | `onClick={onRemoveNow}` | **new** (one inline element; `Button variant="link"` was considered — rejected because it renders a `<button>` with the Button component's padding/height box model, which breaks the mockup's inline-text placement inside the row-note line) | `text-xs`, `--primary` |
| `search-urls-add` | "Add another search URL" | `Button` (existing, `variant="outline"`) | unchanged | **existing** | `h-9` |
| `search-urls-empty` | empty-state copy | new `<p>` inside `SearchUrlsCard`, gated on `rows.length === 0` | static copy | **new** (one line) | `text-sm`, `--muted-foreground` |
| `search-urls-skeleton` | loading rows | `Skeleton` (existing, `components/ui/skeleton.tsx`) × field-shaped rows, passed as `DocFormGate`'s existing `loadingFallback` prop (`DocFormGate.tsx:26-33`, already built for exactly this) | 2 skeleton row shells | **existing** (composition of `Skeleton`, using an already-built extension point) | `h-8`/`h-5`, `rounded-lg`/`rounded-4xl` |
| `search-urls-load-error` | error alert + Retry | `ErrorRetry` (existing, `ui/src/features/shared/ErrorRetry.tsx`) passed as a **new** `errorFallback` prop on `DocFormGate` (mirrors the already-existing `loadingFallback` prop exactly — same file, same pattern, additive) | `message="Couldn't load search links."`, `onRetry={() => searchUrlsQuery.refetch()}`, `qa="search-urls-load-error"` | **existing** (`ErrorRetry`) + **add-primitive** on `DocFormGate` (one new optional prop, not a new component — see §5 Step 7) | `text-sm`, `--destructive` |
| `settings-savebar` | sticky save bar | `SaveBar` (existing, `save/SaveBar.tsx`) | unchanged | **existing** (real id: `save-bar`) | `p-3`, `rounded-xl` |
| `settings-save-success` | success strip | `SaveBar`'s own success branch (existing, `SaveBar.tsx:86-96`) | `successMessage` built from `mutation.data?.report` (§5 Steps 5-6) | **existing** (real id: `save-success-line`) | `border-l-2 --success` |
| `settings-validation-summary` | error summary | `ValidationSummary` (existing, `save/ValidationSummary.tsx`) | `errors` (client validation + merged-in server 422, §5 Steps 5-6), `attempt` | **existing** (real id: `validation-summary`) | `p-4`, `--destructive` |
| `run-bad-links-panel` | attention run-detail panel | new `BadLinksPanel` (`ui/src/features/runs/detail/BadLinksPanel.tsx`) | `links: {url,label,reason}[]`, `profile` | **new**, justified: `DiagnosisPanel` (existing, `runs/detail/DiagnosisPanel.tsx`) is gated by `RunDetailView.tsx`'s own `DIAGNOSIS_KINDS` allowlist (`:44-49`), whose doc comment states "never for produced" as a **deliberate, existing invariant** other code relies on (plan.md B20 step 4). This feature's panel must render on exactly the outcome kind that allowlist is built to exclude (a passed/produced run with soft-failed links) — reusing the literal component would require weakening that documented gate for every other caller. A sibling component reusing the SAME visual idiom (icon-circle, title, evidence line, action row — `DiagnosisPanel.tsx:93-106,278-322`) with the `--attention` tint (not `DiagnosisPanel`'s `amber`, per ux-notes §1) satisfies UX callout C10 ("reuses the DiagnosisPanel **idiom**") without touching the gate | `p-3`/`p-4`(mockup uses `p-4`; match `DiagnosisPanel`'s own `p-3` card padding for visual consistency with its sibling — ASSUMED unattended, §8), `rounded-xl`, `--attention`/`--attention-strong` |
| `run-bad-links-list` | failed-link list | new `<ul>` inside `BadLinksPanel`, ≤5 visible + "+N more" (same disclosure pattern as `DiagnosisPanel`'s `FallbackEvidence` expand/collapse, `DiagnosisPanel.tsx:114-152`, reused as a pattern not a component) | `label`, mono shortened URL (`title`=full), `reason` | **new** (list markup, part of `BadLinksPanel`) | `text-sm`/`text-xs mono` |
| `run-bad-links-fix` | "Fix in Settings" | `Button` (existing, `asChild` + real `<a>`??) — mockup uses an `<a>`; real equivalent is a `Button` that calls `navigate({name:'settings',section:'where-jobs-come-from'})` on click (matches `DiagnosisPanel.tsx`'s own `ActionButton` `case 'navigate'`, `:228-240`, which also uses a `<button onClick>` + `navigate()`, not a real anchor) | `variant="default"` | **existing** (`Button` + `navigate()`, same call shape as `DiagnosisPanel`'s existing navigate action) | `h-9` |
| `run-bad-links-copy` | "Copy links" | `Button` (existing, `variant="outline"`) | `onClick` = clipboard write of the full URL list, mirrors `DiagnosisPanel.tsx`'s existing `handleCopy` pattern (`:201-211`, swallow-on-denial, "Copied" label flip for 2s) | **existing** (`Button`) + reused copy-handler pattern (not extracted into a shared hook — proportionality: 2 call sites, both already accept the small duplication `DiagnosisPanel` itself has for `handleCopy`) | `h-9` |
| `run-outage-panel` | contrast frame (unchanged) | `DiagnosisPanel` (existing) at its `'total-outage'` kind — **no new code**, this row documents that the existing destructive panel is untouched and the two never co-render (BE only ever attaches `linkSoftErrors` to a `passed`-outcome `RunResult`, §5 Step 9's narrowing helper, so a failed/total-outage run never carries the data `BadLinksPanel` renders from) | n/a | **existing**, unchanged | n/a |
| `digest-bad-links-block` | Telegram digest text | **none — server-formatted text, no UI component.** `formatDigest` (blueprint-be.md §5 Step 16) is a pure server-side string transform; the Telegram bubble in the mockup is UX's E2 "mockup chrome" exception (ux-notes §1: "not board UI, has no repo token"). Recorded here only so the 25-family count is exhaustive | n/a | **N/A — out of UI scope**, delivered entirely by blueprint-be.md | n/a |

**25 rows, 25 mockup families — count confirmed matching.**

---

## 3. Layout & Composition

### S1 — Settings › Where jobs come from › Search URLs card

Unchanged page shell (`SettingsShell.tsx`/`SettingsNav.tsx`/`SettingsPage.tsx` — no routing or nav
change). Inside `WhereJobsComeFromSection.tsx` (orchestrator, unchanged responsibility: fetch
`profile.json` + `search_urls.md`, own combined `state`/`savedState`, one `useSectionSaveState` +
one `SaveBar` for both the Lanes card and the Search URLs card — this two-card, one-save-state shape
is pre-existing and untouched):

```
WhereJobsComeFromSection (orchestrator, DocFormGate × 2 unchanged nesting)
├── ValidationSummary                         (existing, errors merged client+server)
├── Card "Lanes"                               (existing, untouched)
└── SearchUrlsCard                             (NEW)
    ├── helper text
    ├── misfile notice (conditional, R13)
    ├── row list
    │   └── SearchUrlRow × n                   (NEW, one per row)
    ├── "Add another search URL"
    ├── (loading: DocFormGate's loadingFallback → Skeleton rows)
    └── (error: DocFormGate's errorFallback → ErrorRetry)
SaveBar                                         (existing, sibling of both cards, unchanged position)
```

No responsive breakpoints in the mockup or ux-notes (desktop-only settings surface, matches every
other Settings section — none of the 11 existing sections have a mobile layout). `SearchUrlsCard`
inherits the settings-main column width (`flex-1` inside `SettingsShell`'s existing grid) — no new
layout primitive.

### S2 — Run detail › bad-links panel

Inside `RunDetailView.tsx`'s existing fixed 5-panel composer (`:188-192`'s own doc comment: "outcome
header → diagnosis (conditional) → stage rail → funnel table → evidence"). `BadLinksPanel` slots in
as a **new, independent conditional**, sibling to (not nested inside) the existing
`DIAGNOSIS_KINDS.has(kind) && <DiagnosisPanel/>` block, in the same position ux-notes §4 specifies
("at the top of the run detail body... above the funnel"):

```
RunDetailView
├── OutcomeHeader                               (existing, unchanged)
├── (catchup slots line, existing, unchanged)
├── linkSoftErrors.length > 0 && <BadLinksPanel/>   (NEW conditional, independent of `kind`)
├── DIAGNOSIS_KINDS.has(kind) && <DiagnosisPanel/>  (existing, unchanged — never both truthy in
│                                                     practice, since BE only ever populates
│                                                     linkSoftErrors on a passed-outcome result)
├── StageRail                                    (existing, unchanged)
├── FunnelTable                                  (existing, unchanged)
└── EvidenceSection                              (existing, unchanged)
```

No responsive strategy change — run detail is already a single fixed-width column.

### S3 — Telegram digest

Out of UI scope entirely (§2 last row). No layout.

---

## 4. State & Data

Every datum cites its `blueprint-be.md` contract — an existing endpoint or a numbered BE step.

| Data | UI consumer | blueprint-be.md source | Notes |
|---|---|---|---|
| `search_urls.md` doc text | `SearchUrlsCard` (via `configDocQuery`) | Existing `GET /api/profiles/:name/config/search_urls.md` (blueprint-be §1, `routes.ts:86-102`) — **unchanged endpoint** | No new fetch; same query as today |
| Row classification (`page`, `label`, `cleanedUrl`, `removedParams`) | `SearchUrlRow` display, on blur/paste | blueprint-be §5 Step 1 — `classifyLinkedInSearchUrl()`, `src/core/linkedin_url/`, imported directly (client-side, no round trip) | Function signature, throw class, and the byte-exact refusal message are all specified in Step 1 — **the UI uses only the throw/no-throw signal, never that message's text** (§5 Step 2's `FIELD_ERROR_COPY` is the actual display copy) |
| `LINKEDIN_SEARCH_URL_LABELS` (human badge text) | `SearchUrlRow` badge | blueprint-be §5 Step 1 — same module, same constant. UI imports it; **never hand-copies the strings** (Step 1's own instruction, matches ux-notes §2's "single source, product-ui/be to place it") | |
| Save-time change report (`{total, refiled, cleaned, merged, changes}`) **and the actually-stored `text`** (may differ from what was PUT — re-filed/merged) | `SearchUrlsCard` success strip + row-editor re-seed | blueprint-be §2 "Save-time change report" row + "PUT config response" row ("UI contract": re-seed from the response `text`) + Steps 6-7 — arrives as `mutation.data` (`{text, report}`) via the widened `ConfigGetResponse` (type-only import, §1 above) | Sequencing dependency: BE Step 7 must be merged/typed before this UI code typechecks. **UI must re-seed `state`/`savedState` from `mutation.data.text` on every successful `search_urls.md` save (§5 Step 6, judge item 1)** — never assume the submitted rows are what's stored |
| Save-error / refusal text | `ValidationSummary` + `SearchUrlRow`'s `FieldError` | blueprint-be §7 table, row "Board PUT... for `search_urls.md`" — 422 body message = `UnrecognizedLinkedInSearchUrlError.message` (Step 1, `refused: `-prefixed), already surfaced today as `mutation.error.message` via `ApiError` (`ui/src/lib/api/client.ts:1-48`, unchanged) | **FIXED this revision (MEDIUM copy-mismatch item, ux-notes C4/§3):** the server's raw wire string is used **only** to `.includes(url)`-identify the refused row (§5 Step 5) — it is never rendered. `ValidationSummary` shows Step 2's `buildValidationSummaryRefusalMessage(label)` ("<label> — not a LinkedIn jobs search link", ux-notes:129); `FieldError` shows Step 2's `FIELD_ERROR_COPY` (ux-notes:209-212, mockup.html:443,550) |
| R13 misfile detection | `SearchUrlsCard` notice + `SearchUrlRow` note | **UI-only per blueprint-be §6**: "client compares stored heading vs `classifyLinkedInSearchUrl(url).page` on the existing GET response; no new server endpoint." Its e2e now depends on `ui/e2e/seed_misfiled_search_url.ts` (blueprint-be §2 "R13 e2e seed" row — file name cited there; owned by the blueprint-be step creating it, judge item 2) — every PUT now auto-fixes misfiles, so a `page.request.put` seed can no longer create one | Computed client-side, §5 Step 2; e2e wiring §5 Step 7 |
| Run-detail `linkSoftErrors` | `BadLinksPanel` | blueprint-be §2 "Per-link soft-error (persisted, labeled)" row (now with an upstream `writtenAt` staleness guard) + §3 S2 Default row — `RunDetail.result` optionally carries `linkSoftErrors: {url,label,reason}[]`, **fully resolved server-side** (BE Steps 14-15: label baked in at run end, a stale side-doc read is rejected, no extra client fetch) | UI narrows via new `getLinkSoftErrors(result: unknown)` (§5 Step 9), matching the file's existing defensive-narrowing convention — decoupled from BE's exact zod shape |
| `RunDetail`/`SoftErrorSummary` types | `RunDetailView`, `BadLinksPanel` | Existing type-only import (`ui/src/lib/api/types.ts:30-41`, from `src/app/features/runs/index.ts`) — **unchanged import**, `result` stays `unknown` | |

No data need in this feature lacks a BE source — nothing to bounce.

---

## 5. Implementation Steps

Every step names one file of focus (two when a component + its colocated test are inseparable),
is dependency-ordered, and has an objectively checkable done-condition. Screen/state-delivering
steps carry their e2e id **in the same step** — no trailing "write e2e" step anywhere below.

**Step 1 — `ui/src/features/settings/sections/searchUrls.model.ts` (+ `searchUrls.model.test.ts`), pure refactor**
- Rename the `SearchUrlRow.slug` field to `page` throughout (`parseSearchUrlRows`,
  `serializeSearchUrlRows`, `isSlugCovered` → rename to `isPageCovered` for consistency with BE's
  `LinkedInSearchUrlPage` vocabulary). Parse/serialize **grammar is unchanged** (still the
  `### <page>` / `  • <label> - <url>` shape both the pipeline's read-only `parseSearchUrls` and
  BE's new `core/config/search_urls/` parser use) — this is a rename, not a behavior change.
- **New this pass — add `touched: boolean` to the `SearchUrlRow` interface** (this is the interface's
  owning module; Steps 2, 5, and 6 all read/set this field but none of them define the type). Update
  `parseSearchUrlRows` to set `touched: true` on every row it parses from a GET response (a loaded,
  already-saved row shows its badge/note immediately — mockup's Default-state rows, no re-blur
  required — same posture Step 5's `reseedRowsFromText` already assumes of this field). A freshly
  `addRow()`-created row (Step 6) is the only caller that constructs `touched: false`.
- Update `WhereJobsComeFromSection.tsx`'s and `SearchUrlsSection.tsx`'s references (`.slug` → `.page`,
  `DEFAULT_SLUG` constant stays for now — removed in Step 6 per R2).
- **Confirmed this pass (Gate 4 item N5 — orchestrator decision, BE-implemented): `serializeSearchUrlRows`
  is UNCHANGED and needs no fix.** A row with a label but an empty `url` serializes to `` `  •
  ${label} - ` `` (a bullet line with no URL after the trailing " - ") — this line does NOT match
  the shared bullet-line grammar's regex (`` /^[•*-]\s+(.+?)\s+-\s+(https?:\/\/\S+)$/ ``, requires
  a URL), on EITHER side (this module's own `parseSearchUrlRows` today, and BE's identically-shaped
  `parseRows`, blueprint-be §5 Step 2) — the row is silently absent from what either side parses as
  a "row," never reaches `classifyLinkedInSearchUrl`, and can never itself trigger BE's 422. This is
  today's existing behavior, unchanged by the `.slug`→`.page` rename; no code change here satisfies
  N5, this bullet exists to record that it was checked, not assumed.
- **Done-condition:** `searchUrls.model.test.ts` passes with the renamed field and the new `touched`
  field (a test asserting `parseSearchUrlRows` always returns `touched: true`); **a new regression
  test (N5): `serializeSearchUrlRows` on a row with `label: 'Foo', url: ''` among otherwise-valid
  rows produces a doc that, round-tripped back through `parseSearchUrlRows`, omits that row entirely
  (its label never reappears) while every other row survives** — pins N5's "silently skipped, not
  written" contract at the parser boundary this module owns;
  `grep -c "\.slug\b" ui/src/features/settings/sections/searchUrls.model.ts` returns 0. Not a
  screen/state step (no user-visible change) — no e2e.

**Step 2 — NEW `ui/src/features/settings/sections/searchUrlRow.classify.ts` (+ `.test.ts`), pure**
- Imports `classifyLinkedInSearchUrl`, `LINKEDIN_SEARCH_URL_LABELS`, `LinkedInSearchUrlPage`,
  `UnrecognizedLinkedInSearchUrlError` from `'../../../../../src/core/linkedin_url/index.ts'`
  (verify the exact `../` count mechanically — §1's own note).
- **FIXED this revision (MEDIUM copy-mismatch item — ux-notes C4, ux-notes:209-212;
  mockup.html:443,550): the inline FieldError must show C4's fixed, user-facing copy, never BE's
  wire-format `refused: <url> — ...` string** (that string is CLI stderr / API-body text, not
  product copy — spec §14/CLAUDE.md nowhere requires the UI to echo a backend error string
  verbatim, and ux-notes explicitly specifies different copy for this exact surface). Single-sourced
  here as an exported constant, so Step 5/6's server-refusal path (below) can reuse it rather than
  re-typing it:
  ```ts
  /** ux-notes.md C4's exact copy — the ONLY text ever shown as the inline
   * FieldError under a refused search-url row, whether the refusal was
   * caught client-side (below) or server-side (Step 5's mergeServerRefusal,
   * Step 6). A BE `UnrecognizedLinkedInSearchUrlError`/422 message is never
   * displayed verbatim — it is wire format, used only to identify which
   * row a server-side refusal belongs to. */
  export const FIELD_ERROR_COPY =
    "This isn't a LinkedIn jobs search link. Paste one from linkedin.com/jobs/search, " +
    '/jobs/search-results or /jobs/collections.';

  /** ux-notes.md §3's ValidationSummary copy ("Zafin — not a LinkedIn jobs
   * search link", ux-notes:129) — label-prefixed, shorter than
   * FIELD_ERROR_COPY (no "Paste one from…" clause; ValidationSummary's own
   * link text carries the row identity, the field-level copy carries the
   * fix). `label` falls back to `'This link'` when the row's Label field
   * is still empty (an edge case ux-notes doesn't cover — ASSUMED
   * unattended, §8). */
  export function buildValidationSummaryRefusalMessage(label: string): string {
    return `${label.trim() || 'This link'} — not a LinkedIn jobs search link`;
  }

  /** New this pass (Gate 3 item: "Step 6 deletes the protocol error that
   * ux-notes C4 says to keep: keep it"). C4's own text: "It replaces the
   * old host error and keeps the protocol error." — lifted UNCHANGED from
   * the pre-existing `SearchUrlsSection.tsx`/`WhereJobsComeFromSection.tsx`
   * `PROTOCOL_MESSAGE` constant. Distinct from FIELD_ERROR_COPY: shown
   * only when the URL doesn't even parse as an absolute URL, or isn't
   * `https:` — a narrower, earlier check than "is this recognized as a
   * LinkedIn jobs link", run BEFORE calling classifyLinkedInSearchUrl. */
  export const PROTOCOL_MESSAGE = 'Enter a LinkedIn URL starting with https://';
  ```
- Exports:
  ```
  export type RowDisplay =
    | { kind: 'unclassified' }
    | { kind: 'refused'; message: string }
    | { kind: 'clean'; page: LinkedInSearchUrlPage; label: string }
    | { kind: 'cleaned'; page: LinkedInSearchUrlPage; label: string; removedParams: string[] }
    | { kind: 'misfiled'; page: LinkedInSearchUrlPage; label: string; storedPage: string }
    | { kind: 'duplicate'; page: LinkedInSearchUrlPage; label: string; mergesIntoLabel: string };

  export function classifyRowsForDisplay(rows: SearchUrlRow[]): RowDisplay[]
  ```
- Per-row logic: `{ kind: 'unclassified' }` when `!row.touched || row.url.trim() === ''`.
  **New this pass — the restored protocol pre-check runs first:** `try { new
  URL(row.url); } catch { return { kind: 'refused', message: PROTOCOL_MESSAGE }; }` then `if
  (parsed.protocol !== 'https:') return { kind: 'refused', message: PROTOCOL_MESSAGE };`. Only once
  the URL is a parseable `https:` URL does it call `classifyLinkedInSearchUrl(row.url)` **to learn
  whether it throws** — on throw, `{ kind: 'refused', message: FIELD_ERROR_COPY }` (**fixed prior
  revision** — was `err.message`, the BE wire string; the classifier's own thrown message is
  discarded entirely for display purposes, used only as a boolean "is this recognized" signal). On
  success, compute `removedParams` (from the classification) and `misfiled = classification.page
  !== row.page`. Both branches share the `'refused'` `RowDisplay` kind (`message` alone
  distinguishes them — no new kind needed, matching ux-notes' one-sub-state-per-row model; the
  mockup never shows the two side by side, so nothing forces a visual split).
- **Precedence, one row is exactly one display kind** (ASSUMED unattended, §8): 1) **duplicate** —
  after resolving every touched+recognized row's `` `${classification.page}|${classification.cleanedUrl}` ``
  key, a row whose key was already seen by an EARLIER row in array order is `duplicate` (label =
  `mergesIntoLabel` of the first row with that key); 2) else **misfiled** if
  `classification.page !== row.page`; 3) else **cleaned** if `removedParams.length > 0`; 4) else
  **clean**. This mirrors blueprint-be §5 Step 2's own dedupe key exactly (`page|cleanedUrl`,
  first-occurrence-wins), so the client's pre-save warning and the server's actual merge agree.
- Also: on a `'recognized'` classification (clean/cleaned/misfiled/duplicate), the row's URL/page
  are NOT mutated by this function — it is a pure display computation, called on every render. The
  actual state mutation (rewriting `row.url` to the cleaned form, `row.page` to the derived page)
  happens in the blur handler (Step 6), matching ux-notes §6 "Blur rewrites the input to the
  cleaned URL."
- **Done-condition:** table-driven test — one case per `RowDisplay` kind, plus: an untouched row
  with text → `unclassified`; two rows cleaning to the same URL → first is `clean`/`cleaned`,
  second is `duplicate` with the correct `mergesIntoLabel`; a row whose `page` already equals its
  classification and has no removed params → `clean`; **a refused row's `message` is byte-identical
  to `FIELD_ERROR_COPY`, never the raw `classifyLinkedInSearchUrl` throw text (regression test for
  the copy-mismatch fix)**; **a non-URL string and an `http://` (non-https) URL both classify to
  `{ kind: 'refused', message: PROTOCOL_MESSAGE }`, distinct from `FIELD_ERROR_COPY` (new this
  pass — regression test for "keeps the protocol error")**; `buildValidationSummaryRefusalMessage('Zafin')`
  returns exactly `` `Zafin — not a LinkedIn jobs search link` `` (ux-notes:129's literal example),
  and `buildValidationSummaryRefusalMessage('')` falls back to `` `This link — not a LinkedIn jobs
  search link` ``. Not a screen/state step — no e2e.

**Step 3 — NEW `ui/src/features/settings/sections/SearchUrlRow.tsx` (+ `.test.tsx`)**
- Presentational, controlled component: `{ row, display, onChangeUrl, onChangeLabel, onBlurUrl,
  onRemove, onRemoveNow }`. Renders the mockup's row markup (§2 table) — URL `Field`/`FieldControl`/
  `Input`/`FieldError`, Label `Field`, remove `Button`, and the `row-line2` region
  (`aria-live="polite"`) that switches on `display.kind`: nothing (`unclassified`), badge only
  (`clean`), badge + muted cleaned-note (`cleaned`, "Cleaned — removed X, Y" ≤3 names then "+N
  more", per ux-notes §3), badge + attention misfiled-note (`misfiled`, "Saved as {storedLabel} —
  will be re-filed as {label}."), badge + attention duplicate-note + "Remove now" link
  (`duplicate`, `` `Same search as "${mergesIntoLabel}" after cleaning — merged on save.` ``), or
  `FieldError` alone with no badge (`refused`).
- `aria-invalid`/`aria-describedby` on the URL input only when `display.kind === 'refused'` (matches
  `Field`'s existing `invalid` prop, which already wires both attributes —
  `components/ui/form.tsx:70-81`).
- **Done-condition (RTL, colocated, pyramid base):** one test per `display.kind` asserting the
  exact rendered note/badge/error text and that exactly one of {badge, error} shows per kind — the
  `refused` case asserts the rendered `FieldError` text is byte-identical to ux-notes C4's copy
  ("This isn't a LinkedIn jobs search link. Paste one from linkedin.com/jobs/search,
  /jobs/search-results or /jobs/collections.") — plus a test that `onBlurUrl` fires on blur (not on
  every keystroke) and `onRemoveNow` fires on the duplicate row's link click. Not itself a
  screen/state step (isolated component, no route) — RTL only, no e2e; e2e arrives at Step 6 where
  this is wired into a live page.

**Step 4 — NEW `ui/src/features/settings/sections/SearchUrlsCard.tsx` (+ `.test.tsx`)**
- Composes: card title/helper text, misfile notice (conditional on `misfiledCount > 0`, count +
  "Re-file N links" button), row list mapping `rows`/`displayStates` to `SearchUrlRow`, "Add
  another search URL" button, and the `rows.length === 0` empty-state copy line
  (`search-urls-empty`). Props: `{ rows, displayStates, misfiledCount, onRefile, isRefiling,
  onChangeUrl, onChangeLabel, onBlurUrl, onRemove, onRemoveNow, onAddRow }` — no fetching, no save
  logic (owned by the parent orchestrator, matching `WhereYouWorkPrefsCard`/
  `WhereYouWorkRulesCard`'s existing precedent of dumb, controlled sibling cards).
- **Done-condition (RTL, colocated):** renders N rows from N display states; misfile notice appears
  only when `misfiledCount > 0` and its button text is `` `Re-file ${misfiledCount} links` `` (or
  singular "1 link" — ASSUMED unattended, §8: singular/plural copy split, matching the repo's
  existing singular/plural pattern at `ValidationSummary.tsx:66`); empty-state copy appears only
  when `rows.length === 0`. Not itself wired to a route — RTL only; e2e arrives at Steps 6-7.

**Step 5 — NEW `ui/src/features/settings/sections/searchUrlsSave.ts` (+ `.test.ts`), pure helpers**
- **New this revision** (file-cap discipline, judge item 3's pattern applied on the UI side —
  `WhereJobsComeFromSection.tsx` was already 322/400 impl lines before this feature, and Step 6
  below now also carries the PUT-echo re-seed logic judge item 1 requires; extracting the
  save-orchestration math into its own colocated file mirrors blueprint-be's own revision, which
  extracted `search_urls_save.ts` (BE Step 5), `fire/canary.ts` (BE Step 9), and
  `run_link_soft_errors.ts` (BE Step 14) for exactly this reason rather than growing an
  already-large file in place). Three pure functions, no React, no fetch — Step 6's orchestrator is
  the only caller. Imports `buildValidationSummaryRefusalMessage` from Step 2's
  `searchUrlRow.classify.ts` (core→sibling-core import, both files live in `sections/`) rather than
  redefining the ValidationSummary copy shape here — one source for both the client-side and
  server-side refusal paths (MEDIUM copy-mismatch item):
  ```ts
  export function reseedRowsFromText(text: string): SearchUrlRow[] {
    // Thin wrapper around Step 1's parseSearchUrlRows. Every row parsed
    // from a server response is, by definition, already correctly filed
    // and clean (the server just normalized it) — so every row comes back
    // `touched: true`, matching the mockup's Default-state loaded rows
    // (badge/note visible immediately, no re-blur required).
    return parseSearchUrlRows(text).map((row) => ({ ...row, touched: true }));
  }

  export function buildSearchUrlsSuccessMessage(report: SearchUrlsSaveReport): string {
    // ux-notes §3's clause order: re-filed, cleaned, merged; zero-count
    // clauses dropped; "Saved N search links." alone when nothing changed.
    // FIXED this revision (LOW copy-mismatch item): ux-notes §10's literal
    // example capitalizes ONLY the first clause after the base sentence's
    // period ("Saved 4 search links. Cleaned 1, merged 1 duplicate.") —
    // every clause is built lowercase below, then the first one alone is
    // capitalized at the join step, matching a "new sentence fragment
    // starts capitalized, comma-joined continuations stay lowercase" rule.
    const clauses: string[] = [];
    if (report.refiled > 0) clauses.push(`re-filed ${report.refiled}`);
    if (report.cleaned > 0) clauses.push(`cleaned ${report.cleaned}`);
    if (report.merged > 0) {
      clauses.push(`merged ${report.merged} duplicate${report.merged === 1 ? '' : 's'}`);
    }
    const base = `Saved ${report.total} search link${report.total === 1 ? '' : 's'}.`;
    if (clauses.length === 0) return base;
    // FIXED this pass (LOW-MEDIUM compile item): `ui/tsconfig.json`'s
    // `noUncheckedIndexedAccess: true` makes `[first, ...rest] = clauses`
    // type `first` as `string | undefined` (clauses is `string[]`, not a
    // tuple), so `first.charAt(0)` doesn't compile even after the
    // `length === 0` guard above. `.map()`'s callback parameter is typed
    // from the array's element type directly — unaffected by
    // noUncheckedIndexedAccess (which only narrows explicit `arr[i]`
    // access) — so capitalizing via `.map((clause, i) => ...)` sidesteps
    // the issue entirely instead of re-deriving a possibly-undefined head.
    const capitalized = clauses.map((clause, i) =>
      i === 0 ? clause.charAt(0).toUpperCase() + clause.slice(1) : clause,
    );
    return `${base} ${capitalized.join(', ')}.`;
  }

  export function mergeServerRefusal(
    clientErrors: Record<string, string>,
    rows: SearchUrlRow[],
    serverMessage: string,
  ): Record<string, string> {
    // FIXED this revision (MEDIUM copy-mismatch item — ux-notes C4/§3,
    // ux-notes:129,209-212): `serverMessage` (BE's `refused: <url> — ...`
    // wire string, itself already `.includes(row.url)`-matchable since
    // the prefix moved the URL off position 0) is used ONLY to find WHICH
    // row the server refused — it is never the text shown to the user.
    // The displayed value is always Step 2's `buildValidationSummaryRefusalMessage`,
    // built from the matched row's OWN label, matching every other
    // ValidationSummary entry's "<label> — not a LinkedIn jobs search
    // link" shape exactly (ux-notes:129's literal example, "Zafin — not a
    // LinkedIn jobs search link").
    //
    // FIXED this pass (LOW-MEDIUM compile item): `noUncheckedIndexedAccess`
    // makes `rows[index]` type as `SearchUrlRow | undefined`, so
    // `rows[index].label` doesn't compile even after an `index !== -1`
    // check (TS doesn't narrow an indexed-access expression from a
    // separately-computed `index` variable). `.find()` returns the
    // matched element directly, already `| undefined`-typed and safe to
    // optional-chain — no indexed access at all.
    const matchedRow = rows.find((row) => row.url !== '' && serverMessage.includes(row.url));
    const index = matchedRow ? rows.indexOf(matchedRow) : -1;
    const key = index === -1 ? 'search-urls.server' : `where-jobs-search-urls.${index}`;
    const label = matchedRow?.label ?? ''; // buildValidationSummaryRefusalMessage's own
    return { ...clientErrors, [key]: buildValidationSummaryRefusalMessage(label) }; // '' → 'This link' fallback covers the no-match case too
  }
  ```
- **Done-condition (`searchUrlsSave.test.ts`):** `reseedRowsFromText` on a two-heading doc returns
  rows grouped correctly, every row `touched: true`; `buildSearchUrlsSuccessMessage` matches
  ux-notes §10's literal example **exactly, capitalization included** ("Saved 4 search links.
  Cleaned 1, merged 1 duplicate." — capital C, lowercase "merged") for
  `{total:4,refiled:0,cleaned:1,merged:1}`, "Saved 4 search links." alone for an all-zero report,
  and (regression case for a first-clause other than "cleaned") `{total:2,refiled:1,cleaned:0,
  merged:0}` → "Saved 2 search links. Re-filed 1."; `mergeServerRefusal` on a
  `` `refused: https://x — not a...` `` message correctly matches the row whose `url ===
  'https://x'` (regression test for the old prefix-matching bug) and stores
  `buildValidationSummaryRefusalMessage(matchedRow.label)` as the value — **never the raw server
  string** (regression test for the copy-mismatch fix) — falling back to the `'search-urls.server'`
  key (with the `'This link — not a LinkedIn jobs search link'` fallback text) when no row
  matches. Not a screen/state step (pure helpers, no route) — no e2e.

**Step 6 — MODIFY `ui/src/features/settings/sections/WhereJobsComeFromSection.tsx` — delivers S1
Default/Empty/Success/Save-error states (Must: R2, R4, R9, R10; Should: R9, R10)**
- Replace the inline search-url row JSX (`:240-304` today) with `<SearchUrlsCard>`, passing
  `classifyRowsForDisplay(state.rows)` for `displayStates`.
- Replace `validateRow`'s body: **delete only `HOST_MESSAGE`** — R1's classifier is now the single
  source of "is this recognized as a LinkedIn jobs link" (host+path together), so a separate,
  narrower host check here would let the UI accept/reject differently from the server. **KEEP
  `PROTOCOL_MESSAGE` and its check** — **fixed this pass (Gate 3 item: "Step 6 deletes the
  protocol error that ux-notes C4 says to keep")**: ux-notes C4's own text is explicit — "It
  replaces the old host error and keeps the protocol error" — so this is not this file's call to
  make either way; an earlier revision's instruction to delete BOTH was wrong. **FIXED this pass
  (MEDIUM copy-mismatch item, still correct):** for the host/path branch, the classifier's own
  thrown message (BE wire format) is discarded, exactly as in Step 2 — `validateRow` returns Step
  2's `buildValidationSummaryRefusalMessage(row.label)`, the SAME text `mergeServerRefusal` (Step
  5) produces for the server-refusal backstop path, so a client-caught and a server-caught refusal
  of the identical link render byte-identical ValidationSummary text. For the protocol branch,
  `validateRow` returns Step 2's `PROTOCOL_MESSAGE` verbatim (unprefixed by label — matches this
  message's own pre-existing, unchanged convention):
  ```
  if (url.trim() === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return PROTOCOL_MESSAGE;
  }
  if (parsed.protocol !== 'https:') return PROTOCOL_MESSAGE;
  try {
    classifyLinkedInSearchUrl(url);
  } catch {
    return buildValidationSummaryRefusalMessage(row.label);
  }
  if (row.label.trim() === '') return LABEL_MESSAGE;
  return undefined;
  ```
  — **keeps** the existing label-required rule (out of this feature's scope to remove; not
  mentioned by spec or ux-notes). Note this function's return value feeds `saveState.errors` /
  `ValidationSummary` only — the inline `FieldError` under each row comes from a completely
  separate path (Step 2/3's `classifyRowsForDisplay`, gated on `touched`, which runs the identical
  protocol-then-classify sequence for the SAME reason — see Step 2), which is where
  `FIELD_ERROR_COPY`'s longer "Paste one from…" sentence (or `PROTOCOL_MESSAGE`, for the protocol
  branch) is shown instead.
- **Confirmed this pass (Gate 4 item N5): a row with a label but an empty URL never blocks Save.**
  `validateRow`'s FIRST line, `if (url.trim() === '') return undefined;`, short-circuits before
  every other check — including the `LABEL_MESSAGE` check three lines later — so it returns no
  error **regardless of whether `row.label` is filled in**. `classifyRowsForDisplay` (Step 2)
  independently short-circuits the same way (`{ kind: 'unclassified' }` whenever `row.url.trim()
  === ''`), so such a row shows no badge/note/error either. Neither path can put an entry into
  `saveState.errors`/`ValidationSummary` for a label-only row, so Save is never blocked by one —
  matches Step 1's confirmed serialization behavior (a label-only row is silently omitted from what
  gets written, never a 422) end to end. **One consequence of this pass's own PUT-echo fix worth
  naming, not a contradiction of N5:** because a label-only row never reaches the stored doc, the
  PUT-echo re-seed (below) means such a row **disappears from the visible form after a Save that
  included it** — reseeding from `response.text` can only reconstruct rows the server actually
  stored. This is consistent with "skipped silently" (the row genuinely never persisted) and with
  this blueprint's own principle that the form should always reflect server truth post-save (judge
  item 1) — a user who wants to keep a half-filled row across a Save should finish pasting the URL
  first. ASSUMED (unattended, §8): no special-casing is added to preserve an unsaved label-only row
  through a Save — N5 doesn't ask for that, and inventing it would be scope creep. **Colocated
  done-condition (RTL, `WhereJobsComeFromSection.test.tsx`, pyramid base — a validation-logic
  assertion, not a screen/state needing e2e):** a row with `label: 'Foo', url: ''` present alongside
  a valid row produces `saveState.errors` with NO entry for the empty row's index, and clicking Save
  with only such a row present does not open `ValidationSummary` and does call
  `searchUrlsMutation.mutateAsync` (Save proceeds, unblocked).
- `onBlurUrl(index)`: call `classifyLinkedInSearchUrl(row.url)`; on success, `updateRow(index, {
  url: cleanedUrl, page: classification.page, touched: true })`; on throw, `updateRow(index, {
  touched: true })` (URL left as typed, so the FieldError shows against what the user actually
  entered).
- `onBlurUrl` also runs on **paste** (an `onPaste` handler on the URL `Input` that, after the
  paste's default insertion, re-runs the same classify-and-rewrite logic — matches ux-notes §6 "A
  paste event is a finished input, so the badge can appear on paste"). ASSUMED (unattended): fire on
  the paste event's own `input` DOM event via a `onInput`-adjacent microtask, OR simpler — run the
  same handler in `onChange` gated by `event.nativeEvent instanceof InputEvent &&
  event.nativeEvent.inputType === 'insertFromPaste'`. Implementation detail left to the executor;
  either approach satisfies "paste classifies immediately, typing does not."
- `addRow()`: new rows get `{ page: '', label: '', url: '', touched: false }` (no more
  `DEFAULT_SLUG` — **R2's literal requirement**, "the hard-coded `DEFAULT_SLUG` is gone"). Delete
  the `DEFAULT_SLUG` constant.
- **Empty-state auto-add** (ux-notes C12, ASSUMED unattended): a `useEffect` that runs once
  `searchUrlsQuery.isSuccess && state.rows.length === 0` and the effect hasn't already fired for
  this profile (mirrors the file's existing `initialized` ref pattern) — calls `addRow()` and
  focuses the new row's URL input via a `ref` passed down to `SearchUrlsCard`/`SearchUrlRow`
  (`autoFocus` prop on the last row when `rows.length === 1 && rows[0]?.url === ''` — **fixed this
  pass (residual compile item): `rows[0]` types as `SearchUrlRow | undefined` under
  `ui/tsconfig.json`'s `noUncheckedIndexedAccess`, so a bare `.url` access doesn't compile even
  behind the `rows.length === 1` guard (TS doesn't narrow an indexed-access expression from a
  separately-checked `.length`); `?.` makes the whole expression `undefined === ''` → `false` in
  the (impossible, but type-real) empty-array case, which is the same "don't autofocus" outcome
  the guard already intends**).
  ASSUMED (unattended): focus is applied via a plain `autoFocus` prop, not an imperative ref call —
  simpler, and React's own `autoFocus` already handles "focus once, on mount of this element."
- **Duplicate "Remove now":** `onRemoveNow(index)` calls the existing `removeRow(index)`.
- **FIXED this revision (judge item 1, HIGH — PUT-echo re-seed; blueprint-be §2 "UI contract" row,
  Steps 6-7):** the server may store DIFFERENT text than what was PUT for `search_urls.md` — a
  duplicate merge or a re-file changes the doc's actual shape. `saveSearchUrls` now captures and
  returns the mutation's OWN resolved response, never assumes the locally-submitted `value` is what
  landed in the DB:
  ```ts
  async function saveSearchUrls(text: string): Promise<{ ok: boolean; rows?: SearchUrlRow[] }> {
    try {
      const response = await searchUrlsMutation.mutateAsync(text);
      return { ok: true, rows: reseedRowsFromText(response.text) }; // Step 5's helper
    } catch {
      return { ok: false };
    }
  }
  ```
  The combined `onSave` passed to `useSectionSaveState` awaits both saves, and — **only when both
  succeeded** — commits `state` AND `savedState` (not just `savedState`, so the currently-displayed
  rows match the DB with **no reload required**) from the search-urls save's **returned `rows`**,
  never from the locally-submitted `value.rows`:
  ```ts
  onSave: async (value) => {
    const [profileOk, searchUrlsResult] = await Promise.all([
      profileForm.save((cfg) => { /* unchanged lanes merge */ }),
      saveSearchUrls(serializeSearchUrlRows(value.rows)),
    ]);
    const ok = profileOk && searchUrlsResult.ok;
    if (ok) {
      const reseeded = { lanes: value.lanes, rows: searchUrlsResult.rows ?? value.rows };
      setState(reseeded);
      setSavedState(reseeded);
    }
    return ok;
  }
  ```
- **Success strip** (BE Steps 6-7's report → Step 5's `buildSearchUrlsSuccessMessage`): build
  `successMessage` from `buildSearchUrlsSuccessMessage(searchUrlsMutation.data.report)` whenever
  `searchUrlsMutation.data?.report` is present. When absent (e.g. a save to `profile.json` alone
  changed nothing on the search-urls side, or the mutation hasn't resolved with a report yet), fall
  back to the existing generic `NOT_RUNNING_MESSAGE`/`RUNNING_MESSAGE` from `useSectionSaveState`
  unchanged.
- **Save-error merge into ValidationSummary** (mockup's `save-error` sub-state), via Step 5's
  `mergeServerRefusal(clientErrors, state.rows, searchUrlsMutation.error.message)` whenever
  `searchUrlsMutation.error` is set. `searchUrlsMutation.error.message` is BE's raw
  `` `refused: ${url} — not a LinkedIn jobs search link (expected /jobs/search,
  /jobs/search-results or /jobs/collections/…). Nothing written.` `` wire string — Step 5's
  `mergeServerRefusal` uses it ONLY to `.includes(row.url)`-match the offending row (the `refused: `
  prefix moves the URL off position 0, so this is never a prefix check), then discards it and
  stores `buildValidationSummaryRefusalMessage(matchedRow.label)` instead (**MEDIUM copy-mismatch
  fix, ux-notes:129** — the raw BE string is never shown to the user; this file never
  re-implements the match-or-format logic, both live in Step 5). The resulting merged errors
  object is what's passed to `ValidationSummary` (same field-key convention the client validator
  already uses, so the existing "click the link → focus the row" wiring,
  `ValidationSummary.tsx:78-81`, `document.getElementById(field)?.focus()`, works unmodified — the
  URL input's DOM `id` already equals this same field key). **This save-error path is a defense-
  in-depth backstop only** (§3's Read-Write Path Map: "the common case is pre-empted client-side")
  — in normal operation `validateRow` (below) already blocks Save with the identical
  `buildValidationSummaryRefusalMessage` text before any PUT is attempted, since both paths call
  the same classifier.
- **Done-condition + e2e (NEW `ui/e2e/settings-search-link-intake.spec.ts` — added to
  `SHARED_DOC_SPECS` in `ui/playwright.config.ts:29-38`, since every test below reads/writes
  `rajni`'s real, shared `search_urls.md` through the board API; every mutating test below follows
  `settings.spec.ts`'s own `fetchConfigText`-before / `putConfigText`-in-`finally` capture-and-
  restore convention — §1 — so no test here leaks a mutation into a later test in the same suite
  run):**
  - `search-url-intake: pasting a dirty search-results link shows the Search results badge and a
    cleaned note after blur, and saves cleaned + correctly filed` — types/fills a
    `/jobs/search-results/?currentJobId=...&origin=...` URL into a fresh row, blurs, asserts the
    badge text "Search results" and a row-note containing "Cleaned", saves, then
    `page.request.get`s `search_urls.md` and asserts the saved bullet line has none of the
    ephemeral params and sits under `### linkedin__jobs-search-results` (mirrors BE AC1/AC5).
  - `search-url-intake: an unrecognised link is refused inline and blocks Save` (**fixed this
    revision, MEDIUM copy-mismatch item**) — fills a non-LinkedIn URL, blurs, asserts the
    `FieldError` text is byte-identical to ux-notes C4's copy ("This isn't a LinkedIn jobs search
    link. Paste one from linkedin.com/jobs/search, /jobs/search-results or /jobs/collections.") —
    **never** BE's `refused: `-prefixed wire string — clicks Save, asserts `validation-summary`
    appears with the row's label-prefixed text ("<label> — not a LinkedIn jobs search link",
    ux-notes:129) linking to the row, and `page.request.get` on the server doc shows it
    **unchanged** (nothing written — R4).
  - `search-url-intake: two links identical after cleaning show a duplicate note, merge on save,
    and the merged row is gone with no reload` (**extended this revision, judge item 1**) — fills
    two rows that clean to the same URL under different query-param noise, blurs both, asserts the
    second row's duplicate note + "Remove now" link, saves, and asserts (a) the server doc has
    exactly one bullet for that URL, (b) the success strip mentions "merged 1 duplicate", **and
    (c) the card itself renders exactly ONE row for that URL immediately after the save resolves —
    before any `page.reload()` — proving the PUT-echo re-seed replaced the client's stale 2-row
    state with the server's actual 1-row truth**:
    `await expect(section(page).locator('[data-qa^="search-url-row"]')).toHaveCount(1)`.
  - `search-url-intake: an empty card auto-adds and focuses one row` — captures the original
    `search_urls.md` text first (`fetchConfigText`), then seeds it to zero bullet rows
    (`page.request.put` with the doc's header-only text — **confirmed valid under BE's revised
    zero-rows guard**, which now throws only on an unparseable bullet-shaped line and treats a
    genuinely empty list as legal), navigates to the section, asserts exactly one row renders and
    its URL input is focused (`expect(input).toBeFocused()`), and **restores the captured original
    text in a `finally`** (matching `settings.spec.ts`'s own `fetchConfigText`/`putConfigText`
    capture-then-restore convention, §1 — this test mutates a shared `rajni` doc and must not leak
    state into a later test in the same suite run).

**Step 7 — MODIFY `ui/src/features/settings/DocFormGate.tsx` (+ `.test.tsx`) and
`SearchUrlsCard`/`WhereJobsComeFromSection` wiring — delivers S1 Loading/Error states + R13 (Must:
none directly; Should: R13)**
- Add one new optional prop to `DocFormGate`, mirroring the existing `loadingFallback` prop exactly
  (same file, same pattern, additive/backward-compatible — every current caller is unaffected):
  ```
  /** Rendered instead of the default "Couldn't load {doc}" line when
   * loadError is set. Mirrors loadingFallback's own precedent (added for
   * search-link-intake — R13/C9). */
  errorFallback?: ReactNode;
  ```
  `if (loadError) return <>{errorFallback ?? <p>...</p>}</>;` — the default branch text is
  unchanged for every other caller.
- `WhereJobsComeFromSection.tsx`'s inner (`search_urls.md`) `DocFormGate` now passes:
  `loadingFallback={<SearchUrlsSkeleton />}` (a small new 2-row skeleton composition, inline or as
  a one-off function in `SearchUrlsCard.tsx` — field-shaped `Skeleton`s matching the mockup's
  loading rows) and `errorFallback={<ErrorRetry message="Couldn't load search links."
  onRetry={() => searchUrlsQuery.refetch()} qa="search-urls-load-error" padded />}`.
- **R13 misfile notice + Re-file:** `misfiledCount = classifyRowsForDisplay(state.rows).filter(d =>
  d.kind === 'misfiled').length`. `onRefile()`: builds a new rows array where every `misfiled` row's
  `page` is rewritten to its classification's `page` (and `url` to `cleanedUrl` if also dirty),
  sets a local `isRefiling` state, calls `searchUrlsMutation.mutateAsync(serializeSearchUrlRows(
  refiledRows))` directly (bypassing `saveState.save()` — this is a save that doesn't require the
  form to be "dirty" in the usual sense). **FIXED this pass (Gate 4 item N4, MEDIUM — the same
  PUT-echo bug class Step 6's own save flow already fixed, judge item 1, missed here): on success,
  `state`/`savedState` are seeded from the mutation's OWN resolved response, via Step 5's
  `reseedRowsFromText`, never from the locally-built `refiledRows`** — a re-file can itself trigger
  a merge (two rows that only LOOKED distinct because one was misfiled under a different heading
  can turn out to classify to the same `page|cleanedUrl` key once corrected), so the server's
  post-re-file row count can be lower than `refiledRows.length`, exactly the scenario Step 6's own
  fix exists for:
  ```ts
  async function onRefile() {
    setIsRefiling(true);
    try {
      const refiledRows = /* ...build as above... */;
      const response = await searchUrlsMutation.mutateAsync(serializeSearchUrlRows(refiledRows));
      const reseeded = { lanes: state.lanes, rows: reseedRowsFromText(response.text) }; // Step 5's helper
      setState(reseeded);
      setSavedState(reseeded);
      setRefileSuccessMessage(`Re-filed ${misfiledCount} link${misfiledCount === 1 ? '' : 's'}.`);
    } finally {
      setIsRefiling(false);
    }
  }
  ```
  so the notice disappears and the SaveBar doesn't spuriously show "Unsaved changes" afterward
  (both `state` and `savedState` reflect the same, server-confirmed rows). `refileSuccessMessage`
  is its own local `useState<string | null>`, separate from `saveState.successMessage` (which only
  the hook's own `save()` can set) — passed into `SaveBar`'s existing `successMessage` prop as
  `successMessage={refileSuccessMessage ?? saveState.successMessage}` (Refile takes priority when
  both happen to be set; the two actions are never triggered in the same tick in practice), and
  its own one-off success message shows ("Re-filed N links.", ux-notes §6).
- **Done-condition + e2e (same `settings-search-link-intake.spec.ts` file):**
  - `search-url-intake: the card shows a skeleton while search_urls.md is loading, then resolves` —
    gates the `GET .../config/search_urls.md` route via `page.route` (mirrors the repo's own
    existing gated-loading test at `ui/e2e/settings.spec.ts:229-238`'s `releaseRoute` idiom),
    asserts skeleton rows are visible while gated, then releases and asserts the real rows render.
  - `search-url-intake: a failed load shows the Couldn't-load alert with a working Retry` — routes
    the GET to a 500 once, asserts the alert text + Retry button, clicks Retry, un-stubs, asserts
    the real rows render.
  - `search-url-intake: a misfiled link is flagged on load and Re-file fixes it in one click`
    (**fixed this pass — the import path/signature were wrong**) — a `page.request.put` seed goes
    through the real save path, which now normalizes/re-files on write (BE Steps 5-7), so a
    misfiled precondition can no longer be created that way. Seeds via BE's own named test-only
    fixture instead — `ui/e2e/seed_misfiled_search_url.ts` (**flat, sibling to `ui/e2e/seed.ts` —
    there is no `ui/e2e/fixtures/` directory; the earlier `./fixtures/seed_misfiled_search_url.ts`
    import path was wrong**), exporting `seedMisfiledSearchUrl(): Promise<void>` (**takes NO
    arguments** — it resolves `profiles/rajni` internally the same way `seed.ts` does, not from
    caller-supplied `dbPath`/`profileRoot` params; the earlier draft's `(dbPath, profileRoot)` call
    shape was wrong too — read the exact signature back from blueprint-be.md's own Step 5b before
    implementing, since its number is BE's to own): `import { seedMisfiledSearchUrl } from
    './seed_misfiled_search_url.ts'; await seedMisfiledSearchUrl();`. It opens `SqliteConfigStore`
    directly against `profiles/rajni` and bypasses `saveSearchUrlsDoc`/normalization entirely — the
    only remaining way to put a genuinely misfiled row in the DB post-fix. Then navigates to the
    section, asserts the misfile notice text + count ("1 link" / "Re-file 1 link" — ASSUMED
    singular per Step 4), clicks it, asserts the button shows "Re-filing…" then the notice
    disappears, and `page.request.get` confirms the server doc now files the link under
    `### linkedin__jobs-search-results`.
  - `search-url-intake: a re-file that merges duplicates shows one row without a reload`
    (**new this pass, Gate 4 item N4**) — seeds `search_urls.md` (via the same
    `seedMisfiledSearchUrl()` fixture, extended/parameterized if needed, or a second dedicated
    fixture call — confirm against the fixture's actual shipped shape at implementation time) with
    TWO links that are misfiled under DIFFERENT headings today but classify to the identical
    `page|cleanedUrl` key once correctly re-filed (i.e., a re-file that both corrects their heading
    AND merges them into one row server-side). Navigates to the section, asserts the misfile notice
    shows count 2, clicks "Re-file 2 links", and asserts — **before any `page.reload()`** — that the
    card renders exactly ONE row for that URL
    (`await expect(section(page).locator('[data-qa^="search-url-row"]')).toHaveCount(1)`, mirroring
    Step 6's own no-reload duplicate-merge assertion), the success message reads "Re-filed 1 link."
    (`misfiledCount` counted 2 INPUT rows, but Step 5's `reseedRowsFromText` is what determines the
    rendered row count post-merge — the success copy is built from `misfiledCount`, so this
    assertion also pins that the copy and the rendered state are allowed to diverge in this exact
    way, per ux-notes' own "Re-filed N links" wording being about links ACTED ON, not rows
    remaining), and `page.request.get` confirms the server doc has exactly one bullet for that URL.

**Step 8 — DELETE `ui/src/features/settings/sections/SearchUrlsSection.tsx` and
`SearchUrlsSection.test.tsx` (Must: none directly — repo hygiene the UX charter flagged)**
- Confirmed dead: `grep -rn "SearchUrlsSection" ui/src` (excluding the file itself and its own
  test) returns only comment-string references inside `WhereJobsComeFromSection.tsx` documenting
  its history — no importer anywhere. `SettingsPage.tsx:13,35` imports only
  `WhereJobsComeFromSection`. This is the file C9 ("loading/error render nothing") and the original
  `DEFAULT_SLUG`/protocol-host validation trace back to (`SearchUrlsSection.tsx:23,88`) — deleting
  it, rather than fixing it, is correct because it is unreachable: no route, no import, no test
  outside its own, ever renders it.
- Also strip the historical `SearchUrlsSection.tsx` cross-references inside
  `WhereJobsComeFromSection.tsx`'s doc comment (`:6-11`) down to a plain description of the current
  shape — mechanical comment cleanup, not a behavior change.
- **Done-condition:** `grep -rln "SearchUrlsSection" ui/src` returns nothing; `npm run ui:check`
  green. Not a screen/state step (removes an unreachable screen) — no e2e (there was none
  referencing it, confirmed by recon: `grep -rln "SearchUrlsSection" ui/e2e` returns nothing).

**Step 9 — MODIFY `ui/src/features/runs/runResult.ts` (+ `.test.ts`), pure**
- Add, alongside `getFunnelStages`/`getFailedStage`/`getFailureError`, the same
  defensive-narrowing pattern:
  ```
  export interface LinkSoftError { url: string; label?: string; reason: string }

  function isLinkSoftError(value: unknown): value is LinkSoftError {
    return (
      isRecord(value) &&
      typeof value.url === 'string' &&
      typeof value.reason === 'string' &&
      (value.label === undefined || typeof value.label === 'string')
    );
  }

  export function getLinkSoftErrors(result: unknown): LinkSoftError[] {
    if (!isRecord(result) || !Array.isArray(result.linkSoftErrors)) return [];
    return result.linkSoftErrors.filter(isLinkSoftError);
  }
  ```
  Returns `[]` (not `null`) on an absent/malformed field — matches "no panel" being the natural,
  zero-special-casing default at the call site (`array.length > 0` gate, no null check needed).
- **Done-condition:** `runResult.test.ts` gains cases — a `result` with 2 valid entries → both
  returned; a `result` with no `linkSoftErrors` key → `[]`; a malformed entry (missing `reason`) is
  filtered out, valid siblings survive. Pure module change — no e2e (not itself a screen).

**Step 10 — NEW `ui/src/features/runs/detail/BadLinksPanel.tsx` (+ `.test.tsx`)**
- Props: `{ links: LinkSoftError[] }`. Renders the mockup's S2 Default markup: an icon-circle (reuse
  `DiagnosisIcon`'s exact class shape from `DiagnosisPanel.tsx:93-106`, but inline here — extracting
  a shared `IconCircle` was considered and rejected, proportionality: one other call site, tint is
  the only variable, a 6-line duplication is cheaper than a new shared component for 2 users) tinted
  `bg-attention/10 text-attention-strong` (**not** `amber` — §1), title
  `` `${n} search link${n===1?'':'s'} failed — the run continued` ``, evidence line "A link that
  worked earlier today still loaded, so LinkedIn is fine — these links are the problem." (ux-notes
  §4 literal copy), a `<ul>` of up to 5 `{label ?? shortenedUrl(url)} · {mono shortenedUrl(url), title=full url}
  · {reason}` rows with a "+N more" trailer when `links.length > 5`, and an action row: primary
  `Button` "Fix in Settings" → `onClick={() => navigate({ name: 'settings', section:
  'where-jobs-come-from' })}`, secondary `Button variant="outline"` "Copy links" → clipboard-writes
  the newline-joined full URL list, `Copied` label flip for 2s on success (mirrors
  `DiagnosisPanel.tsx:201-211`'s existing swallow-on-denial pattern).
- `shortenedUrl(url)`: a small local helper — hostname + `…` + last path segment or query
  fragment, matching the mockup's `linkedin.com/jobs/…/Remote` illustration; exact truncation
  algorithm is this file's own judgment call (ASSUMED unattended, §8) — no spec/ux-notes rule
  dictates it beyond "middle-truncated, full URL in `title`."
- **Done-condition (RTL, colocated):** renders title with correct count/pluralization; renders ≤5
  items + "+N more" for a 6-item input; "Fix in Settings" click calls `navigate` with the exact
  route object; "Copy links" click writes the expected newline-joined string to
  `navigator.clipboard` (mocked) and flips its label. Not itself wired to a route — RTL only; e2e
  arrives at Step 11.

**Step 11 — MODIFY `ui/src/features/runs/RunDetailView.tsx` (+ `.test.tsx`) and
`ui/e2e/run-fixtures.ts` — delivers S2 (Should: R11)**
- Import `getLinkSoftErrors` from `./runResult`. After the existing catchup-slots block and before
  the `DIAGNOSIS_KINDS.has(kind) && <DiagnosisPanel/>` block, add:
  ```
  {getLinkSoftErrors(run.result).length > 0 && (
    <div data-testid="rundetail-bad-links-panel">
      <BadLinksPanel links={getLinkSoftErrors(run.result)} />
    </div>
  )}
  ```
  Gated on the data being present, **independent of `kind`** — correct per §3's layout note: BE
  Steps 14-15 only ever populate `linkSoftErrors` when the underlying pipeline `RunResult.outcome
  === 'passed'` (and only from a staleness-guarded side-doc read — BE Step 12's `writtenAt` guard),
  so a `'failed'`/`'crashed'` outcome (where `DIAGNOSIS_KINDS` would show the destructive
  `total-outage` panel instead) can never also carry this field — the two panels are mutually
  exclusive by construction, with no extra guard needed to enforce it.
- Widen `ui/e2e/run-fixtures.ts`'s `RunDetailFixture.result` type (`:105-106`) from
  `{ stages: FunnelStage[] } | null` to `{ stages: FunnelStage[]; linkSoftErrors?: { url: string;
  label?: string; reason: string }[] } | null` — additive/optional, every existing fixture literal
  in `run-experience.spec.ts` still type-checks unchanged.
- **Done-condition + e2e (NEW `ui/e2e/run-bad-links.spec.ts`, using the existing `mountSingleRun`
  route-stubbing idiom — matches `run-experience.spec.ts`'s own established pattern for run-detail
  states, not the real-server idiom `settings.spec.ts` uses, since a run's `result` blob is a
  read-only display fixture here, not something this feature writes):**
  - `run detail: a produced run with 2 soft-failed links shows the bad-links panel, and Fix in
    Settings navigates to the search-urls card` — `mountSingleRun` with
    `detail.result.linkSoftErrors` = 2 entries, asserts panel title text, both list rows'
    label/reason, clicks "Fix in Settings", asserts the hash becomes
    `#/settings/where-jobs-come-from`.
  - `run detail: a produced run with zero soft-failed links shows no bad-links panel` —
    `mountSingleRun` with `linkSoftErrors` absent, asserts
    `page.getByTestId('rundetail-bad-links-panel')` has count 0.
  - `run detail: a failed total-outage run shows the existing destructive panel, never the
    bad-links panel` — `mountSingleRun` with `status: 'failed'` and no `linkSoftErrors` (BE never
    populates it there), asserts `diagnosis-panel` is visible and `rundetail-bad-links-panel` has
    count 0 (contrast-frame parity with the mockup's explicit "drawn so the reviewer can see the
    two stay distinct").

**Step 12 — NEW this pass. MODIFY `ui/src/features/wizard/wizard.api.ts`,
`ui/src/features/wizard/steps/Step4Hunt.tsx`, `Step4Hunt.test.tsx`, `Step3About.test.tsx`, and NEW
test in `ui/e2e/wizard.spec.ts` — fixes a false `wizard-existing-config` regression BE's
normalization introduces (MEDIUM item, wizard caller)**
- **Root cause:** `Step4Hunt.tsx`'s `handleSubmit` (`:143-153`) locally serializes the wizard's
  rows (`serializeSearchUrls(entries)`), PUTs that text, and stores the SAME locally-serialized
  text into `writtenDocs['search_urls.md']` (`:151-153`) — discarding the PUT response entirely
  (`writeConfigDocText` currently returns `Promise<void>`, `wizard.api.ts:58-64`). The step's own
  never-clobber guard (`:143-146`) re-reads the live doc on the NEXT submit and compares it to
  `writtenDocs['search_urls.md']`; with BE's Steps 5-7 now normalizing every `search_urls.md`
  write, a link carrying an ephemeral param (e.g. `currentJobId`) gets stored CLEANED — different
  from the locally-serialized text the wizard remembered — so the guard's `ownWrite` check goes
  `false` and a Back-then-Next round trip falsely shows `wizard-existing-config`, exactly the
  regression `wizard.spec.ts:443-451`'s existing comment already documents fixing once before (for
  a different cause). **This blueprint's earlier revisions fixed the SAME class of bug for
  `WhereJobsComeFromSection.tsx` (§5 Step 6, judge item 1) but missed this second, independent
  caller of the same `search_urls.md` write path** — `Step4Hunt.tsx` never imports
  `searchUrls.model.ts`/`useConfigMutation`; it has its own parallel `serializeSearchUrls`/
  `wizard.api.ts` stack (confirmed by direct read — `wizard.types.ts`'s `SearchUrlEntry` is a
  separate, simpler type from this feature's `SearchUrlRow`).
- **`wizard.api.ts`:** widen `writeConfigDocText`'s return type from `Promise<void>` to
  `Promise<{ text: string }>`, returning `putConfigDoc`'s own resolved value directly (it already
  IS a `ConfigGetResponse`, a structural superset of `{ text: string }` — no new import needed):
  ```ts
  export async function writeConfigDocText(
    profile: string,
    doc: ConfigDocName,
    text: string,
  ): Promise<{ text: string }> {
    return putConfigDoc(profile, doc, text);
  }
  ```
  **Blast radius, confirmed by grep (`writeConfigDocText` has 2 real call sites, both in wizard
  steps):** `Step3About.tsx:187-188` also calls it (`resume.json`, `filter.json`) — both are
  **unaffected** by BE's normalization (only `search_urls.md` routes through `saveSearchUrlsDoc`;
  every other doc's `writeConfigDoc` path is unchanged, per blueprint-be §1's
  `SqliteConfigStore.writeText` stores-unmodified contract) — Step3About's own written-text
  round-trip stays byte-identical to what it sent, so its existing guard is not a bug and does not
  need this fix; only its TYPE needs to keep compiling (a caller is free to ignore an additional
  return value — no behavior change there).
- **`Step4Hunt.tsx`:** capture the response, store its `text`, not the locally-built one:
  ```ts
  const text = serializeSearchUrls(entries);
  const response = await writeConfigDocText(current.profile, 'search_urls.md', text);
  writtenDocs = { ...current.writtenDocs, 'search_urls.md': response.text };
  ```
- **New this pass (Gate 4 item N7, LOW): `Step4Hunt.tsx`'s own copy is now false.** Confirmed by
  direct read: `WARNING_MESSAGE` (`:27-29`) reads "This looks like a different LinkedIn page type;
  it will still be saved under linkedin__jobs-search." and the step's own helper paragraph
  (`:179-190`) reads "Every URL is filed under the `linkedin__jobs-search` page type, whose
  inventory lives at `src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json`." —
  **both were true only because the wizard used to hard-file every link under one page type**,
  exactly the bug this whole feature (R1/R2) exists to remove; once the wizard's own write goes
  through `saveSearchUrlsDoc` (this step, above), every link is filed under its OWN actual page
  type, so both strings are now false claims the wizard would be making to the user.
  - Rewrite `WARNING_MESSAGE` (plain words, per the coordinator's own phrasing) to:
    `'This looks like a different LinkedIn page type — it'll be filed under its own page type
    automatically.'` — keeps `isDifferentPageType`'s existing detection logic unchanged (still a
    useful non-blocking heads-up that "this isn't the typical /jobs/search shape"), only the
    CONSEQUENCE it describes changes from "forced under one type" to "filed under its own type."
  - Rewrite the helper paragraph to drop the now-false `<Badge>linkedin__jobs-search</Badge>` +
    inventory-path claim entirely (it can no longer name a single page type or a single inventory
    path, since it depends on what the user pastes) — plain words: "Add your saved LinkedIn job
    searches below. Each link is filed under its own page type automatically. Greenhouse and Keka
    need nothing configured — company discovery is automatic — so this step is about to turn on
    the **linkedin**, **greenhouse**, and **keka** lanes. You can leave every row blank; the ATS
    lanes still work with zero URLs." (keeps every OTHER claim in the paragraph unchanged — only
    the first two sentences, which made the now-false hard-filing claim, are rewritten).
  - Also update `isDifferentPageType`'s own doc comment (`:36-39`), which says "it just isn't the
    `/jobs/search/` shape the wizard files everything under" — same false premise, same fix: "it
    just isn't the `/jobs/search/` shape; every recognized LinkedIn jobs shape is still filed
    under its own correct page type once saved" (or equivalent — a code comment, not user-facing
    copy, so exact wording is this file's own judgment call, ASSUMED unattended, §8).
  - **Done-condition (test, `Step4Hunt.test.tsx:143-155`):** the existing
    `'a /jobs/collections/ URL shows the non-blocking warning AND still resolves true'` test's
    `toHaveTextContent` assertion is updated to the new `WARNING_MESSAGE` string, byte-exact —
    this IS the coordinator's requested "test asserting the new copy" (an existing test already
    pins this exact surface; there's no separate new test to add, only its expected string to
    correct). Confirm no other test file asserts the removed helper-paragraph/Badge text (grep
    `linkedin__jobs-search` in `Step4Hunt.test.tsx` — the other hits, `:317,339,418,425`, are
    `search_urls.md` document FIXTURES the test seeds/reads, unrelated to this UI copy, and stay
    unchanged).
- **Mechanical test-mock updates (3 call sites, confirmed by grep, no assertion logic changes
  beyond what's named below):**
  - `Step3About.test.tsx:213,298` — `vi.mocked(wizardApi.writeConfigDocText).mockResolvedValue(undefined)`
    → `mockResolvedValue({ text: '' })` (placeholder; no test in this file inspects the resolved
    value, only that the mock was called with the right args).
  - `Step4Hunt.test.tsx:72` — the shared `beforeEach` default. **Not a placeholder**: replace
    `mockResolvedValue(undefined)` with an implementation that ECHOES the text it's called with
    (`mockImplementation(async (_profile, _doc, text) => ({ text }))`) — this is the realistic
    default for every OTHER test in this file (an already-clean URL, where BE's rebuild is now
    contractually byte-identical to the wizard's own serializer for clean input — the BE contract
    change named at the top of this coordinator round), and it means the file's EXISTING
    round-trip test (`:370-409`, asserting `draftRef.current.writtenDocs` equals `writtenText`
    extracted from the mocked call's own sent argument, `:383-384`) **keeps passing unmodified** —
    the echo mock makes "what was sent" and "what the mock resolves with" the same value for that
    test's already-clean fixture URL, so no assertion there needs to change.
- **New regression test, same file, same `beforeEach`:** one test overrides the mock for a SINGLE
  call with a DIFFERENT resolved `text` than what was sent (`mockImplementationOnce(async () => ({
  text: CLEANED_TEXT }))`, where `CLEANED_TEXT` is the sent text with a `currentJobId` param
  stripped, simulating BE's normalization), then asserts `writtenDocs['search_urls.md']` equals
  `CLEANED_TEXT`, **not** the sent text — the direct regression assertion for this fix (RTL-level,
  faster and more precise than only an e2e for pinning the exact mechanism).
- **New e2e (SAME file `ui/e2e/wizard.spec.ts`, not a new file — extends the existing
  Back-then-Next coverage at `:442-472`, which only used an already-clean URL and so never
  exercised this bug):**
  ```
  wizard: step 4 Back-then-Next after a link with ephemeral params does not
  falsely flag wizard-existing-config
  ```
  Reuses the file's own local helpers (`createProfileStep`, `pickPersonaStep`, `fillAboutStep`,
  `submitAboutStep` — all already land on step 4, `:80-83`) to reach step 4, fills
  `https://www.linkedin.com/jobs/search/?keywords=backend&currentJobId=123456` (an ephemeral param
  the wizard's own `serializeSearchUrls` does NOT strip locally — only BE's server-side
  normalization does), submits (`clickNext`) to step 5, `clickBack` to step 4, `clickNext` again,
  and asserts `page.getByTestId('wizard-existing-config')` has count 0 — the exact false-positive
  this fix prevents. Registers its throwaway profile in `createdProfiles` for the file's existing
  shared `afterEach` cleanup (`:21-27`), same as every other test in the file; `wizard.spec.ts`
  writes to its own throwaway profiles, not the shared `rajni` docs, so it is (correctly) already
  excluded from `SHARED_DOC_SPECS` — no config change needed there.
- **File-size caps, confirmed by `wc -l` at revision time:** `wizard.api.ts` 112/400 (+~3 lines);
  `Step4Hunt.tsx` 255/400 (+~2 lines for the write-path fix, roughly **net neutral** for the N7
  copy fix — the helper paragraph loses its `<Badge>`+`<code>` inventory-path JSX (~6 lines) but
  gains a couple of rewritten sentences of similar length, and `WARNING_MESSAGE`/the doc comment
  are same-shape string rewrites, not new lines — projected ≈257/400); `Step4Hunt.test.tsx` 447/800
  (+1 changed line for the write-path fix, +1 changed assertion string for N7 — same test, no new
  one — +~35-line new regression test ≈ 483/800); `Step3About.test.tsx` 387/800 (2 one-line value
  changes, no growth); `wizard.spec.ts` 473/800 (+~30-line new test ≈ 503/800). Every file stays
  comfortably under cap — no split named.
- **Done-condition:** `Step4Hunt.test.tsx`'s existing round-trip test (`:370-409`) passes
  unmodified; the new regression test in the same file asserts `writtenDocs['search_urls.md'] ===
  CLEANED_TEXT`, not the sent text; the new `wizard.spec.ts` e2e passes with
  `wizard-existing-config` never appearing across the ephemeral-param Back-then-Next round trip;
  `Step3About.test.tsx` and `wizard.api.test.ts` (unaffected — its own `writeConfigDocText` test,
  `:178-189`, already mocks `fetch` to resolve `{ text: '# Search URLs\n' }` and asserts only the
  fetch call args, not the function's return value) pass unmodified. `npm run ui:check` green
  (confirms the `noUncheckedIndexedAccess`-safe widened return type compiles across all 3 real
  call sites).

---

## 6. Requirements Coverage

| # | Requirement | MoSCoW | UI delivery | e2e id (screen/state Musts/Shoulds) |
|---|---|---|---|---|
| R1 | Dependency-free classify+clean core module | Must | **BE-owned** (blueprint-be Step 1); UI imports it, Step 2 | n/a (no UI screen of its own) |
| R2 | Board Settings files by derived page type, `DEFAULT_SLUG` gone | Must | Steps 1, 6 (`DEFAULT_SLUG` deleted, `addRow` no longer hard-codes a page) | `search-url-intake: pasting a dirty search-results link shows the Search results badge...` |
| R3 | Board API + `config set` normalize/report on save | Must | **BE-owned** (Steps 2,4,5,6,7); UI renders the report, Steps 5-6 | same test above (asserts server-side re-filing) |
| R4 | Every save path rejects an unclassifiable link, nothing written | Must | Steps 2, 3, 5, 6 (client pre-save block) + BE's server-side 422 as defense in depth | `search-url-intake: an unrecognised link is refused inline and blocks Save` |
| R5 | `lane add-url` delegates to R1 | Must | **BE-owned** (Step 3) — no UI | n/a |
| R6 | Canary downgrades an all-fail leftover set to soft errors | Must | **BE-owned** (Steps 8,9,10) — no UI | n/a |
| R7 | A genuine outage still fails loud | Must | **BE-owned** (Step 10) — no UI | n/a |
| R8 | One-time `harish` repair, dry-run + approval | Must | **BE-owned** (Step 17) — no UI | n/a |
| R9 | Settings shows derived page type + cleaned/refused feedback | Should | Steps 2, 3, 6 | `search-url-intake: pasting a dirty search-results link...` (badge+cleaned); `...an unrecognised link is refused inline...` (error) |
| R10 | Identical-after-cleaning links collapse on save | Should | Steps 2, 3, 6 (client warning) + BE Step 2 (actual merge) | `search-url-intake: two links identical after cleaning show a duplicate note, merge on save, and the merged row is gone with no reload` |
| R11 | Digest/run detail names soft-failed links | Should | Steps 9, 10, 11 (run-detail panel only — digest text is BE Step 16, no UI) | `run detail: a produced run with 2 soft-failed links shows the bad-links panel...`; `...a failed total-outage run shows the existing destructive panel...` |
| R12 | Docs-as-code updated in the same change | Should | **BE-owned** (blueprint-be Step 18 covers the whole diff via kb-curator) — no separate UI docs step | n/a |
| R13 | Existing misfiled links flagged on Settings load | Could | Steps 2, 4, 7 | `search-url-intake: a misfiled link is flagged on load and Re-file fixes it in one click` |

Every spec Must/Should is mapped; every screen/state-delivering step above carries its e2e id in the
same step (§5). No Must falls in a seam between this blueprint and blueprint-be.md's.

**Step 12 is a regression guard, not a new-requirement row.** It doesn't deliver a spec Must/Should
of its own — it keeps an EXISTING screen (the setup wizard's step 4) working once R3's server-side
normalization (BE-owned) starts changing what `search_urls.md` actually stores. It is, in effect,
R3's "every save path" clause applied to a THIRD caller of the same endpoint that neither this
blueprint's original pass nor blueprint-be.md's own scope named explicitly (the wizard is
board-API-adjacent but not part of the Settings screen this feature's spec scoped to) — recorded
here rather than invented a new requirement ID for it.

---

## 7. Mockup Divergences

- **`settings-savebar` / `settings-save-success` / `settings-validation-summary` id naming.** The
  mockup's illustrative data-qa names don't match the real, already-shipped components' real ids
  (`save-bar`, `save-success-line`, `validation-summary`). This blueprint reuses the real ids —
  renaming shipped, already-e2e-covered components to match a new mockup's naming would be a
  regression risk for zero benefit (every other Settings section already depends on the current
  names). Justified against the feasibility gate: achievable-with-work either way, reuse wins.
- **`digest-bad-links-block` has no UI implementation.** It's server-formatted text
  (`formatDigest`, blueprint-be Step 16) rendered inside a Telegram chat bubble the mockup itself
  marks as "not board UI, has no repo token" (ux-notes E2). Nothing is cut — the block simply has
  no React component to map, by the feature's own architecture.
- **`run-bad-links-panel` is a new sibling component, not a literal reuse of `DiagnosisPanel`.**
  Visually matches the mockup's `.diag-panel.is-attention` idiom exactly (icon circle, title,
  evidence line, action row) — the divergence is internal (component boundary), not visible in the
  rendered UI. Justified in §2's table row and restated here per the mockup-conformance pass:
  re-reading the mockup against this choice, the rendered DOM shape, copy, and tint match; only the
  React component identity differs from what a naive "same visual idiom, so same component" reading
  might assume.
- **No other divergence found.** Every row sub-state, card state, button, and copy string in
  mockup.html §S1/S2 has a corresponding step and component-mapping row above; nothing shown in the
  mockup is deliberately left unbuilt.

---

## 8. Risks & Assumptions

- **A-1 (paste-vs-blur detection mechanism, Step 6).** ux-notes §6 requires "classify on blur OR
  paste"; this blueprint leaves the exact DOM-event wiring (native `InputEvent.inputType` check vs
  an `onPaste` handler) to the executor as an implementation detail — both satisfy the same
  observable contract (paste classifies immediately, typing does not), and the RTL/e2e tests in
  Steps 3 and 6 pin the OBSERVABLE behavior, not the mechanism. ASSUMED (unattended).
- **A-2 (row-state overlap precedence, Step 2).** ux-notes' "one row, one sub-state" model doesn't
  resolve what happens when a row is simultaneously misfiled AND has cleanable params AND is a
  duplicate. This blueprint's precedence (duplicate > misfiled > cleaned > clean) is a judgment
  call, documented in Step 2. ASSUMED (unattended) — low risk: the mockup never shows this overlap,
  and every individual sub-state's rendering is independently correct regardless of precedence
  order.
- **A-3 (empty-state focus mechanism, Step 6).** Plain `autoFocus` rather than an imperative ref —
  simpler, matches React's own idiom for "focus once on mount," and the mockup's own `<input
  autofocus>` attribute (`mockup.html:287`) is the direct precedent. ASSUMED (unattended).
- **A-4 (BadLinksPanel URL-shortening algorithm, Step 10).** No spec/ux-notes rule beyond "middle-
  truncated, full URL in title" — left as an implementation detail with a pinned observable contract
  (title always carries the full URL) rather than a pinned algorithm. ASSUMED (unattended).
- **A-5 (sequencing dependency on blueprint-be.md).** Steps 2 and 6 assume BE Steps 1 and 7 are
  merged (or at least type-declared) — `ConfigGetResponse`'s widened `{text, report?}` shape
  (Step 7) and `classifyLinkedInSearchUrl`'s exact export shape (Step 1) are both cross-repo-layer
  dependencies this blueprint cannot satisfy on its own; Step 7's UI-side R13 e2e (§5) additionally
  depends on `ui/e2e/seed_misfiled_search_url.ts` existing — owned and authored by a
  dedicated blueprint-be step (added in parallel with this revision; cite that step's own number
  from blueprint-be.md's current Implementation Steps §5 at implementation time, not a fixed one
  pinned here). This is normal build-order sequencing (BE ships first per the pipeline's own stage
  order), not a gap.
- **A-6 (DiagnosisPanel/BadLinksPanel visual-duplication cost).** §2/§9's icon-circle duplication
  (6 lines, 2 call sites) is deliberately not extracted into a shared component — if a third
  attention-tinted panel appears in a future feature, this becomes a 3-site duplication worth
  revisiting; not a concern at 2.
- **A-7 (new this revision — file-cap verification, judge item 3's discipline applied to every
  file this blueprint extends).** `wc -l` run against disk at revision time:
  `WhereJobsComeFromSection.tsx` 322/400, `WhereJobsComeFromSection.test.tsx` 169/800,
  `DocFormGate.tsx` 59/400, `DocFormGate.test.tsx` 72/800, `searchUrls.model.ts` 71/400,
  `searchUrls.model.test.ts` 93/800, `runResult.ts` 109/400, `runResult.test.ts` 284/800,
  `RunDetailView.tsx` 273/400, `RunDetailView.test.tsx` 406/800, `run-fixtures.ts` 333/400 (capped
  at IMPL, not TEST — `test/invariants/filesize.test.ts`'s `capFor` keys off the `.test`/`.spec`
  filename suffix, not directory, and `run-fixtures.ts` has neither), `DiagnosisPanel.tsx` 322/400
  (untouched by this blueprint). `WhereJobsComeFromSection.tsx` was already at 80% of its cap
  BEFORE this feature's substantial new save/blur/refile logic — Step 5's extraction of
  `searchUrlsSave.ts` (new, this revision) exists specifically to keep Step 6's net addition small
  (moving row-list JSX to `SearchUrlsCard.tsx`, Step 4, removes more lines than Steps 6-7's
  combined new handler logic adds back, but the margin was thin enough — an unverifiable
  pre-implementation line estimate — to warrant the same "extract into a colocated pure file"
  discipline the BE revision itself just demonstrated, rather than risk crossing 400 and needing a
  second, unplanned split mid-implementation). Every other extended file has comfortable headroom
  (`run-fixtures.ts`'s one-line optional-field widening; `RunDetailView.tsx`'s one new ~8-line
  conditional block; `runResult.ts`'s one new ~15-line narrowing function) — no further split
  named. ASSUMED (unattended): if actual implementation still pushes `WhereJobsComeFromSection.tsx`
  past 400 despite Step 5's extraction, the next cut is the empty-state auto-add effect plus the
  `onBlurUrl`/`onPaste` wiring into a second colocated hook — flagged here as the named fallback,
  not built pre-emptively (YAGNI: the estimate says it isn't needed).
- **Projected line count for `WhereJobsComeFromSection.tsx` at `lineWidth: 90` (`ui/biome.json`,
  confirmed) — requested this pass, walked through explicitly rather than re-asserted:** baseline
  322. **Removed:** the inline row-list JSX (`:240-304` today, ~65 lines) moves to `SearchUrlsCard`
  (Step 4) → 257. **Added**, each estimated at the 90-char format width the rest of this
  blueprint's own code snippets already assume: `onBlurUrl` classify/rewrite handler (~10),
  paste-detection wiring (~9), the empty-state auto-add `useEffect` (~12), `onRemoveNow`'s
  one-line delegate (~1), the PUT-echo save flow's net growth over the pre-feature
  `saveSearchUrls`/`onSave` pair (§5 Step 6 — capturing the mutation response and reseeding both
  `state`/`savedState`, ~+15 over today's simpler pair), the success-strip call-out to Step 5's
  `buildSearchUrlsSuccessMessage` plus its fallback branch (~7 — small precisely BECAUSE Step 5
  owns the clause-building logic, not this file), the save-error call-out to Step 5's
  `mergeServerRefusal` plus its `ValidationSummary` wiring (~5), rendering `<SearchUrlsCard>` with
  its full prop list in place of the removed JSX's own wrapper (~15, net +10 over a bare `<Card>`),
  `DocFormGate`'s new `loadingFallback`/`errorFallback` props (Step 7, same file, ~7), the R13
  misfile-count + `onRefile` handler (Step 7, ~17), the restored protocol pre-check inside
  `validateRow` (this pass's own fix — net **+3** over the ALREADY-PLANNED classify-based
  `validateRow`, since most of the protocol-check's lines replace, not add to, the
  already-counted classify branch), and ~7 new import lines across Steps 4-7's additions. **Revised
  this pass (Gate 4 item N4):** the R13 misfile-count + `onRefile` handler (Step 7) grows from the
  prior estimate's ~17 to **~24**, to cover its own PUT-echo re-seed (`reseedRowsFromText` call,
  `refileSuccessMessage` local `useState`, and the `finally`-wrapped `isRefiling` toggle) — the
  SAME fix class as Step 6's own save flow, now applied here too. Sum of additions ≈ 110.
  **Projected total: 257 + 110 ≈ 367/400** — still comfortable margin (~33 lines), and the number
  the file-cap discipline above (Step 5's extraction) is specifically sized to protect. If
  implementation lands materially higher, A-7's own named fallback split still applies.
- **A-8 (new this revision — empty-label fallback for the ValidationSummary refusal message).**
  `buildValidationSummaryRefusalMessage`'s `label.trim() || 'This link'` fallback (Step 2) covers a
  row whose Label field is still blank when it's refused — neither the mockup nor ux-notes shows
  this combination (every mockup row has a label filled in). ASSUMED (unattended) — low risk: the
  fallback only ever changes the ValidationSummary LINK TEXT for an edge case; the fix (clear the
  URL, or fill in a recognized one) is identical regardless of wording, and the inline `FieldError`
  under the row (always `FIELD_ERROR_COPY`, label-independent) already names the fix precisely.

---

## 9. Engineering Quality Gates

- **Determinism.** `classifyRowsForDisplay` and `getLinkSoftErrors` are pure functions of their
  inputs (rows array, result blob) — no `Date.now()`/`Math.random()` in any render path this
  blueprint adds; the same `(rows, touched)` pair always renders the same badges/notes, and the
  same `RunDetail.result` always renders the same bad-links list in the same order (server order
  preserved, no client-side re-sort).
- **Fault tolerance.** `DocFormGate`'s existing `loadError` branch (now with the new
  `errorFallback` prop, Step 7) is the error boundary for `search_urls.md`'s GET — the user-visible
  failure state is `ErrorRetry`'s "Couldn't load search links." + a working Retry button that calls
  `refetch()`, reusing the exact shared component 4+ other surfaces already use
  (`ErrorRetry.tsx`). A save-time failure (422 or network) never unmounts the form or the SaveBar
  (`useSectionSaveState`'s existing "never disabled" contract, unchanged) — the user always has a
  path back to a working state.
- **Design-token sync.** Zero hardcoded hex anywhere in this blueprint's new code — every color is
  a Tailwind utility resolving to an existing `--*` custom property (`--attention`/
  `--attention-strong` for the new notices/panel, `--destructive`/`--destructive-strong` for
  errors, `--success`/`--success-strong` for the existing save-success strip, `--muted-foreground`
  for cleaned notes), confirmed present in `ui/src/index.css` (§1). Every spacing/size value is
  drawn from ux-notes §1's Design Scale (`gap-1`/`gap-1.5`/`gap-2`/`gap-3`/`gap-4`, `p-3`/`p-4`,
  `h-8`/`h-9`/`h-5`, `w-48`, `rounded-lg`/`rounded-xl`/`rounded-4xl`) — no bespoke pixel value
  anywhere in §5.
- **Micro-optimizations.** Row edits (`updateRow(index, patch)`) replace only the single changed row
  object in the array (existing `prev.map` pattern, unchanged) — sibling rows keep referential
  identity across a keystroke, so React doesn't re-render or re-mount unrelated `SearchUrlRow`
  instances. `classifyRowsForDisplay` runs `new URL()` parsing only on **touched** rows (typing
  never triggers it, per the `touched` gate in Step 2) — an N-row card with M untouched rows pays
  the classify cost only for the `N-M` touched ones, not all `N` on every keystroke. Trigger for a
  full re-render of the card: `state.rows` array reference change (add/remove/blur-commit), never a
  per-character typing event beyond the single controlled `Input`'s own re-render.
- **Asynchronous UX.** `search-urls-skeleton` wires to `searchUrlsQuery.isPending` (the GET fetch,
  via `DocFormGate`'s `isLoading`); `search-urls-load-error` wires to `searchUrlsQuery.isError`
  (via `DocFormGate`'s `loadError`); the success strip wires to `searchUrlsMutation` resolving (the
  PUT fetch, via `mutation.data?.report`); the Re-file button's "Re-filing…" busy state wires to its
  own local `isRefiling` flag around a dedicated `mutateAsync` call, independent of the main
  SaveBar's `isSaving` (so a Re-file in progress doesn't block or get confused with an unrelated
  in-flight normal Save). The run-detail bad-links panel has no async state of its own — it renders
  synchronously off the same `RunDetail` fetch the rest of the page already waits on (§3's layout
  note: "the panel waits on the same fetch," no panel-specific skeleton, matching ux-notes §4's
  explicit Loading-state rule).

---

## 10. Out of Scope

Unchanged from spec §14 and blueprint-be §10 — live preview at save time, per-link health
tracking/quarantine, read-time URL routing in the pipeline parser, degraded-run status for ATS
lanes, page types beyond the two existing inventories, a manual page-type override, generic
tracking-parameter stripping, and (blueprint-be's own additions) refactoring the pipeline's
read-only parser to share code, wiring the canary into breaker state, and any change to `config
export`/`import`'s byte-exact behavior. Additionally, from this blueprint's own pass:
- Extracting a shared `Notice` component for the 4th attention-tinted ad-hoc `<div>` (§2) — 3
  existing call sites already accept the duplication; proportionality argues against a 4th forcing
  an abstraction.
- Extracting a shared icon-circle component between `DiagnosisPanel` and `BadLinksPanel` (§9's A-6)
  — 2 call sites, revisit at a 3rd.
- Any mobile/responsive layout for either screen — none of the 11 existing Settings sections nor
  the run-detail page has one; this feature doesn't introduce the first.
