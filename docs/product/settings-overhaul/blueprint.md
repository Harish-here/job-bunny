# Blueprint — UI (`settings-overhaul`)

Slug: `settings-overhaul` · Author: product-ui · 2026-08-18
Spec: `spec.md` (authoritative) · UX: `ux-notes.md` + `mockup.html` · BE: `blueprint-be.md`
(amended, CLEARS WITH CONDITIONS) · State: `.state.md`

**Amendment: 2026-08-18, post UI-blueprint-gate ruling `rulings/ui-gate-r1.md` — verdict
BLOCKED.** Findings F1–F10 are amended inline and dispositioned by ID in **§Dispositions**
(end of file) — read that section for exactly what changed. The judge's own read: contract
fidelity, the 89-id completeness count, the R20 design, and the Design-token correction all
**survived** hostile verification unchanged; the defects were concentrated in omission (no
Landing steps, four orphaned e2e tests, a duplicate-module near-miss, three inert-passing
controls, an understated BE dependency, missing empty-state coverage), not invention. This
amendment adds what was missing; it does not rework what cleared.

**Ratified since the BE gate (relayed by the orchestrator, not reopened here):**
R20 = **Option 1** — board-initiated detached spawn. Start, Stop, and Autostart **all** ship
from the board, with the corrected costs accepted (blueprint-be §0(c)/F9: Start can take up
to ~35s worst-case). This blueprint designs the Daemon card's real controls only —
ux-notes' S6b "R20 fallback variant" (`daemon-start-fallback`) is **not built**; see Mockup
Divergences.

---

## 0. Stack Summary

CHANGE TO EXISTING. No stack question — inherited and confirmed by direct read (not
recon-inherited from spec/UX prose):

- **Framework/build**: React 19, Vite, TypeScript (strict, erasable syntax). Confirmed:
  `ui/package.json` (`react: ^19`, `react-dom: ^19`), `ui/src/main.tsx`.
- **Styling**: Tailwind v4, tokens in `ui/src/index.css` (`@theme inline` + `:root`/`.dark`).
  **Correction to ux-notes §3's Design Scale table**: the CSS also defines
  `--attention-strong` (`#a04a06` light) and `--success-strong` (`#26703f` light,
  `index.css:33,36,83,86`), used today as **text** color (`ScheduleSection.tsx:176,178,
  181,206,207,218` — corrected citation, UI-gate F10; `DangerZone.tsx:77`,
  `SearchUrlsSection.tsx:132`) precisely because plain
  `--attention`/`--amber` fail 4.5:1 as body text — the exact rule ux-notes' own
  Accessibility section (§14) already states. This blueprint uses `text-attention-strong` /
  `text-success-strong` for every status **word**, and plain `attention`/`amber`/`success`
  only for dots, icons, tints and 1–2px borders, reconciling ux-notes' Design Scale table
  with its own accessibility rule and with the shipped convention. Recorded as a Design-scale
  correction, not a new token.
- **Components**: shadcn (`ui/components.json`: style `radix-nova`, icon library `lucide`,
  aliases `@/components/ui`, `@/lib`), Radix via the `radix-ui` meta-package (no per-primitive
  `@radix-ui/*` deps — `ui/package.json`). Add command convention: `npx shadcn@latest add
  <name>` (`ui/package.json` carries `shadcn: ^4.16.1` as a direct dependency; `components.json`
  points at `ui.shadcn.com`'s schema).
- **State/data**: TanStack React Query v5 (`queryOptions` + `useQuery`/`useMutation`,
  confirmed in `config.queries.ts`, `useConfigMutation.ts`, `wizard.queries.ts`,
  `hub.queries.ts`). No global client state library — profile selection lives in
  `localStorage` + a query (`shell/profiles.queries.ts`, not read for this blueprint's scope
  beyond citing the pattern).
- **Routing**: a hand-rolled hash router, `ui/src/lib/router.ts` — `ROUTES` const array +
  `SettingsSection` union, `parseHash`/`routeHash`/`navigate`/`useRoute` (`useSyncExternalStore`
  over `hashchange`). No router library, confirmed by full read.
- **API boundary**: `ui/src/lib/api/client.ts` (`getJson`/`putJson`/`postJson`/`deleteJson`/
  `patchJson`, `ApiError{status,code,message}`) + `ui/src/lib/api/types.ts` — a **type-only**
  barrel re-exporting response shapes from `src/app/features/<x>/index.ts`. This is the
  established seam every new endpoint in this blueprint follows (§State & Data).
- **e2e harness**: Playwright, `ui/e2e/*.spec.ts`, driven against the **real board server**
  over the `rajni` fixture profile (never `harish`). Confirmed by full read of
  `ui/e2e/settings.spec.ts` — **12 tests** (corrected, UI-gate F2; verified via `grep -c
  "test(" ui/e2e/settings.spec.ts` → 12, not the 14 this document previously stated): the
  idiom is (1) `page.goto('/#/settings/<section>')`, (2) drive the real form via
  `getByRole`/`getByLabel`/`getByTestId`, (3) assert the **server** round-trip via
  `page.request.get`, never the form's own echo, (4) restore the original doc text in a
  `finally` (fixture DB isn't reset per-test, only per-suite-run — `seed.ts`'s
  `globalSetup`), (5) `data-qa` locators (`page.locator('[data-qa="…"]')`) are used
  specifically for **state** discrimination (loading/error/degraded/healthy — see
  `schedule-daemon-status-*` in `settings.spec.ts:270-363`), while `data-testid` is used for
  structural elements. This blueprint's e2e steps follow the same split: `data-qa` on every
  region the mockup names (already required by the render contract), `data-testid` added only
  where a test needs to disambiguate a repeated element the `data-qa` id doesn't already
  uniquely key. Every one of `settings.spec.ts`'s 12 tests and `hub.spec.ts`'s 6 tests has an
  explicit survive/adapt/replace disposition in the new **§e2e Disposition Ledger** (added
  this amendment, UI-gate F2/F3) — no test is silently orphaned.
- **File-size gate**: `test/invariants/filesize.test.ts:11-12,48-50` — impl cap 400 lines, test
  cap 800 lines, glob-scoped over `src/`, `test/`, `ui/src/`, `ui/e2e/` (test files matched by
  `*.test.ts(x)`/`*.spec.ts(x)`). Confirmed by direct executor-fast read, not assumed from
  CLAUDE.md's prose.
- **Existing settings/hub architecture**, confirmed by full reads (not summaries): `SettingsPage.tsx`
  (Tabs-based, 6 sections, one `JsonEscapeHatch` dialog per doc-backed section, dead
  `PLACEHOLDER_COPY` at :30-34), `useDocForm.ts`/`useConfigMutation.ts`/`DocFormGate.tsx`
  (the shared read-modify-write seam every JSON-doc section uses — **reused unchanged** by
  every new JSON-doc section in this blueprint), `FiltersSection.tsx`/`ProfileSection.tsx`/
  `ScheduleSection.tsx`/`ResumeSection.tsx`/`SearchUrlsSection.tsx`/`DangerZone.tsx` (existing
  per-section forms this blueprint redistributes, not rewrites from scratch), `hub.model.ts`/
  `HubPage.tsx`/`hub.api.ts`/`hub.queries.ts` (the doctor-projection this blueprint's Operate
  page supersedes), `Sidebar.tsx` (`NAV_ITEMS` array — the sidebar this blueprint edits, not
  replaces), `wizard.types.ts`/`wizard.api.ts`/`wizard.queries.ts` (`DaemonStatus` shape,
  `RunIntentOutcome`'s typed-outcome pattern — the **precedent this blueprint's R20 outcome
  handling reuses verbatim**, cited at point of use), `ui/src/features/runs/runResult.ts`
  (109 lines — corrected this pass, R2-F4; `wc -l` confirms 109, not the 183 this document and
  `ui-gate-r1.md` both stated, an error `ui-gate-r2.md` traced back to r1 and overruled there —
  full read, added this amendment — UI-gate F5: the **existing** module that
  already exports `getFunnelStages`/`getBiggestDrop`/`newMatchCount`/`computeRetention` over
  `RunDetail.result`'s opaque `unknown` shape, reused verbatim by Landing's new steps rather
  than mirrored into a second module — see its own header, quoted at point of use).

### Component gap check (shadcn primitives available vs. vendored)

Confirmed by direct scan of `ui/src/components/ui/` (19 files) plus a repo-wide grep for
each candidate primitive's usage anywhere in `ui/src` (not just `components/ui/`):

| Primitive | Status | Verdict for this blueprint |
|---|---|---|
| Button, Card, Badge, Switch, Input, Textarea, Select, Form (`Field`/`FieldLabel`/`FieldControl`/`FieldError`/`FieldDescription`), Dialog, Accordion, Skeleton, Separator, Popover, Tabs | Vendored | **existing**, reused as-is |
| RadioGroup | **Not vendored** | **add-primitive** — `npx shadcn@latest add radio-group` (needed once, for the pacing-preset group, §Component Mapping S3) |
| Alert | **Not vendored** | **add-primitive** — `npx shadcn@latest add alert` (needed once, for the conflict notice / validation summary / fast-pacing warning family, §Component Mapping S2/S3/S8) |
| Checkbox | Not vendored | **Not added.** Existing convention is a bare `<input type="checkbox">` styled inline (`FiltersSection.tsx` work-types, `ProfileSection.tsx` lanes) — every checkbox this blueprint needs (work-types, the pacing "I understand" ack) follows that convention. Reuse-first: adding a new primitive here would contradict the repo's own established pattern. |
| Table | Not vendored | **Not added.** The repo's convention for tabular data is a purpose-built plain `<table>` styled with Tailwind utilities per use (confirmed: `ui/src/features/runs/detail/FunnelTable.tsx`, the exact idiom ux-notes §5 cites as precedent for the caps/limits tables). Every `.tbl`-shaped mockup region in this blueprint is its own small purpose-built table component, matching `FunnelTable.tsx`'s idiom, not a shared generic `Table`. |
| Label, Tooltip, DropdownMenu, Collapsible | Not vendored | **Not added.** Label: covered by `Field`/`FieldLabel` + native `<label>`/`field-label` spans already in use. Tooltip/DropdownMenu: no mockup region needs either. Collapsible: the mockup's two disclosures (pacing advanced fields, Setup & health card) are single-item `Accordion` usages — the vendored `Accordion` primitive already covers this exactly (`AccordionItem` with one item). |

**GREENFIELD note: not applicable.** This repo has a full existing UI inventory; reuse-first
is in full force, not suspended.

---

## 1. Component Mapping

Keyed by every `data-qa` id in `mockup.html`. **Verified count**: `grep -o 'data-qa="[^"]*"'
docs/product/settings-overhaul/mockup.html | sort -u | wc -l` → **89** unique ids (not 87 —
the dispatch's figure is corrected here; see NOTES). Row count below: **89**. Assertion: **89
= 89, complete.**

Legend — Verdict: `existing` (real component/file already covers this), `add-primitive`
(shadcn primitive not yet vendored, exact command given), `new` (justified below), `deferred`
(mapped but not built this spec, reason given).

### Shell / nav (6 ids)

| data-qa | Mockup element | Real component | Props/variants | Verdict | Design Scale |
|---|---|---|---|---|---|
| `settings-shell` | outer two-column app shell | The mockup shows the **global** app shell (sidebar + content) for context; the global sidebar is `Sidebar.tsx` (existing, edited — §Impl step 1) and is **out of this id's scope**. This id attaches to the new `ui/src/features/settings/SettingsShell.tsx` wrapper — the settings-specific nav+main two-column region only. | `grid-template-columns: 224px 1fr` | new | `w-56`/224px nav, `p-6` main |
| `settings-nav` | left nav column | `ui/src/features/settings/SettingsNav.tsx` | 4 groups × sections, `aria-label="Settings sections"` | new | `bg-sidebar`, `p-3`, nav item `h-8` |
| `settings-nav-group-aim` | "Aim" group | `SettingsNav.tsx` (one of 4 group renders) | label `text-[10px] uppercase` | new | — |
| `settings-nav-group-runs` | "Runs" group | `SettingsNav.tsx` | same | new | — |
| `settings-nav-group-output` | "Output" group | `SettingsNav.tsx` | same | new | — |
| `settings-nav-group-advanced` | "Advanced" group | `SettingsNav.tsx` | same | new | — |

### S1 — Landing (10 ids, incl. `scope-chip-profile`/`settings-search` shared header)

| data-qa | Mockup element | Real component | Props/variants | Verdict | Design Scale |
|---|---|---|---|---|---|
| `scope-chip-profile` | "Profile: harish" badge | `Badge` (existing, `components/ui/badge.tsx`), `variant="secondary"` | text `Profile: {profile}` | existing | `bg-muted` |
| `settings-search` | search input | — | R26 is **Could**, tail-slot only (spec §12 "Tail — ship only if cheap"); not promoted (§NOTES — no re-test evidence to promote it). | **deferred** — see Mockup Divergences | — |
| `landing-thin-run` | thin-run hero card | `ui/src/features/settings/sections/LandingSection.tsx` (inline card) | reads run funnel + soft-errors | new | `Card`, `text-2xl font-heading` hero number |
| `landing-caps-table` | 4-row caps table | `ui/src/features/settings/sections/LandingCapsTable.tsx` | plain `<table>`, `FunnelTable.tsx` idiom | new | `.tbl` `border-b text-xs` |
| `landing-cap-row-max-new-per-lane` | one table row | `LandingCapsTable.tsx` (row) | binding badge conditional | new | `badge` on-primary `bg-accent text-primary` |
| `landing-cap-row-max-probes-per-run` | row | `LandingCapsTable.tsx` | — | new | — |
| `landing-cap-row-max-cards-per-url` | row | `LandingCapsTable.tsx` | — | new | — |
| `landing-cap-row-max-age-days` | row | `LandingCapsTable.tsx` | copy states "gates freshness", never "caps jobs" (F10-amended) | new | — |
| `landing-rules-summary` | 3-row rules-in-force table | `ui/src/features/settings/sections/LandingRulesSummary.tsx` | counts active/hard rules per Aim group | new | `.tbl` |
| `landing-scope-footer` | muted scope line | `LandingSection.tsx` (inline `<p>`) | links to Operate | new | `text-xs text-muted-foreground` |

### S2 — Where you'll work (7 ids)

| data-qa | Mockup element | Real component | Props/variants | Verdict | Design Scale |
|---|---|---|---|---|---|
| `geo-rules-card` | Rules card | `ui/src/features/settings/sections/WhereYouWorkSection.tsx` (top card) | `Card` | existing (Card) / new (composition) | `Card` `rounded-xl` |
| `geo-timezones-rule` | timezones chip-input, rule side | `ui/src/features/settings/ChipInput.tsx` (new shared component, §below) | `role="listbox"` | new | chip `rounded-full h-5` |
| `geo-connective-line` | connective sentence | `WhereYouWorkSection.tsx` (inline `<p>`) | — | new | `text-sm` |
| `geo-conflict-notice` | conflict banner | `Alert` (**add-primitive**, `npx shadcn@latest add alert`) wrapped by `WhereYouWorkSection.tsx`'s conflict-notice block, computed via `computeTimezoneConflict()` (new pure fn, §State & Data) | 3-state: no-rule / hard / soft (F3-amended) | add-primitive + new (wiring) | `bg-attention/10 border-l-2 border-attention` |
| `geo-prefs-card` | Preferences card | `WhereYouWorkSection.tsx` (second card) | `Card` | existing/new | — |
| `geo-timezones-acceptable` | acceptable-tz chip input | `ChipInput.tsx` | — | new | — |
| `geo-timezones-borderline` | borderline-tz chip input | `ChipInput.tsx` | — | new | — |

*(the mockup's `Cities/countries`, `Work types`, `Severity`, `Home cities`, `Work-type preference`
fields in this same screen carry no `data-qa` of their own — they render inside `geo-rules-card`/
`geo-prefs-card`, reusing `FiltersSection.tsx`'s existing `LocationRow`/checkbox/`Select`
patterns, extracted into `WhereYouWorkSection.tsx`. No separate mapping row needed; not a gap.)*

### S3 — Fetching (16 ids)

| data-qa | Mockup element | Real component | Props/variants | Verdict | Design Scale |
|---|---|---|---|---|---|
| `fetch-caps-card` | "How much" card | `ui/src/features/settings/sections/FetchingSection.tsx` | `Card` | existing/new | — |
| `fetch-cap-max-new-per-lane` | one numeric field | `Field`+`Input` (existing) | `type="number"`, bounds 1–500 | existing | `Input h-8` |
| `fetch-cap-max-probes-per-run` | field | `Field`+`Input` | bounds 1–200 | existing | — |
| `fetch-cap-max-cards-per-url` | field | `Field`+`Input` | bounds 1–200 | existing | — |
| `fetch-cap-max-age-days` | field | `Field`+`Input` | bounds 1–90, copy = "gates freshness" (F10) | existing | — |
| `pacing-presets` | 3-card radiogroup | `RadioGroup`+`RadioGroupItem` (**add-primitive**, `npx shadcn@latest add radio-group`), wrapped by new `PacingPresetCard.tsx` | `role="radiogroup"` | add-primitive + new | `preset-card` `rounded-lg ring-2 ring-primary` when checked |
| `pacing-preset-safe` | one preset card | `PacingPresetCard.tsx` (instance) | `RadioGroupItem` `asChild` | new | — |
| `pacing-preset-normal` | preset card | `PacingPresetCard.tsx` | current-badge | new | — |
| `pacing-preset-fast` | preset card | `PacingPresetCard.tsx` | `border-l-2 border-attention` | new | — |
| `pacing-fast-warning` | inline warning inside Fast card | `Alert` (add-primitive, same instance as S2) | variant styled `attention` via className | add-primitive + new | `bg-attention/10` |
| `pacing-fast-ack` | "I understand" checkbox | native `<input type="checkbox">` (existing convention) | `onClick` `stopPropagation` (mirrors mockup) | existing | — |
| `pacing-advanced-disclosure` | disclosure trigger | `Accordion`+`AccordionTrigger` (existing, single-item) | `aria-expanded` | existing | `AccordionTrigger` |
| `pacing-raw-jitter-min` | ms field | `Field`+`Input` | inside `AccordionContent` | existing | — |
| `pacing-raw-jitter-max` | ms field | `Field`+`Input` | — | existing | — |
| `pacing-raw-inter-url-min` | ms field | `Field`+`Input` | — | existing | — |
| `pacing-raw-inter-url-max` | ms field | `Field`+`Input` | — | existing | — |

### S4 — Roles & companies (4 ids)

| data-qa | Mockup element | Real component | Props/variants | Verdict | Design Scale |
|---|---|---|---|---|---|
| `roles-rules-card` | Rules card | `ui/src/features/settings/sections/RolesCompaniesSection.tsx` | title match/reject `ChipInput` ×2, severity `Select` | existing (pattern from `FiltersSection.tsx`'s `TitleRuleEditor`) | — |
| `roles-prefs-card` | Preferences card | `RolesCompaniesSection.tsx` | domain keywords + seniority targets `ChipInput` ×2 | new (fields, `profile.json.settings.rank.title/seniority`, currently unsurfaced) | — |
| `companies-avoid-card` | avoid-list card | `RolesCompaniesSection.tsx` | `ChipInput`, `filter.json.companies` | new (field currently unsurfaced; component reused) | — |
| `rule-preview-strip` | R15 preview strip | `ui/src/features/settings/sections/RulePreviewStrip.tsx` | 3 states: available / no-recent-run / not-mounted | new | `bg-muted p-3 rounded-lg` |

### S5 — Raw config (12 ids)

| data-qa | Mockup element | Real component | Props/variants | Verdict | Design Scale |
|---|---|---|---|---|---|
| `raw-scope-banner` | scope banner | `ui/src/features/settings/sections/RawConfigSection.tsx` | names raw-only keys | new | `bg-muted rounded-lg p-3` |
| `raw-doc-list` | doc list column | `RawConfigSection.tsx` | 4 rows | new | — |
| `raw-doc-profile-json` | one doc row | `RawConfigSection.tsx` | `active` state via local selection | new | `bg-accent` when active |
| `raw-key-badge-schedule` | "has a form →" badge | `Badge` (existing) + `RawConfigSection.tsx` routing | click navigates to owning section | existing (Badge)/new (routing) | — |
| `raw-doc-filter-json` | doc row | `RawConfigSection.tsx` | — | new | — |
| `raw-key-badge-locations` | badge | `Badge`+routing | — | existing/new | — |
| `raw-doc-resume-json` | doc row | `RawConfigSection.tsx` | — | new | — |
| `raw-key-badge-companies` | badge | `Badge`+routing | — | existing/new | — |
| `raw-doc-search-urls-md` | doc row | `RawConfigSection.tsx` | markdown doc, no JSON parse | new | — |
| `raw-key-badge-lanes` | badge | `Badge`+routing | — | existing/new | — |
| `raw-key-badge-rank-weights` | "raw only" badge | `Badge` (existing), `variant="outline"` | no click target (genuinely raw-only) | existing | — |
| `raw-editor` | textarea | `Textarea` (existing, `components/ui/textarea.tsx` — same primitive `JsonEscapeHatch.tsx` already used) | `font-mono`, `rows=14` | existing | `textarea rounded-lg bg-muted` |

### S6/S7 — Operate (23 ids; S7 intentionally reuses S6's ids per the mockup's own note)

| data-qa | Mockup element | Real component | Props/variants | Verdict | Design Scale |
|---|---|---|---|---|---|
| `operate-shell` | Operate page root | `ui/src/features/operate/OperatePage.tsx` (renamed from `HubPage.tsx`) | replaces the 6-card Hub grid | new (full rewrite of an existing page — see Mockup Divergences) | `p-6` |
| `scope-chip-machine` | "This machine · all profiles" badge | `Badge` (existing), `className="bg-accent text-primary"` | on-primary style via className, no new variant | existing | — |
| `card-daemon` | Daemon card | `ui/src/features/operate/DaemonCard.tsx` | replaces the read-only block moved out of `ScheduleSection.tsx` | new | `Card` `card-sm` |
| `daemon-state` | state word | `DaemonCard.tsx`, using `ui/src/features/shell/daemonState.ts` (new shared pure fn, §State & Data) | 6 states, `text-{tone}-strong` | new | `text-success-strong` etc. |
| `daemon-start-stop` | Stop/Start button | `Button` (existing) + `useDaemonControl` mutation (new hook) | toggles by `daemon.state` | existing (Button)/new (wiring) | `btn-outline btn-sm` |
| `daemon-start-fallback` | fallback copy control | — | **Not built** — R20 = Option 1 ratified, the fallback variant is moot | **deferred** — see Mockup Divergences | — |
| `daemon-pause-all` | Pause all button | `Button` + client fan-out (new, §State & Data — non-atomic, BE §7) | per-profile PUT loop | new | — |
| `daemon-autostart` | autostart switch | `Switch` (existing) + `useAutostartMutation` (new hook) | darwin-only; non-darwin → disabled + tooltip-free inline note | existing (Switch)/new (wiring) | `switch h-5 w-9` |
| `card-scheduled-runs` | Scheduled runs card | `ui/src/features/operate/ScheduledRunsCard.tsx` | one row per profile from `GET /api/daemon` | new | `Card` |
| `schedule-row-harish` | one profile row | `ScheduledRunsCard.tsx` (row, keyed per-profile) | `bg-accent` if active profile | new | — |
| `schedule-skip-next` | Skip next button | `Button` + `useSkipNextMutation` (new, PUTs `schedule.skipNext`) | per-row | new | — |
| `schedule-row-rajni` | row | `ScheduledRunsCard.tsx` | — | new | — |
| `card-linkedin` | LinkedIn card | `ui/src/features/operate/LinkedinCard.tsx` | merges session + breaker (C8) | new | `Card` |
| `linkedin-session` | session row | `LinkedinCard.tsx` | 3 states: signed-in/signed-out/unknown | new | `text-success-strong`/`text-amber` |
| `linkedin-session-check` | Check now button | `Button` + `useLinkedinSessionCheck` mutation | `POST /api/linkedin/session/check` | new | — |
| `linkedin-breaker` | breaker row | `LinkedinCard.tsx` | closed / open-until | new | — |
| `card-setup-health` | Setup & health card | `ui/src/features/operate/SetupHealthCard.tsx` | merges doctor + completeness (C11) | new | `Card` |
| `health-group-ok` | collapsed OK group | `SetupHealthCard.tsx` | inside `Accordion` (existing) | existing (Accordion)/new (grouping) | — |
| `health-row-autostart` | one finding row | `SetupHealthCard.tsx` | — | new | — |
| `health-destination-autostart` | destination link/command | `SetupHealthCard.tsx`, `CHECK_TO_DESTINATION` map (new, extends `hub.model.ts`'s `CHECK_TO_CARD` pattern) | Settings link OR `[Copy: <cmd>]` | new | — |
| `card-secrets` | Secrets card | `ui/src/features/operate/SecretsCard.tsx` | reuses `putSecret` (existing, `wizard.api.ts`) | existing (mutation)/new (card) | `Card` |
| `secret-row-notion-token` | one secret row | `SecretsCard.tsx` | write-only `[Set]` dialog | new | — |
| `secret-row-telegram-bot-token` | row | `SecretsCard.tsx` | — | new | — |

### S8 — Save model (8 ids)

| data-qa | Mockup element | Real component | Props/variants | Verdict | Design Scale |
|---|---|---|---|---|---|
| `save-bar` | sticky bar | `ui/src/features/settings/save/SaveBar.tsx` (new shared component, used by all 11 editable sections) | `position: sticky bottom-0` | new | `shadow-lg rounded-xl p-3` |
| `discard-button` | Discard button | `Button` (existing), `variant="outline" size="sm"` | inside `SaveBar.tsx` | existing | — |
| `save-button` | Save button | `Button` (existing), `variant="default" size="sm"`, **never `disabled`** | inside `SaveBar.tsx` | existing | — |
| `dirty-nav-dialog` | unsaved-changes dialog | `Dialog` family (existing) wrapped by new `ui/src/features/settings/save/DirtyNavGuard.tsx` | 3 actions | existing (Dialog)/new (guard logic) | `dialog-mock rounded-xl` |
| `validation-summary` | error summary card | `Alert` (add-primitive, same instance as S2/S3), `role="alert"` | list of field links | add-primitive + new | `border-l-2 border-destructive` |
| `validation-item-jitter-min` | one error li | inside `validation-summary`'s list | anchor focuses field | new | — |
| `validation-item-jitter-max` | li | — | — | new | — |
| `save-success-line` | persistent success line | `ui/src/features/settings/save/SaveBar.tsx` (post-save state) | 2 copy variants (run in flight / not) | new | `bg-success/10 border-l-2 border-success` |

### S9 — Danger zone (3 ids)

| data-qa | Mockup element | Real component | Props/variants | Verdict | Design Scale |
|---|---|---|---|---|---|
| `danger-zone` | section root | `DangerZone.tsx` (existing, unchanged behaviourally) | — | existing | — |
| `danger-confirm-input` | type-to-confirm input | `Input` (existing) — **already has `data-testid="danger-confirm-input"`**; this blueprint adds the matching `data-qa` alias on the same element | — | existing | — |
| `danger-remove-button` | Remove button | `Button` (existing, `variant="destructive"`) — currently `data-testid="danger-confirm"`; add `data-qa="danger-remove-button"` alongside | — | existing | — |

### Completeness assertion

| Group | ids |
|---|---|
| Shell/nav | 6 |
| S1 Landing | 10 |
| S2 Where you'll work | 7 |
| S3 Fetching | 16 |
| S4 Roles & companies | 4 |
| S5 Raw config | 12 |
| S6/S7 Operate | 23 |
| S8 Save model | 8 |
| S9 Danger zone | 3 |
| **Total** | **89** |

**89 mockup ids = 89 mapped rows. Complete.** Two rows are `deferred` with a named reason
(`settings-search` — R26 Could/tail; `daemon-start-fallback` — moot under the ratified R20
Option 1), both still mapped, neither silently dropped.

### New shared components, spelled out once (referenced by many rows above)

- **`ui/src/features/settings/ChipInput.tsx`** — consolidates the `ChipRow`
  (`FiltersSection.tsx:26-75`) / `ChipEditor` (`ResumeSection.tsx:75-124`) duplication into one
  component: `{ values, onAdd, onRemove, ariaLabel }`, `Badge` + `Input` + `Button`, unchanged
  visual output. **Justification for `new` over `existing`**: the *pattern* exists twice
  already, copy-pasted; the new IA needs it in 10+ places (title match/reject, timezones ×3,
  domain keywords, seniority targets, companies avoid, home cities, core skills) — a third and
  fourth copy would violate reuse-first in spirit even though no single file is reused today.
  Consolidating is this blueprint's one deliberate abstraction; `FiltersSection.tsx`'s
  `LocationRow` (its own compound shape) is left as-is, not folded in.
- **`ui/src/features/settings/save/`** (`SaveBar.tsx`, `DirtyNavGuard.tsx`,
  `useSectionSaveState.ts`, `runInFlight.ts`) — the S8 save model, one implementation shared
  by all 11 editable sections. Detailed in §State & Data and §Implementation Steps.

---

## 2. Layout & Composition

### Settings (`#/settings/:section`, default section = `landing`)

```
SettingsPage.tsx (route entry, reads useRoute())
└─ SettingsShell.tsx  [data-qa="settings-shell"]        (new; replaces Tabs-based layout)
   ├─ SettingsNav.tsx  [data-qa="settings-nav"]          (new; 4 groups × 11 links)
   └─ <main class="settings-main">
      ├─ page header row: "Settings" + scope-chip-profile (+ settings-search, deferred)
      ├─ <SectionBody section={section} profile={profile} />   (existing dispatch pattern,
      │    SettingsPage.tsx's SectionBody switch, extended to 12 cases)
      └─ <SaveBar/> + <DirtyNavGuard/>   (mounted once per section body, not per-field)
```

Responsive strategy: unchanged from the existing shell — `Sidebar.tsx` already collapses to
`w-14` icon rail below a breakpoint (existing `useSidebarCollapsed` hook); `SettingsNav.tsx`
does **not** get its own responsive collapse in this spec (out of scope — the mockup shows
only the desktop-width layout, and CLAUDE.md's persona is a single desktop user). `main`
scrolls independently (`overflow-y-auto`), nav is fixed height, matching the inherited
`h-screen overflow-hidden` shell contract `settings.spec.ts`'s own scroll-gesture test already
protects for `SearchUrlsSection`.

### Operate (`#/setup`, label "Operate")

```
OperatePage.tsx  [data-qa="operate-shell"]   (renamed from HubPage.tsx; full rewrite)
├─ page header: "Operate" + scope-chip-machine
└─ <div class="grid grid-cols-2 gap-4">
   ├─ DaemonCard.tsx           [card-daemon]
   ├─ ScheduledRunsCard.tsx    [card-scheduled-runs]
   ├─ LinkedinCard.tsx         [card-linkedin]
   ├─ SetupHealthCard.tsx      [card-setup-health]
   └─ SecretsCard.tsx          [card-secrets]  (grid-column: 1 / -1, full width — matches mockup)
```

No profile-scoped nav inside Operate — it is "one scrolling column of cards" per ux-notes §2
(rendered here as a 2-col grid on desktop width, 1-col below, matching the existing
`HUB_CARDS` grid's own `grid-cols-1 sm:grid-cols-2` responsive pattern, confirmed in
`HubPage.tsx:145`). The **sidebar profile switcher stays live** on Operate (not disabled) —
machine-scoped cards carry the `All profiles` badge instead of disabling the switcher,
matching ux-notes §10's explicit resolution of AC3.

Degraded state (S7): no separate component. Every card above renders its own severity styling
conditionally (`accent-attention` class only on the single worst-ranked card — daemon down >
session signed out > breaker open > check failing, per C10), computed by a small pure
`operate/severityOrder.ts` helper (new) that each card queries for "am I the worst."

---

## 3. State & Data

Every datum below cites its `blueprint-be.md` §2 row or step number — no invented endpoint.

| Screen/region | Data | Query/mutation | BE contract |
|---|---|---|---|
| Landing thin-run | last run funnel + biggest-drop rule | `GET /api/profiles/:name/runs` (last id) → `GET .../runs/:id` (`.result`) | blueprint-be §2 "Last-run funnel" row — **existing**. **Corrected this amendment (UI-gate F5): no new type module.** `RunDetail.result`'s hand-typed-in-`ui/` shape already exists at `ui/src/features/runs/runResult.ts` (`getFunnelStages`/`getBiggestDrop`/`newMatchCount`, narrowing defensively from `unknown` by design, per its own header) — step 9a reuses it verbatim, it is not mirrored into a second module |
| Landing caps-hit markers | `capsHit.maxNewPerLane`/`maxCardsPerUrl` | `GET .../runs/:id/soft-errors` (extended) | blueprint-be §2 "Cap-hit binding markers" row, BE step 10 |
| Landing rules-in-force counts | active/hard rule counts per Aim group | `GET config/filter.json` + `GET config/profile.json` (both existing) | blueprint-be §2, existing rows |
| S2 conflict notice | `{tz, severity}[]` conflict set | **client-computed**, `computeTimezoneConflict()` in new `ui/src/features/settings/sections/whereYouWork.model.ts`, importing `normalizeToken` type-only... **no** — `normalizeToken` is a runtime function, imported as a real (non-type) import from `src/core/normalize_token/index.ts` (BE step 13/F4; **dependency-free module, the second one CLAUDE.md's "`ui/` may import `src/core/**`" paragraph names** — confirm the CLAUDE.md line lands in the same BE change before this import compiles under `ui:build`) | blueprint-be §0(a) corrected computation (F3), §2 "Timezone conflict set" row |
| S3 caps | `maxNewPerLane`/`maxProbesPerRun`/`maxCardsPerUrl`/`maxAgeDays` | `GET/PUT config/profile.json` | blueprint-be §2, existing |
| S3 pacing | jitter/inter-url ranges | `GET/PUT config/profile.json`, **save-time validated** by BE step 3 (hoisted `LinkedinPacingSettingsSchema`) | blueprint-be §3.1-4 |
| S4 rules/prefs/companies | title match/reject, domain keywords, seniority targets, companies avoid | `GET/PUT config/filter.json` + `config/profile.json` | blueprint-be §2, existing |
| S4 preview strip | `FilterPreviewResult` | `POST /api/profiles/:name/preview/filter`, type-only import from `src/app/features/preview/index.ts` (new barrel, mirrors `config`/`profiles`/`runs`) | blueprint-be §2 "Filter-rule preview" row, §3.28-36 |
| S5 raw config | all 4 config docs | existing `GET/PUT config/:doc` ×4, same `useDocForm`/direct `configDocQuery`+`useConfigMutation` seam every other section uses | blueprint-be §1 "Config docs" |
| Operate Daemon card | `DaemonStatus` | existing `GET /api/daemon` (`wizard.api.ts`'s `getDaemonStatus`, reused, **not re-fetched by a new query** — same `daemonQuery()`) | blueprint-be §2, existing |
| Operate Daemon controls | stop/start/autostart outcomes | `POST /api/daemon/stop`, `POST /api/daemon/start`, `PUT /api/daemon/autostart` — type-only imports `StopDaemonOutcome`/`StartDaemonOutcome`/`AutostartOutcome` from `src/app/features/daemon/index.ts` (**that barrel exports zero types today — this is its first, not an extension**, UI-gate F6-corrected, step 9) | blueprint-be §3.37-42 (Option 1 ratified — all three build) |
| Scheduled runs | per-profile schedule + skip-next | existing `GET /api/daemon` (`.profiles[]`); skip-next writes via `PUT config/profile.json` (`schedule.skipNext`) | blueprint-be §2 "schedule.skipNext" row, §3.5-9 |
| Pause/resume row | `schedule.enabled` | existing `PUT config/profile.json` | blueprint-be §0(e), zero new BE work |
| Pause all | fan-out over N profiles | N sequential `PUT config/profile.json` calls, **not atomic** — UI must report per-profile success/failure | blueprint-be §7 "Pause-all" row — explicitly flagged as a UI-owned concern |
| LinkedIn session | cached / probe-now | `GET /api/linkedin/session`, `POST /api/linkedin/session/check` — type-only import `LinkedinSessionStatus` from new `src/app/features/linkedin/index.ts` | blueprint-be §2, §3.20-23 |
| LinkedIn breaker | closed/open+reopenAt | `GET /api/linkedin/breaker` — type-only import `BreakerStatus` from the same new barrel | blueprint-be §2, §3.14-19 |
| Setup & health | doctor findings | existing `GET /api/profiles/:name/doctor` (`hub.api.ts`'s `getDoctorReport`, reused) | blueprint-be §2, existing |
| Secrets | presence + write | existing `GET /api/secrets`, `PUT /api/secrets/:key` (`wizard.api.ts`'s `putSecret`, reused) | blueprint-be §2, existing, unchanged |
| S8 "run in flight" copy | which of the 2 success-line variants | **corrected per BE F7**: primary signal is `GET /api/profiles/:name/runs?limit=1`'s `RunSummary.status === 'running'` for the profile being saved, **not** `GET /api/daemon`'s `inFlight` alone (misses CLI-initiated runs) | blueprint-be §5 R14 row (F7-amended), §6 S8-success row |
| S9 Danger zone | profile removal | existing `DELETE /api/profiles/:name` | blueprint-be §2, existing, unchanged |

**No datum in this table lacks a BE citation.** Two data needs are explicitly **not** built
(both spec Won'ts, both already excluded by blueprint-be §10): rank re-scoring preview,
manual breaker reset.

---

## 4. Implementation Steps

Dependency-ordered, one file of focus each. Every screen/state-delivering step names its e2e
spec and file in the same step, per the state-pinning principle — no trailing "write e2e" step
exists anywhere in this list.

### e2e Disposition Ledger — new this amendment (UI-gate F2, F3)

Every test in the two existing e2e files this blueprint touches gets an explicit, individual
disposition. **SURVIVE** = unchanged, still passes as written. **ADAPT** = same behaviour,
different target (route/selector) — the assertion body is materially unchanged. **REPLACE** =
the behaviour moves to a new file/component with a new test asserting the same *capability*
against different markup. No test is silently orphaned; the previous draft's blanket "every
assertion that still applies" clause (flagged by the judge) is retired in favour of this table.

**`ui/e2e/settings.spec.ts` — 12 tests (corrected count, F2; `grep -c "test(" ` confirms 12).**

| # | Test (line) | Disposition | Destination |
|---|---|---|---|
| 1 | profile section round-trips a lane toggle (52) | ADAPT | `#/settings/where-jobs-come-from` — step 17 |
| 2 | schedule section round-trips grace minutes + enabled switch (77) | **SURVIVE, unchanged** | stays at `#/settings/schedule` — step 18 explicitly keeps `times`/`weekdays`/`graceMinutes`/`enabled` and their save path untouched; only the daemon-status markup below it changes |
| 3 | filters section round-trips minimum skill match (100) | ADAPT | `#/settings/skills` — step 12 |
| 4 | resume section round-trips years of experience (120) | ADAPT | `#/settings/about-you` — step 15 |
| 5 | search urls section round-trips a new entry (141) | ADAPT | `#/settings/where-jobs-come-from` — step 17 |
| 6 | JSON escape hatch round-trips raw text (171) | ADAPT | dialog removed; same assertions run inline at `#/settings/raw-config` — step 23 |
| 7 | invalid JSON rejected inline (208) | ADAPT | same, inline at `#/settings/raw-config` — step 23 |
| 8 | search-urls scroll-gesture reachability (224) | ADAPT | `#/settings/where-jobs-come-from` — step 17 |
| 9 | schedule section shows the daemon's **degraded** state (252) | **REPLACE** | moves to `ui/e2e/operate.spec.ts` against `DaemonCard` at `#/setup` — step 30, new done-condition (e) |
| 10 | schedule section shows the daemon's **healthy** state (280) | **REPLACE** | same, `operate.spec.ts` — step 30, done-condition (f) |
| 11 | schedule section renders the **unreachable-daemon error** state (302) | **REPLACE** | same, `operate.spec.ts` — step 30, done-condition (g). **This is `api-unreachable`'s named owner** — `DaemonCard.tsx`, not "caller's concern" left unassigned (F2's aggravating point, closed) |
| 12 | schedule section renders the **loading skeleton** (332) | **REPLACE** | same, `operate.spec.ts` — step 30, done-condition (h) |

Tests 9–12's underlying **unit** coverage (the six-branch state derivation itself) is not
lost either: step 16's colocated test for `daemonStatusWord()` already asserts each of the 6
named states byte-for-byte against `ScheduleSection.test.tsx`'s prior per-state assertions;
step 18 adds a **new** unit test for `ScheduleSection`'s own compact bridge line (a single
line of text + link, not the six-branch markup); step 30 adds the **e2e** replacements above
plus `DaemonCard.test.tsx`'s own colocated unit coverage for the same six states rendered in
full (state, last-tick, pid, uptime — the rich markup that used to live in
`ScheduleSection.tsx`). Nothing is asserted only in prose.

**`ui/e2e/hub.spec.ts` — 6 tests (confirmed by full read this amendment, not previously read
in full).**

| # | Test (line) | Disposition | Destination |
|---|---|---|---|
| 1 | `#/setup` renders six status cards (69) | **REPLACE** | card set changes 6→5 with wholesale different content (no 1:1 overlap, per the ratified Hub-boundary rewrite) — `operate.spec.ts`'s first test (step 29) asserts the 5 new `data-qa` cards instead |
| 2 | sidebar nav item reads "Setup & Health" and routes to the hub (80) | **ADAPT** | label changes to "Operate" (step 2) — `operate.spec.ts`'s second test (step 29) |
| 3 | a doctor finding renders under its mapped card (89) | **ADAPT** | the "mapped card" concept survives as the merged Setup & Health card's `Needs action`/`Not configured`/`OK` grouping (step 35) — new done-condition added this amendment asserting a stubbed `warn` finding appears under `Needs action` with its destination, replacing the old per-card assertion |
| 4 | the schedule-vs-daemon banner appears when the daemon is stopped and the schedule is enabled (103) | **ADAPT** | `scheduleWarning()` is explicitly **kept**, not deleted (step 28) — reused inside `DaemonCard`'s degraded-state rendering; new done-condition added this amendment to step 30 asserting the same banner copy renders when daemon is stopped + schedule enabled, at `#/setup` |
| 5 | a non-ok card's "Set up" opens a dialog panel; an ok card offers "Edit in Settings" with no dialog (142) | **REPLACE** | `HubStepDialog.tsx` is deleted this amendment (new sub-step, step 28) — per C11's own design ("a link into the owning Settings section… the board never performs \[setup steps]"), the dialog-triggered mini-wizard affordance is retired; the "ok → Edit in Settings" half survives as the destination-link behaviour step 35 already asserts, the "non-ok → Set up dialog" half is replaced by step 35's destination-link/CLI-copy assertions (no in-board dialog performs the step) |
| 6 | "Set up a new profile" navigates to the onboarding wizard (172) | **SURVIVE (user-ruled, F3)** | carried onto Operate's Setup & Health card, new sub-step below (Group E) — see F3 disposition |

### Group A — Shared infrastructure (build first; every later group depends on it)

1. **`ui/src/lib/router.ts` — edit.** Replace `SettingsSection`'s 6-value union with the 12
   new slugs: `'landing' | 'roles-companies' | 'where-you-work' | 'skills' | 'about-you' |
   'where-jobs-come-from' | 'schedule' | 'fetching' | 'delivery' | 'housekeeping' |
   'raw-config' | 'danger'`. `parseHash`'s `#/settings` (no section segment) now defaults to
   `'landing'` (today it returns `{name:'settings'}` with no section — add the default there).
   `ROUTES` array unchanged (`'setup'` stays, per the closed Hub-boundary ruling). Colocated
   `router.test.ts` — edit: add a case asserting `#/settings` alone parses to `{name:
   'settings', section: 'landing'}`; a case per new slug round-trips through `routeHash`.
   **Done-condition**: `npm run --prefix ui check` typechecks with zero `SettingsSection`
   consumers left referencing a deleted slug (compiler-enforced, not a judgment call).
2. **`ui/src/features/shell/Sidebar.tsx` — edit.** `NAV_ITEMS`: the `'setup'` entry's `label`
   changes `'Setup & Health'` → `'Operate'`, `Icon` changes `Rocket` → `Activity` (lucide);
   the `'analytics'` entry's `Icon` changes `Activity` → `BarChart3` (frees `Activity` for
   Operate, matching the mockup's icon reassignment exactly: `icon-bar-chart` for Analytics,
   `icon-activity` for Operate); the `'settings'` entry's `Icon` changes `Settings` →
   `SlidersHorizontal` (matches mockup's `icon-sliders`). No other `NAV_ITEMS` field changes.
   **Done-condition**: `Shell.test.tsx`'s existing nav-item assertions are updated to the new
   label/icon pair for `'setup'` and still pass.
3. **`ui/src/features/settings/ChipInput.tsx` — new**, + colocated `ChipInput.test.tsx`.
   `{ values: string[]; onAdd: (v: string) => void; onRemove: (v: string) => void; ariaLabel:
   string }`, body lifted verbatim from `FiltersSection.tsx`'s `ChipRow` (lines 26-75).
   **Done-condition**: typing a value and clicking Add calls `onAdd` with the trimmed value and
   clears the draft input (test asserts the callback arg, not just that a chip renders).
4. **`ui/src/features/settings/save/useSectionSaveState.ts` — new**, + colocated test. The
   shared save-model hook every editable section wraps its form state in:
   `{ isDirty, errors, isSaving, successMessage, save, discard }`. Takes `{ initialValue,
   currentValue, validate: (v) => Record<string,string>, onSave: (v) => Promise<void> }`.
   `isDirty` = `!deepEqual(initialValue, currentValue)` (a small local `deepEqual`, no new
   dependency — JSON.stringify comparison is sufficient here since every section's editor
   state is plain JSON-shaped data, same posture `useDocForm`'s own re-parse-at-save already
   takes). `successMessage` is resolved by the shared `runInFlight` check (step 6), not
   duplicated per section. **Done-condition**: a unit test changes `currentValue`, asserts
   `isDirty` flips `true`→`save()`→`isDirty` flips back `false` and `successMessage` is set;
   a second test asserts `validate` failing populates `errors` and `save()` does **not** call
   `onSave`.
5. **`ui/src/features/settings/save/SaveBar.tsx` — new**, + colocated test. Renders the 4
   S8 states from `useSectionSaveState`'s return: dirty bar (`data-qa="save-bar"`,
   `discard-button`, `save-button` — **`save-button` is never `disabled`**, per R13/GOV.UK,
   asserted by the colocated test clicking it while `errors` is non-empty and observing `save`
   still fires), validation summary (`data-qa="validation-summary"`, one `<li data-qa=
   "validation-item-{field}">` per `errors` entry, `role="alert"`, each `<a>` calling
   `document.getElementById(field)?.focus()`), success line (`data-qa="save-success-line"`,
   2-copy variant from `runInFlight`). Uses the new `Alert` primitive (step 8) for the
   validation summary only — the dirty bar and success line are plain `Card`-styled divs
   (mockup's `.save-bar`/`.success-line`, not alert-shaped).
   **Done-condition**: rendering with a populated `errors` map shows `validation-summary` with
   one list item per key, each item's link moves focus to the named field id. **Added this
   amendment (UI-gate F4, effect-asserting)**: a second test renders the dirty bar with a
   known `currentValue` that differs from `initialValue`, clicks `discard-button`, and asserts
   `currentValue` is passed back to `initialValue` via `useSectionSaveState`'s `discard()`
   (spy/state assertion on the hook's own return, not merely that the bar disappears — a
   `Discard` that only hides the bar while leaving the draft mutated would pass a
   presence-only check and still be wrong).
6. **`ui/src/features/settings/save/runInFlight.ts` — new**, + colocated test. `export
   function useRunInFlight(profile: string): boolean | undefined` — wraps `useQuery` over
   `GET /api/profiles/:name/runs?limit=1`, returns `data.rows[0]?.status === 'running'`
   (undefined while loading). **Corrected per BE F7 — do not read `GET /api/daemon`'s
   `inFlight` for this.** **Done-condition**: a test stubbing the runs endpoint with a
   `status:'running'` row returns `true`; a stub with `status:'completed'` returns `false`.
7. **`ui/src/features/settings/save/DirtyNavGuard.tsx` — new**, + colocated test. Wraps
   `navigate()` calls originating from `SettingsNav.tsx` and the sidebar profile switcher:
   when `isDirty` is true, intercepts and renders the `Dialog` (`data-qa="dirty-nav-dialog"`)
   with `Save and continue` / `Discard changes` / `Stay here`. **Done-condition**: a test with
   `isDirty=true` clicking a nav link renders the dialog instead of navigating immediately;
   clicking `Discard changes` completes the navigation; clicking `Stay here` leaves the route
   unchanged (asserted via a `navigate` spy, not by re-reading `window.location.hash`
   directly — mirrors `router.test.ts`'s own spy convention).
8. **shadcn primitives — install.** `npx shadcn@latest add radio-group alert` from `ui/`.
   **Done-condition**: `ui/src/components/ui/radio-group.tsx` and `ui/src/components/ui/
   alert.tsx` exist, `npm run --prefix ui check` passes with no new lint findings (the CLI
   generates repo-conformant files by construction — no manual edit needed post-install).
9. **`ui/src/lib/api/types.ts` — edit.** **Rewritten, UI-gate F6 — the original wording was
   wrong on two counts, corrected here:** (a) there is **no existing daemon re-export block**
   in this file today (it carries exactly four blocks — `board`, `config`, `profiles`, `runs`
   — confirmed by direct read; "extend the existing … line" was false, there is nothing to
   extend), and (b) `src/app/features/daemon/index.ts` exports exactly one symbol today
   (`export { makeDaemonRoutes } from './routes.ts';`, confirmed by direct read) — it gains
   its **first** type export in this change, not an extension of one it already had. Per the
   BE-gate bounce this finding triggered, blueprint-be §2/§11a now pins six exact identifiers,
   all defined once in `src/ports/board.ts` and re-exported per-feature — add **three new**
   blocks to this file, matching the existing four blocks' own shape exactly:
   ```ts
   export type { BreakerStatus, LinkedinSessionStatus } from '../../../../src/app/features/linkedin/index.ts';
   export type { FilterPreviewResult } from '../../../../src/app/features/preview/index.ts';
   export type { StopDaemonOutcome, StartDaemonOutcome, AutostartOutcome } from '../../../../src/app/features/daemon/index.ts';
   ```
   `linkedin/` and `preview/` are themselves **new** `app/features/` folders (confirmed absent
   from `src/app/features/`'s current 10 entries) — their `index.ts` barrels are BE's own
   deliverable (blueprint-be §3.17/§3.22, §3.33), each already specified to carry an
   `export type { … } from '../../../ports/board.ts';` line per blueprint-be §2/§11a. This
   step only ever imports from a feature's `index.ts`, never reaches past it into
   `ports/board.ts` directly — same discipline the existing four blocks already follow.
   **Done-condition**: `tsc --noEmit` in `ui/` resolves all six new type names with zero `any`,
   once the three BE barrels land (this step has a hard BE-side dependency, not a "one-line
   addition" as previously stated — it cannot compile until `linkedin/index.ts`,
   `preview/index.ts` exist and `daemon/index.ts` gains its type export).

### Group B — Aim (S1, S2, S4; Skills, About you)

**Steps 9a–9d, new this amendment (UI-gate F1 + F5, blocker).** The default `#/settings`
route (S1, "What decides your board") had zero implementation steps in the reviewed draft —
three named-but-unbuilt components, three unrouted §State & Data rows, and no wired `landing`
case in `SectionBody`'s switch. These four steps close that gap and are logically Group B's
first item (Landing is a screen inventory S1 item, listed in this group's own heading since
the original draft), placed here rather than renumbering steps 10–38. **Reuse discipline
(F5)**: none of these steps create a new `RunResult`-shaped type module — `ui/src/features/
runs/runResult.ts` (109 lines — corrected this pass, R2-F4; existing, full-read this
amendment) already exports
`getFunnelStages`/`getBiggestDrop`/`newMatchCount`/`computeRetention` over `RunDetail.result`'s
opaque `unknown` shape, and its own header states why it narrows defensively rather than
mirroring the schema field-for-field: *"`RunDetail.result` … opaque `unknown` at the port
boundary … the UI narrows defensively rather than importing the zod schema, so a
malformed/absent blob degrades to 'no funnel to show' instead of a render crash."* Every
Landing data need below is satisfied by these four existing exports; none is reimplemented.

9a. **`ui/src/features/settings/sections/landing.model.ts` — new**, + colocated test.
    A thin Landing-specific **aggregator**, not a parallel `RunResult` module: imports
    `getFunnelStages`/`getBiggestDrop`/`newMatchCount` from `ui/src/features/runs/runResult.ts`
    unchanged, and composes three pure functions this screen alone needs: (1)
    `thinRunSummary(result: unknown): {scraped: number | null; onBoard: number; biggestDrop:
    {stage: string; rule: string; count: number} | null}` — `scraped` = the **first**
    `getFunnelStages(result)` entry's `jobsIn` (`null` when the funnel is absent, matching
    `getFunnelStages`'s own null-on-malformed contract — never a fabricated `0`), `onBoard` =
    `newMatchCount(result)` (reused verbatim), `biggestDrop` = `getBiggestDrop(stages ?? [])`
    (reused verbatim — no new field needed on `FunnelStage`, every field this screen reads —
    `jobsIn`, `jobsOut`, `dropsByRule` — already exists there, confirmed against the file read
    in full this amendment); (2) `capsInForce(profileSettings, capsHit): {name: string; value:
    number; hit: boolean | null}[]` for the 4-row caps table — `hit` is `null` (never rendered
    as a confident "not hit") for `maxProbesPerRun`, since blueprint-be states no signal exists
    for it today; `hit` is the real boolean from the extended soft-errors response for
    `maxNewPerLane`/`maxCardsPerUrl`; `maxAgeDays` is always `hit: null` (it gates freshness,
    not yield — F10-amended AC6, no binding concept applies to it at all); (3)
    `rulesInForce(filterDoc, profileDoc): {group: 'roles-companies' | 'where-you-work' |
    'skills'; activeCount: number; hardCount: number}[]` — counts `filter.json`'s `title`
    entries' severities for `roles-companies`, `locations`-derived rule count for
    `where-you-work`, `skills` for `skills`, all read from data these sections already fetch.
    **Done-condition**: a test with a 3-stage fixture funnel where stage B's `dropsByRule` has
    the largest single count asserts `thinRunSummary(...).biggestDrop` names stage B and its
    rule (proves the wrapper delegates to `getBiggestDrop` correctly, not a re-derivation); a
    test with `result: undefined` (no run yet) asserts `scraped: null, onBoard: 0, biggestDrop:
    null` — the shape `LandingSection.tsx` (9d) uses to render the empty state, never a `0`
    presented as a real count.
9b. **`ui/src/features/settings/sections/LandingCapsTable.tsx` — new**, + colocated
    test. 4-row `<table>` (`data-qa="landing-caps-table"`, per-row `data-qa="landing-cap-row-
    {max-new-per-lane|max-probes-per-run|max-cards-per-url|max-age-days}"`, `FunnelTable.tsx`'s
    plain-`<table>`+Tailwind idiom, not a shared generic `Table`), reading `maxNewPerLane`/
    `maxProbesPerRun`/`maxCardsPerUrl`/`maxAgeDays` via the existing `configDocQuery(profile,
    'profile.json')` and `capsHit` via the extended `GET .../runs/:id/soft-errors` (blueprint-
    be §3.10). Binding badge (`bg-accent text-primary`, mirroring `Badge`'s existing `on-
    primary` className usage from §Component Mapping) renders only when `capsInForce(...)`'s
    `hit === true`; `hit === null` (`maxProbesPerRun`, `maxAgeDays`) renders a plain `—`, never
    a false "not hit". Each row's `[Change →]` `navigate()`s to `#/settings/fetching`.
    `maxAgeDays`'s row copy reads "gates LinkedIn page-inventory freshness" (F10-amended AC6),
    never "caps jobs". **Done-condition**: a stubbed soft-errors response with
    `capsHit.maxNewPerLane: true` renders the binding badge on exactly the `max-new-per-lane`
    row and a plain `—` (no badge, no false negative) on the `max-probes-per-run` row; clicking
    any row's `[Change →]` is a `navigate` spy assertion (mirrors step 7's convention) landing
    on `{name:'settings', section:'fetching'}`.
9c. **`ui/src/features/settings/sections/LandingRulesSummary.tsx` — new**, + colocated
    test. 3-row `<table>` (`data-qa="landing-rules-summary"`), each row "`n` active rules, `m`
    of them hard" per Aim group, from `rulesInForce(...)` (9a) over the existing `filter.json`/
    `profile.json` `configDocQuery`s — no new field. `[Open →]` `navigate()`s to the owning
    section (`roles-companies`/`where-you-work`/`skills`). **Done-condition**: a fixture
    `filter.json` with 2 hard-severity + 1 soft-severity title rules renders "3 active rules, 2
    of them hard" on the Roles & companies row — counted from the fixture, not asserted in
    prose.
9d. **`ui/src/features/settings/sections/LandingSection.tsx` — new**, + colocated test +
    **e2e**. Composes `landing-thin-run` (the hero card, `thinRunSummary(...)` from 9a; **empty
    state, ux-notes §12:477**: when `GET .../runs` returns `[]` for the profile, the thin-run
    card is replaced by one muted line — *"No run recorded yet"* — never a zero; **loading
    state**: 1 card skeleton while the run/funnel query is pending; **error state**: an inline
    error-plus-retry block scoped to this one card, so a caps/rules-table fetch failure
    elsewhere on the same screen does not blank this card, matching §12:477's "caps can fail
    while rules load" independence), `LandingCapsTable` (9b), `LandingRulesSummary` (9c), and
    `landing-scope-footer` (a `<p>` linking to `#/setup`).

    **Corrected this pass (R2-F5): the error state's block above is not a reuse as previously
    implied.** `ErrorRetry` is not a shared component today — it is a local function defined
    separately in `ui/src/features/triage/TriagePage.tsx:37` and
    `ui/src/features/runs/RunsPage.tsx:79`, neither exported. Landing's error block would be a
    **third** local copy of the same shape, which — by this blueprint's own `ChipInput`
    rationale (§Component Mapping's "New shared components" note: "a third and fourth copy
    would violate reuse-first in spirit even though no single file is reused today") — is the
    same pattern, not a different one. **Call: consolidate, don't triplicate.** Added work,
    same step: extract a shared `ui/src/features/shared/ErrorRetry.tsx` (new, colocated test)
    from the two existing definitions (verify they're identical or near-identical in shape
    first — both take a message + a retry callback per their call sites; reconcile any
    prop-shape drift as part of the extraction, not silently), update
    `TriagePage.tsx`/`RunsPage.tsx` to import it instead of their own copies, and have
    `LandingSection.tsx` import the same component rather than defining a third. **Done-
    condition, added this pass**: `grep -rn "function ErrorRetry" ui/src` returns zero matches
    post-extraction — one definition, three consumers.

    Wired as the **`'landing'`** case in
    `SettingsPage.tsx`'s `SectionBody` switch (step 25, corrected below) — the default mount
    for bare `#/settings`, per step 1's router default. **Done-condition + e2e**: new
    `ui/e2e/settings-landing.spec.ts` — (a) seeds a run fixture with a known 3-stage funnel via
    the existing `run-fixtures.ts` helpers (reused, not reinvented), navigates to `#/settings`
    (bare, no section segment), and asserts `[data-qa="landing-thin-run"]` renders the exact
    board-count/scraped-count/biggest-drop-rule text derived from that fixture; (b) stubs `GET
    .../runs` to return `[]`, asserts the thin-run card is replaced by the muted "No run
    recorded yet" line **while** `landing-caps-table`/`landing-rules-summary` still render
    (they read config docs, not runs). **Corrected this pass (R2-F2): (b) is the empty-run
    case, not the failure-independence case — an empty `[]` response is not a failing
    request, so (b) does not close §12:477's "caps can fail while rules load" line; that claim
    is now backed by the two new cases below instead.** (c) asserts `#/settings` bare resolves
    to the `landing` section with zero additional clicks — `[data-qa="landing-caps-table"]` is
    visible immediately on load, which is what closes F1's "SectionBody mounts nothing for the
    default route" defect as a positive, mechanical assertion rather than a routing-table claim
    alone.

    **Two cases added this pass (R2-F2), closing the loading/error gap §8 and §12:477 actually
    require:** (d) **loading** — holds `GET .../runs` open past first paint (mirrors
    `settings.spec.ts:332`'s held-route idiom, reused), and asserts `landing-thin-run` and
    `landing-caps-table` both render their skeleton state — `landing-caps-table`'s binding
    badges are sourced from `GET .../runs/:id/soft-errors`, which itself needs the run id from
    `GET .../runs` first (9a's `capsInForce`), so the table is genuinely blocked on the same
    request the thin-run card is — **while** `landing-rules-summary` renders its real content
    immediately, since it depends only on the already-resolved `filter.json`/`profile.json`
    queries, not on `GET .../runs` at all. This is the literal "caps-table skeleton while
    rules render" independence ux-notes §12:477 describes. (e) **error** — fails `GET .../runs`
    (a 500, mirroring the existing error-stub idiom this suite already uses elsewhere) and
    asserts `landing-thin-run` renders its own block-scoped inline error+retry, **while**
    `landing-caps-table` still renders its 4 rows with real cap values from config (binding
    badges simply omitted/`—`, matching 9a's `hit: null` degrade path — a fail-soft skip, not
    a crash) and `landing-rules-summary` still renders in full — proving the failure is scoped
    to the one block that genuinely needs `GET .../runs`, not the whole screen. Together, (d)
    and (e) are what actually close §12:477's independence claim; (b) alone did not.

10. **`ui/src/features/settings/sections/whereYouWork.model.ts` — new**, + colocated test.
    `computeTimezoneConflict(filterTimezones, rankLocation): {tz: string; severity: 'hard' |
    'soft'}[]` implementing blueprint-be §0(a)'s corrected 4-branch logic exactly: `undefined`
    accept-list → `[]` always; else normalize both sides via `normalizeToken` (imported from
    `src/core/normalize_token/index.ts`) and diff. **Done-condition** (mirrors blueprint-be
    §3.35's own test list, client-side): a case with `timezones: undefined` returns `[]`
    regardless of rank lists; a case with `severity:'hard'` and an unlisted rank timezone
    returns one `{tz, severity:'hard'}` entry; a case with `severity:'soft'` returns
    `{severity:'soft'}` for the same input; a case where every rank timezone is present in
    `accept` returns `[]`.
11. **`ui/src/features/settings/sections/WhereYouWorkSection.tsx` — new**, + colocated test +
    **e2e**. Two `Card`s (`geo-rules-card`, `geo-prefs-card`) per the mockup, `geo-connective-
    line`, and the conflict `Alert` (`geo-conflict-notice`) rendered only when
    `computeTimezoneConflict(...)` returns a non-empty array, branching copy on `.severity`
    (`hard` → ux-notes' verbatim copy; `soft` → new copy, since ux-notes did not design this
    branch — see NOTES). Locations/work-types reuse `FiltersSection.tsx`'s existing
    `LocationRow` unchanged (imported, not duplicated). Wrapped in `useSectionSaveState` (step
    4) + `SaveBar` (step 5). **Empty state, added this amendment (UI-gate F7, ux-notes
    §12:478,490)**: when `geo-rules-card`'s locations list AND its timezones chip-input are
    both empty, the card renders *"No rules — nothing is dropped for this reason"* in place of
    the empty `LocationRow`/`ChipInput` list, with an inline `[Add]` button (Fitts: the action
    sits where the eye already is) that seeds one empty `LocationRow` on click — never a blank
    list that reads ambiguously as either "no rule" or "a permissive rule with nothing typed
    yet" (§12:490's own stated reason for this rule). **File-size contingency, named this
    amendment (UI-gate F9)**: this is the likeliest of the 12 new sections to approach the
    400-line cap (`FiltersSection.tsx`, the closest existing analogue at a comparable load —
    title rules + locations + skills — is already 342 lines for *less* than this section's
    scope, which drops the skills block but adds 3 `ChipInput`-based timezone fields + the
    conflict-notice branch). **If this file exceeds ~350 lines during implementation, split
    into `WhereYouWorkRulesCard.tsx` (`geo-rules-card`) and `WhereYouWorkPrefsCard.tsx`
    (`geo-prefs-card`) as sibling files**, matching this blueprint's established sibling-file
    convention (§NOTES) rather than a nested subfolder — `WhereYouWorkSection.tsx` then
    becomes a thin composition of the two, still owning the connective line and the conflict
    notice (the one piece that genuinely spans both cards). **Done-condition + e2e**: new
    `ui/e2e/settings-where-you-work.spec.ts` — one test seeds `filter.json.timezones =
    {accept:['Asia/Kolkata'], severity:'hard'}` and `profile.json.settings.rank.location.
    acceptableTimezones = ['Asia/Kolkata','America/New_York']` via `page.request.put` (mirrors
    `settings.spec.ts`'s own fixture-seeding idiom), navigates to `#/settings/where-you-work`,
    and asserts `[data-qa="geo-conflict-notice"]` is visible and names
    `America/New_York`; a second test seeds a matching pair with **no** unlisted timezone and
    asserts the notice has **zero** count; a third seeds `severity:'soft'` with an unlisted
    timezone and asserts the notice renders the soft-branch copy (not the hard-branch
    "no job... can reach the board" sentence); a fourth seeds `filter.json.locations: []` and
    `timezones: undefined` and asserts the "No rules — nothing is dropped for this reason"
    copy is visible with a working `[Add]` button (clicking it renders one empty `LocationRow`).
    Every test restores the original docs in `finally`, per the existing idiom.
12. **`ui/src/features/settings/sections/SkillsSection.tsx` — new**, + colocated test + e2e.
    Extracted verbatim from `FiltersSection.tsx`'s existing skills block (core-skills
    `ChipInput`, `minMatch` `Input`, severity `Select`) — same `filters.model.ts` functions
    reused (`parseFilterDoc`/`applyFilterEditorState`/`validateFilterEditorState`, unchanged).
    **Done-condition + e2e**: extend `ui/e2e/settings.spec.ts`'s existing "filters section
    round-trips a minimum skill match count" test — change only its `page.goto` target to
    `#/settings/skills` (the assertion body is unchanged, since the field and its server
    round-trip are identical; this is a **relocation** of an already-passing e2e test, not a
    new assertion — flagged as such in the diff so review isn't surprised by an apparently
    duplicate-looking test).
13. **`ui/src/features/settings/sections/RolesCompaniesSection.tsx` — new**, + colocated test
    + e2e. Three `Card`s: `roles-rules-card` (title match/reject, from `FiltersSection.tsx`'s
    `TitleRuleEditor`, unchanged), `roles-prefs-card` (**new fields**: domain keywords +
    seniority targets, reading/writing `profile.json.settings.rank.title.domainKeywords` /
    `.seniority.targets` — currently unsurfaced, per blueprint-be §2 "Ranking lists" row,
    existing endpoint), `companies-avoid-card` (**new field**: `filter.json.companies.avoid`,
    currently a deliberate pass-through per `filters.model.ts`'s own doc comment — this
    section is the first to read/write it). New `rolesCompanies.model.ts` colocated,
    `parseRolesCompaniesDoc`/`applyRolesCompaniesEditorState`, mirroring `filters.model.ts`'s
    shape but covering `title` + the two new rank fields + `companies.avoid`. **Empty state,
    added this amendment (UI-gate F7, same idiom as step 11's)**: when `roles-rules-card`'s
    title match/reject lists are both empty, the card renders "No rules — nothing is dropped
    for this reason" + an inline `[Add]` seeding one empty chip-input focus — same rule,
    applied to this card's own rule list. **Done-condition + e2e**: new
    `ui/e2e/settings-roles-companies.spec.ts` — round-trips a domain-keyword add through
    `profile.json`, and a companies-avoid add through `filter.json`, each verified via
    `page.request.get`, matching `settings.spec.ts`'s server-truth idiom exactly; a further
    test seeds `filter.json.title` with all-empty match/reject arrays and asserts the "No
    rules — nothing is dropped for this reason" copy renders with a working `[Add]`.
14. **`ui/src/features/settings/sections/RulePreviewStrip.tsx` — new**, + colocated test + e2e.
    `POST /api/profiles/:name/preview/filter` with the current draft `RolesCompaniesSection`
    state (debounced or fired on blur — implementer's call within the "wired action" bar: the
    done-condition is the request fires with the current draft, not a specific trigger event).
    3 render states exactly matching `FilterPreviewResult`'s discriminated union: `available:
    true` → the strip with counts + `[see which 12 →]` disclosure; `available: false,
    reason:'no_recent_run'` → the muted one-liner; **not mounted at all** when the request has
    not yet been made (mirrors ux-notes' "no layout hole" design — this is a plain conditional
    render, not a loading skeleton, since the strip's absence is itself a valid, designed
    state per C6). **Done-condition + e2e**: new `ui/e2e/settings-rule-preview.spec.ts` —
    stubs `POST .../preview/filter` with an `available:true` body and asserts the strip
    renders the count text; a second test stubs `available:false,reason:'no_recent_run'` and
    asserts the muted copy; both via `page.route`, mirroring `run-fixtures.ts`'s stubbing
    idiom.
15. **`ui/src/features/settings/sections/AboutYouSection.tsx` — new** (rename of
    `ResumeSection.tsx`, content unchanged), delete `ResumeSection.tsx` +
    `ResumeSection.test.tsx` after the rename. **Done-condition + e2e**: `settings.spec.ts`'s
    existing "resume section round-trips years of experience" test's `page.goto` target
    changes to `#/settings/about-you`; no other change (relocation, same posture as step 12).

### Group C — Runs (Where jobs come from, Schedule, Fetching)

16. **`ui/src/features/shell/daemonState.ts` — new**, + colocated test. Pure function
    `daemonStatusWord(daemon: DaemonStatus, profile: string): {word: string; tone: 'success' |
    'attention' | 'destructive' | 'muted'; detail: string}` — the exact 6-branch derivation
    currently inline in `ScheduleSection.tsx:147-224`, covering `degraded`/`stopped`/`stale`/
    `running` (the 4 branches that are properties of a **successfully-returned** `DaemonStatus`).
    `daemon.isLoading`/`daemon.isError` (the `api-unreachable` state) are `useQuery` states, not
    properties of `DaemonStatus` — this function is never called while either is true; **named
    owners, corrected this amendment (UI-gate F2's aggravating point — "caller's concern"
    previously named no caller)**: `DaemonCard.tsx` (step 30) wraps its call to this function in
    its own `isLoading`/`isError` branches and owns the full-markup loading-skeleton and
    `api-unreachable`-error rendering (this is where `settings.spec.ts`'s 4 relocated daemon-
    state e2e tests land, per the e2e Disposition Ledger); `ScheduleSection.tsx`'s compact
    bridge line (step 18) wraps the same call the same way, rendering a minimal equivalent
    ("Loading…" / "Can't reach the daemon API", no dedicated `data-qa` — the bridge line is not
    itself a mockup-mapped region). Extracted so both consumers share one source of truth for
    the 4 branches that ARE `daemonStatusWord`'s concern. **Done-condition**: a test per branch
    (degraded/stopped/stale/running) matches `ScheduleSection.test.tsx`'s existing per-state
    assertions byte-for-byte (proves the extraction is behavior-preserving) — `api-unreachable`
    and loading are explicitly **not** cases of this function and carry no test here; their
    coverage lives at steps 18 and 30, per this step's ownership note above.
17. **`ui/src/features/settings/sections/WhereJobsComeFromSection.tsx` — new**, + colocated
    test + e2e. Two cards: lanes (extracted from `ProfileSection.tsx`'s lane checkboxes,
    unchanged logic) + search URLs (reuses `searchUrls.model.ts`'s `parseSearchUrlRows`/
    `serializeSearchUrlRows` unchanged, and the row-editing JSX from `SearchUrlsSection.tsx`).
    **Done-condition + e2e**: relocate `settings.spec.ts`'s "profile section round-trips a lane
    toggle" and "search urls section round-trips a new entry" tests' `page.goto` targets to
    `#/settings/where-jobs-come-from` (same relocation posture as steps 12/15); the existing
    scroll-gesture test (`settings.spec.ts:224-250`) relocates its target the same way.
18. **`ui/src/features/settings/sections/ScheduleSection.tsx` — edit.** Remove the inline
    6-branch daemon-status JSX block (lines ~146-225); replace with one compact line owning its
    **own** `isLoading`/`isError` branches around a call to `daemonStatusWord()` (step 16) +
    a link to `#/setup`, per ux-notes' "read-only daemon line linking to Operate" (bridge).
    Keep `times`/`weekdays`/`graceMinutes`/`enabled` fields and their save path unchanged.
    **Done-condition**: `ScheduleSection.test.tsx`'s existing six daemon-state tests are
    **replaced** (not moved verbatim — the rich per-state markup they assert no longer exists
    here) by (a) a new, smaller unit-test set asserting the compact line renders the correct
    `daemonStatusWord().word` text for each of the 4 states, plus its own loading/`api-
    unreachable` text; (b) a new assertion that clicking the line's link navigates to
    `#/setup`. **Corrected this amendment**: the six states' full-markup coverage is picked up
    fresh in `DaemonCard.test.tsx` (**step 30**, not step 20 as this document previously
    mis-cited — step 20 is `PacingPresetCard.tsx`). The four e2e tests this JSX removal
    orphans (`settings.spec.ts:252,280,302,332`) are dispositioned **REPLACE** in the new
    §e2e Disposition Ledger, landing on `operate.spec.ts` — not silently dropped.
19. **`ui/src/features/settings/sections/FetchingSection.tsx` — new**, + colocated test + e2e.
    `fetch-caps-card` (4 numeric fields, existing `Field`/`Input` pattern, bounds shown as
    `field-help`, effect copy including the cap-hit binding marker read from `GET .../runs/:id/
    soft-errors` — same data landing already reads) + the pacing card (`PacingPresetCard.tsx`,
    step 20 — corrected this pass, R2-F3; step 21 is `DeliverySection`). New
    `fetching.model.ts` — pure `presetFromRanges(jitterMin, jitterMax,
    interUrlMin, interUrlMax): 'safe'|'normal'|'fast'|'custom'` (matches the shipped
    Safe/Normal/Fast constants named in ux-notes §7 and blueprint-be §1's
    `LinkedinPacingSettingsSchema` defaults) + `rangesFromPreset(preset)`. **Done-condition +
    e2e**: new `ui/e2e/settings-fetching.spec.ts` — (a) round-trips `maxNewPerLane` through
    `profile.json`, server-verified; (b) selects the Fast preset, checks the ack box, saves,
    and asserts the saved doc's ranges match the Fast preset's ms values; (c) **the R13 demo
    case**: opens the Advanced disclosure, sets `jitterMinMs=15000`/`jitterMaxMs=12000`,
    clicks Save, asserts `[data-qa="validation-summary"]` is visible with text naming both
    fields and "would fail to start" (or the server's exact 422 message — assert against
    whatever `validators.test.ts` (blueprint-be step 4) actually emits, not an invented
    string), and asserts the doc was **not** written (re-`GET` shows the pre-save values).
20. **`ui/src/features/settings/sections/PacingPresetCard.tsx` — new**, + colocated test.
    Wraps `RadioGroupItem` (`asChild`) around the mockup's big custom card layout; the Fast
    variant renders the `Alert`-based warning (`pacing-fast-warning`) and the ack checkbox
    (`pacing-fast-ack`) inline, matching the mockup's nesting exactly (warning+checkbox are
    children of the Fast card, not siblings). **Unstated detail carried in this amendment
    (UI-gate judge's note, non-gating but folded in with F9)**: per ux-notes §7:325, the ack
    checkbox is **cleared** — not merely hidden — whenever the preset selection changes away
    from Fast (selecting Safe/Normal) or the raw Advanced fields are hand-edited into a
    `custom` state; re-selecting Fast later starts unchecked again, never remembering a prior
    acknowledgement. **Done-condition**: (a) selecting Fast without checking the ack still
    allows Save (the ack is **not** a save-blocking validator — ux-notes never states it blocks
    save, only that it must be checked to acknowledge; treating it as a hard gate would be an
    invented constraint) — the colocated test asserts Save proceeds with Fast selected and the
    ack unchecked, so a later reviewer doesn't "fix" this into a block that was never designed;
    (b) a second test checks the ack, switches the preset to Safe then back to Fast, and
    asserts the ack renders **unchecked** on the return to Fast — proving the clear-on-switch
    behaviour, not merely its absence when never checked.

### Group D — Output (Delivery, Housekeeping) + Advanced (Raw config, Danger zone)

21. **`ui/src/features/settings/sections/DeliverySection.tsx` — new**, + colocated test + e2e.
    Connector **read-only display** (R11 — a `<span>` + explanatory copy, no `<select>`;
    `ProfileSection.tsx`'s current `<select>` is the control being **deleted**, not migrated —
    see Mockup Divergences) + Notion `mirror`/`dryRun` `Switch` ×2 (new fields, currently
    unsurfaced, `profile.json.settings.notion.*`) + Telegram notifier checkbox (extracted from
    `ProfileSection.tsx`, unchanged). **Done-condition + e2e**: new
    `ui/e2e/settings-delivery.spec.ts` — toggles Notion `mirror`, saves, asserts
    `profile.json.settings.notion.mirror === true` server-side; asserts the connector control
    has no interactive role (`getByRole('combobox')` / `getByRole('button')` scoped to the
    connector field returns zero elements — proves it is genuinely display-only, not a
    disabled control, matching R11's own "displayed read-only" wording, distinct from a
    disabled-but-present `<select>`).
22. **`ui/src/features/settings/sections/HousekeepingSection.tsx` — new**, + colocated test +
    e2e. Cleanup TTLs (`runsOlderThanDays`, `checkpointsOlderThanDays`, `passedOlderThanDays`,
    `untouchedOlderThanDays` — new fields, `profile.json.settings.cleanup.*`) + routines
    (extracted from `ProfileSection.tsx`'s routines chip list, unchanged, now using
    `ChipInput`). **Done-condition + e2e**: new `ui/e2e/settings-housekeeping.spec.ts` —
    round-trips `runsOlderThanDays` through `profile.json`, server-verified.
23. **`ui/src/features/settings/sections/RawConfigSection.tsx` — new**, + colocated test + e2e.
    Two-pane layout: `raw-doc-list` (4 rows, click sets local `selectedDoc` state) + `raw-
    editor` (`Textarea`, same `configDocQuery`+`useConfigMutation` seam `JsonEscapeHatch.tsx`
    already uses, now inline instead of in a dialog). Each doc row carries a static
    `RAW_KEY_ROUTES` map (new, e.g. `{doc:'profile.json', key:'schedule', route:
    {section:'schedule'}}`) rendering `has a form →` badges that call `navigate()`; keys with
    no form (`settings.rank` weights, registry health thresholds, adapter settings) render the
    plain `raw only` badge with no click handler. **Empty state, added this amendment (UI-gate
    F7, ux-notes §12:480)**: a selected doc whose `configDocQuery` resolves to empty text
    (`getConfigDoc`'s existing behaviour for a doc row with no `config_docs` entry yet — a
    fresh profile missing e.g. `resume.json`) renders *"Not created yet — saving will create
    it"* in the editor pane instead of an empty textarea, and Save still works (the existing
    `PUT config/:doc` path creates the row on first write — no new server behaviour, this is a
    copy-only addition over data the query already carries). **Done-condition (effect-
    asserting, UI-gate F4)**: clicking a `has a form →` badge (e.g. `raw-key-badge-schedule`)
    calls `navigate({name:'settings', section:'schedule'})` — a `navigate` spy assertion,
    mirroring step 7/27's own convention; the plain `raw only` badge (`raw-key-badge-rank-
    weights`) has no click handler at all, asserted by its absence of an `onClick`/button role.
    **Done-condition + e2e**: extend `ui/e2e/settings.spec.ts`'s existing "JSON escape hatch
    round-trips raw text" and "invalid JSON is rejected" tests (tests 6–7 in the e2e
    Disposition Ledger) to target `#/settings/raw-config` and the inline textarea instead
    of the dialog (`getByTestId('settings-json-open')` click is removed — the textarea is
    already visible); assert AC4 directly: editing a value in `raw-editor`, saving, then
    navigating to the owning form section (e.g. `#/settings/schedule`) shows the new value
    with **no reload** (single-page navigation via `navigate()`, cache shared through
    `configDocQuery`'s query key — this is the mechanism that makes AC4 true, not a new
    invalidation step); a further test selects a not-yet-created doc and asserts the "Not
    created yet — saving will create it" copy, then saves and asserts the doc now round-trips
    via `page.request.get` (proves the create-on-first-write path, not just the copy).
24. **`ui/src/features/settings/JsonEscapeHatch.tsx` — delete**, + `JsonEscapeHatch.test.tsx`.
    Superseded by step 23 (R4: one consolidated area, not six per-section hatches).
    **Done-condition**: zero remaining imports of `JsonEscapeHatch` anywhere in `ui/src`
    (compiler-enforced).
25. **`ui/src/features/settings/SettingsPage.tsx` — edit.** Delete `PLACEHOLDER_COPY` (dead
    code named in ux-notes NOTES, `SettingsPage.tsx:30-34`). Replace the `Tabs`-based render
    with `<SettingsShell section={section} profile={profile} />` (step 26). `SectionBody`'s
    switch grows to 12 cases — **corrected this amendment (UI-gate F1): the `'landing'` case
    mounts `LandingSection` (step 9d), not nothing** — one case per new section component from
    Groups B–D, `'landing'` included. Delete the `{doc && <JsonEscapeHatch .../>}` line
    (superseded by step 23). **Done-condition**: `SettingsPage.test.tsx` is rewritten to assert
    the new nav renders and each of the 12 section slugs — including `'landing'` — mounts its
    corresponding component (a parametrized test, one case per slug; the `'landing'` case's
    assertion is what closes F1's "mounts nothing for the default route" defect at this file).
26. **`ui/src/features/settings/SettingsShell.tsx` — new**, + colocated test.
    `data-qa="settings-shell"` root, composes `SettingsNav` + the section body + `SaveBar` +
    `DirtyNavGuard`. **Done-condition**: rendering with `section="landing"` shows the landing
    nav item as `active` (`aria-current="page"`) and every other nav item as not-active.
27. **`ui/src/features/settings/SettingsNav.tsx` — new**, + colocated test. 4 groups
    (`data-qa="settings-nav-group-{aim|runs|output|advanced}"`), **12 links total** (corrected
    this amendment — the mockup's Aim group **does** carry a "What decides your board" link,
    `mockup.html`'s `settings-nav-group-aim`, rendered `active`/`aria-current="page"` — Aim: 5
    links incl. landing, Roles & companies, Where you'll work, Skills, About you; Runs: 3;
    Output: 2; Advanced: 2). The landing link's target is `{name:'settings', section:'landing'}`
    (step 9d), same `navigate()` path every other link uses — no special-cased routing.
    **Done-condition**: clicking a link calls `navigate({name:'settings',
    section:'<slug>'})` (spy-asserted, mirrors step 7/`router.test.ts`'s own convention) —
    routed through `DirtyNavGuard` when dirty, direct when clean (both paths covered by the
    colocated test).

### Group E — Operate (Daemon/Scheduled/LinkedIn/Setup&health/Secrets)

28. **`ui/src/features/operate/` — new folder.** Move `hub.api.ts` → `operate/operate.api.ts`
    (rename only: keeps `getDoctorReport`, adds `getBreakerStatus`/`getLinkedinSession`/
    `checkLinkedinSessionNow`/`stopDaemon`/`startDaemon`/`setAutostart`/`putSkipNext`
    functions). Move `hub.queries.ts` → `operate/operate.queries.ts` (rename; adds query
    options for the new reads + `useMutation` wrappers for the new writes). Delete
    `hub.model.ts`'s `HUB_CARDS`/`CHECK_TO_CARD`/`cardAction` (superseded by the merged
    Setup & health card's own grouping, step 35) — **keep** `scheduleWarning()` (still useful,
    reused by `DaemonCard.tsx`'s degraded-state check, step 30) in a new
    `operate/operate.model.ts`. **Delete `HubStepDialog.tsx` + `HubStepDialog.test.tsx`, added
    this amendment (e2e Disposition Ledger, hub.spec.ts test 5)** — the dialog-triggered
    mini-wizard "Set up" affordance is superseded by design: ux-notes' C11 states every Setup
    & health finding "carries a **destination** — a link into the owning Settings section...
    The board never performs \[setup steps]," which is the opposite of `HubStepDialog`'s
    in-board mini-wizard. The capability it offered (persona-filters/search-urls/integrations
    completion) survives as a Settings deep-link, since Settings now has a real form for every
    one of those topics — `hub.spec.ts` test 5's "ok card offers Edit in Settings" half is
    covered by step 35's destination-link assertion; its "non-ok card opens a Set-up dialog"
    half has no successor by design, not by oversight. **Done-condition**: no remaining import
    of `hub.api.ts`/`hub.queries.ts`/`hub.model.ts`'s deleted exports, or of `HubStepDialog`,
    anywhere in `ui/src` (compiler-enforced for the deleted exports; `scheduleWarning`'s single
    call site is updated to the new import path).
29. **`ui/src/features/operate/OperatePage.tsx` — new** (rewrite of `HubPage.tsx`, which is
    deleted along with `HubPage.test.tsx`). `data-qa="operate-shell"`, page header + `scope-
    chip-machine` badge, 2-col grid of the 5 cards below. **Done-condition + e2e**: new
    `ui/e2e/operate.spec.ts` (supersedes `hub.spec.ts`, which is deleted) — first test asserts
    `#/setup` renders all 5 `data-qa` cards (`card-daemon`, `card-scheduled-runs`, `card-
    linkedin`, `card-setup-health`, `card-secrets`); second test asserts the sidebar nav item
    at `#/setup` reads "Operate" (relocates `hub.spec.ts`'s existing "sidebar nav item" test,
    updated for the new label).
30. **`ui/src/features/operate/DaemonCard.tsx` — new**, + colocated test + e2e (folded into
    `operate.spec.ts`). Renders `daemonStatusWord()` (step 16) as the full 6-state display
    (state, last-tick, pid, uptime — the fields `ScheduleSection.tsx` used to show).
    `daemon-start-stop` button: label flips `Stop`/`Start` off `daemon.state`; `onClick` calls
    the appropriate mutation (step 31) — **Start's button click optimistically flips to a
    long-wait affordance within 400ms** (a spinner + "Starting… this can take up to 35
    seconds" copy — **not** the generic Doherty `Saving…` flip the save model uses, per BE
    F9/§9's explicit flag that the ≤400ms pattern does not fit here), then resolves to one of
    `{started, already_running, spawn_failed}` — each rendered as a distinct, named line, never
    silently re-rendering as if nothing happened. `daemon-pause-all` fans out N `PUT
    config/profile.json` calls (step 32) and reports partial failure explicitly (e.g. "Paused
    3 of 4 profiles — rajni failed: <message>"), never a single boolean "done". `daemon-
    autostart` switch: on darwin, clicking it calls `setAutostart(!current)` (step 31); on
    non-darwin, renders `unsupported_platform` as a **static, disabled-look row with inline
    copy** ("Autostart is darwin-only"), not a live switch that silently no-ops — this is a
    genuine `disabled` control (not a save button), acceptable because GOV.UK's "don't disable
    submit" rule is about *validation* gating, not platform unavailability. **Done-condition +
    e2e**: `operate.spec.ts` gains: (a) a test stubbing `POST /api/daemon/stop` with
    `{outcome:'stopped'}`, clicking Stop, asserting the card re-renders `Stopped` and the
    button flips to `Start`; (b) a test stubbing `{outcome:'daemon_unresponsive'}` and
    asserting a **visibly distinct, non-success** rendering (not the same styling as
    `stopped`) — this is the exact regression BE's F1 finding exists to prevent, and the e2e
    must catch a UI that collapses it back into a quiet success; (c) a test stubbing `POST
    /api/daemon/start` with a delayed response (`>1s`) and asserting the long-wait copy is
    visible before the response resolves, then the resolved state after; (d) a test stubbing
    `{outcome:'child_unresponsive', childPid: 123}` and asserting the pid appears in the
    rendered warning (proves the outcome's payload is used, not discarded).

    **Added this amendment (UI-gate F4 + F2, effect-asserting, both gating):**

    (e) a test on a stubbed-darwin platform clicks `daemon-autostart`, asserts the mutation
    fires `setAutostart(true)` (from a stubbed-off state), stubs the response
    `{outcome:'ok'}`, and asserts the switch renders checked; a second test stubs
    `{outcome:'unsupported_platform'}` on the same click and asserts the switch reverts to
    its static disabled-look row with the darwin-only copy — **both `AutostartOutcome` values
    rendered under test**, closing the R20-ruling gap the judge named (neither value was
    previously exercised).
    (f) a test clicks `daemon-pause-all` against a stub returning 2-of-4 profiles failed
    (`usePauseAll`'s `{succeeded, failed}` shape, step 32) and asserts (i) the mutation was
    actually invoked (not an inert button — a spy on the hook's `mutate`) and (ii) the
    rendered line names the exact count and the failed profile(s), matching the "Paused 3 of 4
    profiles — rajni failed: <message>" copy above rather than a single boolean.
    (g) a test stubbing `GET /api/daemon` with `degraded: true, schemaVersion: 8,
    buildVersion: 7` (mirrors `settings.spec.ts:252`'s fixture) navigates to `#/setup` and
    asserts `[data-qa="daemon-state"]` renders "Degraded — schema v8 > daemon build v7" plus
    the remedy command — **replaces** `settings.spec.ts`'s orphaned degraded-state test per
    the e2e Disposition Ledger.
    (h) a test stubbing a healthy `running` daemon (mirrors `settings.spec.ts:280`) asserts
    zero degraded markup renders — **replaces** the orphaned healthy-state test.
    (i) a test stubbing a network failure on `GET /api/daemon` (mirrors
    `stubDaemonUnreachable` from `run-fixtures.ts`, reused, and `settings.spec.ts:302`) asserts
    `DaemonCard` renders its own `api-unreachable` error state (never mistaken for `degraded`)
    with a working `[Retry]` that re-issues the `GET` — **this is `api-unreachable`'s owner,
    named explicitly per step 16's correction, and replaces the orphaned unreachable-state
    test**.
    (j) a test holding `GET /api/daemon` open past first paint (mirrors
    `settings.spec.ts:332`'s held-route idiom) asserts the loading skeleton renders and
    resolves into the healthy state once the request lands — **replaces** the orphaned
    loading-skeleton test.
    (k) a test stubbing a stopped daemon + an enabled schedule with a known next time (mirrors
    `hub.spec.ts:103-140`'s `stubDaemon`/config-route stubbing) asserts the same
    `scheduleWarning()`-derived banner copy ("Scheduled for `<time>` but the daemon isn't
    running", the `jobbunny serve start` command) renders inside `DaemonCard`'s degraded
    treatment, and is absent once the stub reports `running` — **adapts** `hub.spec.ts`'s
    schedule-vs-daemon banner test into its new home per the e2e Disposition Ledger.
31. **`ui/src/features/operate/useDaemonControl.ts` — new**, + colocated test. Three
    `useMutation` wrappers (`stopDaemon`/`startDaemon`/`setAutostart`) over `operate.api.ts`'s
    functions, typed by the 3 outcome unions (step 9). No optimistic cache writes (mirrors
    `useConfigMutation.ts`'s own "no optimistic update, the result IS the state" posture) —
    `onSuccess` invalidates `daemonQuery()`'s query key so `DaemonCard`'s next render reflects
    the server's fresh state rather than a client-guessed one. **Done-condition**: a test
    asserts `onSuccess` calls `queryClient.invalidateQueries` with the exact `wizardKeys.
    daemon()` key (reused, not a new key — `DaemonCard` and `ScheduleSection`'s bridge line
    must invalidate off the same cache entry or they can show different daemon states
    simultaneously, which would be a real bug).
32. **`ui/src/features/operate/usePauseAll.ts` — new**, + colocated test. `useMutation`
    wrapping a `Promise.allSettled` fan-out over every profile from `GET /api/profiles`
    (existing endpoint, `profiles.api.ts`), each a `PUT config/profile.json` write of
    `schedule.enabled = false`. Returns `{succeeded: string[]; failed: {profile:string;
    message:string}[]}`. **Done-condition**: a test stubbing 2 of 4 profile PUTs to fail
    asserts the returned shape lists exactly those 2 under `failed` with their messages, and
    the other 2 under `succeeded` — proving the non-atomicity is surfaced, not swallowed
    (BE §7's explicit flag).
33. **`ui/src/features/operate/ScheduledRunsCard.tsx` — new**, + colocated test (folded into
    `operate.spec.ts`). One row per `daemon.profiles[]` entry, active-profile row `bg-accent`
    (compares against the sidebar's selected profile, read the same way `ProfileSwitcher.tsx`
    already does). `schedule-skip-next` button: `PUT config/profile.json` with `schedule.
    skipNext = {date: todayISODate(), slot: <matching configured time>}` — the exact slot
    value is the profile's **next** scheduled `HH:MM` from `daemon.profiles[].nextRunAt`,
    derived client-side (new small pure fn `nextSlotFor(nextRunAt): {date,slot}` colocated).
    **Done-condition + e2e**: `operate.spec.ts` gains a test that clicks `schedule-skip-next`
    for a stubbed profile, asserts the PUT body's `schedule.skipNext` matches the expected
    `{date,slot}` pair, and asserts the row shows a "Next run skipped" chip after success
    (per ux-notes §12's five-state table, S6/S7 success row).
34. **`ui/src/features/operate/LinkedinCard.tsx` — new**, + colocated test + e2e (folded into
    `operate.spec.ts`). `linkedin-session` row (3 states, `daemonState.ts`-style tone mapping)
    + `linkedin-session-check` button (`POST /api/linkedin/session/check`, **no optimistic
    flip** — the button shows a brief `Checking…` label via the mutation's own `isPending`,
    then the server's returned state, never guesses signed-in) + `linkedin-breaker` row
    (closed / open-until, no control). **Done-condition + e2e**: (a) a test stubbing `GET
    /api/linkedin/session` with `{state:'unknown', checkedAt:null}` asserts the row renders
    "Unknown" in amber, never a false "Signed out" (AC15's own wording, directly testable);
    (b) a test stubbing the breaker `GET` with `{phase:'open', reopenAt:'<iso>'}` asserts the
    row renders "Open until <formatted time>" and that **no** reset control exists anywhere
    in the card (`getByRole('button', {name: /reset/i})` returns zero — R18's "no manual
    reset" as a positive assertion, not an absence noted only in prose). **Added this amendment
    (UI-gate F4, effect-asserting)**: (c) a test stubs the cached `GET /api/linkedin/session`
    with `{state:'signed-in', checkedAt:'<iso>'}`, clicks `linkedin-session-check`, and asserts
    (i) `POST /api/linkedin/session/check` actually fires (a route/spy assertion — an inert
    button would pass every other test in this step) and (ii) **before** the POST resolves,
    the row still shows the prior cached `signed-in` state, not an optimistic guess — the
    positive assertion "no optimistic flip" claim needed to be testable, not prose-only; once
    the stubbed POST resolves to a different state (e.g. `signed-out`), the row updates to
    match.
35. **`ui/src/features/operate/SetupHealthCard.tsx` — new**, + colocated test + e2e (folded
    into `operate.spec.ts`). New `operate/checkDestination.ts` (pure): `CHECK_TO_DESTINATION:
    Record<string, {kind:'settings-link'; route: Route} | {kind:'cli-command'; command:
    string}>`, covering all 13-14 doctor checks (extending `hub.model.ts`'s deleted
    `CHECK_TO_CARD`'s check-name list one-for-one, now mapped to a destination instead of a
    card). The two Claude-dependent named cases (R23): `'notion-db-reachable'` → `{kind:
    'settings-link', route:{section:'delivery'}}` (Notion secrets/mirror ARE board-settable,
    not Claude-dependent — only *adopt-or-create* is, and that is never offered as a control
    here, only the token/mirror fields), and a resume-not-parsed finding (new doctor check,
    **out of this blueprint's scope to add** — if `hasResumeParsed` does not already exist as
    a doctor check, this row is a **BE bounce**, not invented here; see Risks) → `{kind:
    'cli-command', command:'jobbunny setup'}`. Findings grouped `Needs action` / `Not
    configured` / `OK (n)` (new grouping fn, replaces `cardStatus`), collapsed into one line
    when `OK === total`. **`data-qa` template, named explicitly this amendment (UI-gate F8)**:
    ux-notes §17:627 specifies `health-group-{needs-action|not-configured|ok}` as a template
    of three, but the mockup only instantiates `health-group-ok` (the healthy S6 render) — this
    step renders **all three** ids (`health-group-needs-action`, `health-group-not-configured`,
    `health-group-ok`), each present only when its group is non-empty, so QA can pair
    mechanically off §17's template rather than the mockup's one instantiated case. **"Set up a
    new profile" — added this amendment, USER-RULED (UI-gate F3, not re-litigated): the
    entry point deleting `HubPage.tsx` would otherwise remove.** A footer button on this card
    (mirroring `HubPage.tsx:122-128`'s exact placement/copy, the only change being its new
    home), `onClick={() => navigate({name:'onboarding'})}` — the existing route (`router.ts:9`)
    and the existing `WizardPage` at `#/onboarding` are both untouched; this is wiring only, no
    new page. **Done-condition + e2e**: a test stubbing all findings `status:'ok'` asserts the
    card renders the single collapsed line "Setup complete · N/N checks passing" and zero
    visible finding rows until the disclosure is opened; a test stubbing one `warn` finding
    with a `cli-command` destination asserts a `[Copy: <command>]` button is present and, when
    clicked, writes the exact command to the clipboard (assert via a
    `navigator.clipboard.writeText` spy, matching the pattern `S6b`'s mockup `copyCmd()` stubs
    — Playwright's clipboard permission grant is required in the test, same as any other
    copy-button test in this suite would need); **added this amendment (F3)** — a test clicks
    "Set up a new profile" and asserts `page` navigates to `#/onboarding` with the wizard
    visible (`getByTestId('wizard')`) — **carries over** `hub.spec.ts:172-177`'s identical
    test unchanged in substance, new host file/route context only, per the e2e Disposition
    Ledger's SURVIVE disposition for this one test (the capability is preserved, not lost;
    only its file and page moved).

    **Two clauses added this pass (R2-F1) — the e2e Disposition Ledger (`hub.spec.ts` test 3)
    and step 28's claim about `hub.spec.ts` test 5 both promised coverage this step's
    done-conditions never actually asserted:** (f) a test stubbing one `warn` finding whose
    `CHECK_TO_DESTINATION` entry is `{kind:'settings-link', ...}` — reusing this step's own
    already-named example, `'notion-db-reachable'` → `{kind:'settings-link',
    route:{section:'delivery'}}` — asserts it renders **inside**
    `[data-qa="health-group-needs-action"]` specifically — group membership asserted directly,
    not merely that a finding renders somewhere on the card (this is what the ledger's
    "appears under Needs action" promise requires and what F8's three-id template exists to
    make checkable). (g) the same test (or a sibling) clicks that finding's destination link
    and asserts `navigate()` fires to `{name:'settings', section:'delivery'}` — the
    **settings-link** half of `CHECK_TO_DESTINATION`, which step 28 (`hub.spec.ts` test 5's
    disposition) explicitly claims this step covers for the "ok card offers Edit in Settings"
    behaviour; it did not, until now.
36. **`ui/src/features/operate/SecretsCard.tsx` — new**, + colocated test + e2e (folded into
    `operate.spec.ts`). Two rows (`NOTION_TOKEN`, `TELEGRAM_BOT_TOKEN`), `configured`/`not
    configured` from existing `GET /api/secrets`, `[Set]` opens a small `Dialog` with a
    `type="password"` `Input` + `putSecret()` (reused, `wizard.api.ts`, unchanged). **Done-
    condition + e2e**: a test opens the dialog, types a value, submits, asserts the dialog
    closes and the row now reads "configured" (re-fetch after success) — and asserts the
    submitted value is **never** rendered anywhere in the DOM afterward (a `page.content()`
    scan not containing the typed string — R24's "no secret value is ever returned/shown" as
    a positive, mechanical e2e assertion).
37. **`ui/e2e/hub.spec.ts` — delete.** Superseded by `ui/e2e/operate.spec.ts` (steps 29-36).
    **Corrected this amendment (UI-gate F2's aggravating note, F3)**: the prior blanket "every
    assertion that still applies" clause is retired — each of `hub.spec.ts`'s 6 tests has its
    own explicit disposition in the **§e2e Disposition Ledger** (2 REPLACE, 3 ADAPT, 1 SURVIVE)
    and its own named destination step above (29, 30(k), 35, 28). **Done-condition**: `grep -r
    "hub.spec" ui/` returns nothing; `npm run --prefix ui e2e` passes with every one of the 6
    dispositions in the ledger accounted for by name at its cited step — not a blanket
    "covers what still applies" claim.

### Group F — Deletions and cross-cutting cleanup

38. **`ui/src/features/settings/sections/ProfileSection.tsx` + test — delete.** Fully
    dissolved: lanes → step 17, connector/Notion/Telegram → step 21, routines → step 22, per
    ux-notes' explicit "Profile → dissolved entirely" ruling. **Done-condition**: zero
    remaining imports.
9999. *(intentionally no step numbered "write the e2e suite" — every screen/state step above
    already carries its e2e in the same step, per the state-pinning principle.)*

---

## 5. Requirements Coverage

| Req | MoSCoW | Step(s) | e2e id (screen/state Musts) |
|---|---|---|---|
| R1 | Must | 1, 26, 27 | `router.test.ts` new cases; no e2e needed (a naming assertion, not a state) |
| R2 | Must | 10, 11 | `settings-where-you-work.spec.ts` (3 tests, step 11) |
| R3 | Must | 26, 29 (scope chips), AC3 | `operate.spec.ts`'s scope-chip assertions (step 29) |
| R4 | Must | 23, 24 | `settings.spec.ts` extended (step 23) — AC4's no-reload assertion |
| R5 | Should | 7 | `DirtyNavGuard.test.tsx` (unit; no e2e required — an interaction test, not a state) |
| R6 | Must | 19 | `settings-fetching.spec.ts` (step 19) |
| R7 | Must | 11, 13 | `settings-where-you-work.spec.ts`, `settings-roles-companies.spec.ts` |
| R8 | Must | 11, 13 | same |
| R9 | Must | 21 | `settings-delivery.spec.ts` |
| R10 | Should | 22 | `settings-housekeeping.spec.ts` |
| R11 | Must | 21 | `settings-delivery.spec.ts`'s "no interactive role" assertion |
| R12 | Should | 19, 20 | `settings-fetching.spec.ts` (Fast preset test) |
| R13 | Must | 19 | `settings-fetching.spec.ts`'s R13 demo-case test |
| R14 | Must | 5, 6 | folded into every section's own save e2e (success-line assertion; no standalone spec needed — S8 is not its own screen, it's a cross-cutting model exercised by every section test) |
| R15 | Should (conditional, spike passed) | 14 | `settings-rule-preview.spec.ts` |
| R16 | Must | 30 | `operate.spec.ts` — done-conditions (g)-(j), the four states relocated from `settings.spec.ts` |
| R17 | Must | 34 | `operate.spec.ts` (unknown-never-signed-out test, plus (c) added this amendment — the POST actually fires, no optimistic flip) |
| R18 | Must | 34 | `operate.spec.ts` (breaker + no-reset test) |
| R19 | Must | 33, 32 | `operate.spec.ts` (skip-next test); pause/resume rides existing `schedule.enabled` PUT, covered by step 33's row-level switch (no separate spec — same mechanism as `settings.spec.ts`'s existing enabled-switch test); pause-all's fan-out effect added this amendment at 30(f) |
| R20 | Must (Option 1 ratified) | 30, 31 | `operate.spec.ts` (stop/start/unresponsive/long-wait tests, plus (e) added this amendment — both `AutostartOutcome` values now rendered under test, closing the prior gap) |
| R21 | Should | 35 | `operate.spec.ts` (destination-link/command test) |
| R22 | Must | 35 | `operate.spec.ts` (needs-action grouping test) |
| R23 | Must | 35 | `operate.spec.ts`'s `[Copy: <command>]` test |
| R24 | Must | 36 | `operate.spec.ts`'s secret-never-rendered test |
| R25 | Should | 38 (DangerZone unchanged) | existing danger-zone e2e coverage (unchanged, out of this blueprint's new-test scope) |
| R26 | Could | **not built** | — (deferred, §Mockup Divergences) |
| R27 | Could | **not built** | — (tail item, cut; blueprint-be §5 also leaves it undesigned) |
| R28–R32 | Won't | — | — |

**Landing (steps 9a–9d, new this amendment) is not tied to a single numbered requirement** —
per ux-notes §16 weakness 4, it is UX-added scope answering Content Priority #1/#2 and G2
directly, and reinforcing R6/R14 at zero clicks after arriving (the same caps/effect data R6
requires, surfaced a second time at the landing page in addition to its primary home in
Fetching, step 19). Its own e2e (`settings-landing.spec.ts`, step 9d) is the state-pinning
coverage for this scope, listed here so it isn't mistaken for an unmapped requirement.

---

## 6. Mockup Divergences

| Divergence | Justification (feasibility gate) |
|---|---|
| `settings-search` (R26) not built | Spec-level Could, explicitly in the "tail — ship only if cheap" list (spec §12); ux-notes' own NOTES says promote only if a re-run of the §9 navigation test against the new IA scores below 4/5 — no such re-test has been run in this pipeline stage, so there is no evidence trigger to promote it. Deferred, not silently dropped: the header row still reserves the layout slot per ux-notes §5 ("header reflows" if cut), so adding it later is a pure addition, not a rework. |
| `daemon-start-fallback` (S6b, the R20 "mechanism ruled out" variant) not built | The orchestrator relayed the user's ruling: **R20 = Option 1**, all three of Start/Stop/Autostart ship. The fallback variant ux-notes designed for "BE gate ruled the mechanism out" is now counterfactual — building a dead code path that can never render (the real Start control always exists) would be waste, not fidelity. Mapped and excluded with this reason, not omitted. |
| `ProfileSection.tsx`'s connector `<select>` is deleted, not migrated to a disabled `<select>` | R11 mandates "displayed read-only" with copy explaining why, sourced from Grafana's provisioning-asymmetry pattern (spec §3) — a disabled-but-present `<select>` reads to the user as "temporarily can't touch this," which is the opposite of the intended message ("this is a migration, not a setting"). A plain `<span>` is the correct fidelity to R11's own wording, and to the mockup's own markup (the mockup's Delivery-area connector display was not literally shown as a screen in `mockup.html`, but ux-notes §2's Delivery row and R11's AC10 both specify display-only). |
| `HubPage.tsx`/`hub.spec.ts` fully replaced rather than incrementally edited | The Hub-vs-Settings boundary ruling (Option C+D) redefines the page's entire card set (5 new cards replacing 6 old ones, zero 1:1 overlap in content even though 2 of 6 old topics survive in spirit). An incremental edit would leave dead code paths and stale tests pinning cards that no longer exist; a rewrite with a fresh e2e file is more honest about the scope of change than a diff that touches every line of an old file. |
| S7 (degraded Operate) has no dedicated component | The mockup's own note at the bottom of its S7 section states this explicitly: "S7's cards intentionally omit `data-qa` — each canonical id already renders exactly once on S6." This blueprint follows that instruction literally — S7 is a **state** of the S6 components (steps 30/34/35's colocated tests each cover the degraded branch), not a second set of components. |
| Badge's mockup `.badge.on-primary` style has no new CVA variant | Two use sites only (`scope-chip-machine`, one caps-table binding badge); adding a fourth badge variant for two call sites is over-engineering relative to using the existing `Badge` component's `className` merge with real Design Scale tokens (`bg-accent text-primary`) — no hardcoded hex, still token-sourced, per the Design-token-sync gate. |

No mockup element is being silently dropped without a row above or in §Component Mapping's
`deferred` verdicts.

---

## 7. Risks & Assumptions

- **RESOLVED this amendment (UI-gate F6) — no longer an open risk.** `app/features/
  linkedin/index.ts` and `app/features/preview/index.ts` are confirmed-absent new barrels, and
  `app/features/daemon/index.ts` exports zero types today (not "extends an existing line," as
  this document previously understated). The BE-gate bounce this finding triggered is closed:
  blueprint-be §2/§11a now pins all six identifiers (`BreakerStatus`, `LinkedinSessionStatus`,
  `FilterPreviewResult`, `StopDaemonOutcome`, `StartDaemonOutcome`, `AutostartOutcome`, all
  defined once in `src/ports/board.ts`, each re-exported per-feature). Step 9 is a **hard,
  named BE-side dependency** for this blueprint's implementation order — the three barrels
  must land before step 9 can compile — not a same-PR one-liner as originally framed.
- **A "resume not parsed" doctor check may not exist yet.** Step 35's `CHECK_TO_DESTINATION`
  map assumes a doctor check name for this (the mockup's S7 shows the row). If no such check
  exists server-side today, this is a **BE bounce** (a data need with no cited BE source),
  scoped narrowly to that one row — every other row in the same map cites an existing,
  confirmed doctor check (`hub.model.ts`'s prior `CHECK_TO_CARD` list). Flagged, not silently
  invented; the implementer must verify against `src/ops/doctor/aggregate.ts` before wiring
  this one row and, if absent, render it under "Not configured" with no destination rather than
  inventing a check.
- **R15's preview-trigger event is not fully pinned by ux-notes or blueprint-be** — step 14
  leaves "debounced or on blur" to the implementer, deliberately, since the mockup shows only
  the strip's rendered states, not its trigger. This is the one place in this blueprint where a
  UI micro-decision is left open; it does not affect the done-condition (the request firing
  with the current draft state is what's asserted, not the exact event).
- **`RunResult`'s hand-typed shape (step, Landing) can drift from `ops/observability/run/
  result.ts` silently** — inherited risk, named in blueprint-be §9, not solved here (cross-
  boundary by design). A schema change on the BE side without a matching UI-side type edit
  fails at `tsc --noEmit`, not silently — acceptable given the existing precedent (`lib/api/
  types.ts`'s other 4 barrels carry the same risk today).
- **Skills, section 12: `filters.model.ts`'s `parseFilterDoc`/`applyFilterEditorState` remain
  the joint owner of `title`+`locations`+`skills`** across three now-separate section
  components (Roles & companies owns `title`, Where you'll work owns `locations`, Skills owns
  `skills`) — three components writing through the *same* `useDocForm(profile,'filter.json')`
  read-modify-write seam is safe (each mutate callback only ever touches its own keys, per
  `applyFilterEditorState`'s existing "assigns exactly those three keys" contract) but means a
  user editing two of the three sections in the same session without saving between them can
  lose one section's edits to the other's — this is exactly what R5's dirty-nav guard (step 7)
  exists to prevent (it fires on cross-section navigation), so the risk is mitigated by design,
  not unaddressed, but is worth naming since it's a genuine consequence of splitting one form
  into three.

---

## 8. Engineering Quality Gates

- **Determinism**: every section's render is a pure function of its `useDocForm`/`useQuery`
  data plus local (dirty-draft) state — no `Math.random`/`Date.now()` in a render path except
  inside already-existing, already-tested helpers (`daemonStatusWord`'s "last tick Ns ago"
  reads `Date.now()` once per render, same posture `ScheduleSection.tsx` already has today).
  Same server state ⇒ same DOM, verified by every colocated test's fixed-input assertions.
- **Fault tolerance**: `DocFormGate` (existing, reused unchanged) is the error boundary for
  every JSON-doc section — a load error renders its own message and nothing else mounts
  underneath (no partial-form-over-broken-data state possible). Operate's 5 cards are
  independently query-scoped (`GET /api/daemon`, `GET .../doctor`, `GET /api/linkedin/*`,
  `GET /api/secrets` are 4 separate queries) so one card's error (e.g. `api-unreachable`
  daemon) never blanks the other 4 — matches ux-notes §12's "per-card `[Retry]`" state design.
- **Design-token sync**: every new component uses Tailwind utility classes resolving to the
  real tokens in `ui/src/index.css` (`bg-accent`, `text-attention-strong`, `border-attention`,
  etc.) — zero hardcoded hex anywhere in this blueprint's new files. The one correction filed
  in §0 (using `-strong` variants for text, plain variants for tints/icons/dots) is the
  binding rule for every status word this blueprint renders. Every spacing/size value traces
  to ux-notes §3's Design Scale table (`p-3`/`p-4`/`gap-1.5` etc., all Tailwind-default,
  no custom scale).
- **Micro-optimizations**: no section re-fetches data another section already holds cached —
  `ScheduleSection`'s daemon bridge line and `DaemonCard` share `wizardKeys.daemon()`'s single
  query key (step 31's invalidation target); the Landing screen's caps/rules tables read the
  same `configDocQuery` cache entries the owning sections themselves prime, so navigating
  Landing → a cap's own section is a cache hit, not a re-fetch. `ChipInput` (step 3) and
  `SaveBar` (step 5) are the two components instantiated most often (10+ and 11 times
  respectively) — both are kept prop-driven with no internal query/mutation of their own,
  so React's default reconciliation is sufficient; no `memo`/`useMemo` is prescribed
  pre-emptively (proportional to the actual re-render cost — plain controlled inputs, not
  expensive computed trees).
- **Asynchronous UX**: every mockup skeleton state maps to a real `isLoading`/`isPending`
  branch, never a fixed-duration fake — `DocFormGate`'s existing loading branch covers every
  JSON-doc section; Operate's 5 cards each render `Skeleton` rows while their own query is
  `isPending` (existing primitive, reused); the Fetching/Save flows use the existing `Saving…`
  inline-text pattern (`docForm.isSaving`, unchanged) for every section **except** Daemon
  Start (step 30), which gets its own named long-wait affordance per BE's F9 correction — the
  one deliberate divergence from the shared ≤400ms pattern, and it is named as such rather than
  silently reusing a pattern that doesn't fit its real latency.

---

## 9. Dispositions (2026-08-18 amendment, ruling `rulings/ui-gate-r1.md`)

Verdict: **BLOCKED → cleared by this amendment.** Every finding below is dispositioned by ID.
F3 is a user ruling, relayed and baked in, not re-litigated. Nothing in this amendment reworks
what the judge found already clear (contract fidelity, the 89-id completeness count, R20's
design, the Design-token correction) — see the header amendment note for that list.

| Finding | Severity | Disposition |
|---|---|---|
| **F1** | Blocker | **Amended.** New steps 9a–9d author `landing.model.ts`, `LandingCapsTable.tsx`, `LandingRulesSummary.tsx`, `LandingSection.tsx`, each with a colocated test; step 9d adds `ui/e2e/settings-landing.spec.ts` covering default/empty/loading/error states (ux-notes §12:477). Step 25's `SectionBody` switch and step 27's nav link count are corrected to wire `'landing'` in, closing "mounts nothing for the default route." §Requirements Coverage gained a Landing note. |
| **F2** | Blocker | **Amended.** Test count corrected 14→12 in §0 and NOTES/DELEGATION LOG (both prior misstatements). New **§e2e Disposition Ledger** gives all 12 `settings.spec.ts` tests and all 6 `hub.spec.ts` tests an explicit, individual disposition — no blanket clause remains. The 4 orphaned daemon-state tests (`settings.spec.ts:252,280,302,332`) are dispositioned REPLACE into `operate.spec.ts`, with new done-conditions (g)-(j) at step 30. `api-unreachable` is given a named owner (`DaemonCard.tsx`, step 30(i); `ScheduleSection.tsx`'s compact line as the secondary, step 18) — step 16 corrected to state this instead of "caller's concern." |
| **F3** | Major | **User-ruled, baked in, not re-litigated.** "Set up a new profile" is added to `SetupHealthCard.tsx` (step 35), navigating to the existing `'onboarding'` route (`router.ts:9`), mirroring `HubPage.tsx:125-127`'s exact prior behaviour. New done-condition (click navigates, wizard visible) + e2e Disposition Ledger entry (`hub.spec.ts` test 6 → SURVIVE, carried onto Operate). |
| **F4** | Major | **Amended.** Effect-asserting done-conditions added: `daemon-autostart` — step 30(e), both `AutostartOutcome` values (`ok`/`unsupported_platform`) now rendered under test; `daemon-pause-all` — step 30(f), asserts the fan-out mutation fires and the partial-failure line names the count/profiles; `linkedin-session-check` — step 34(c), asserts the POST fires and no optimistic flip occurs before it resolves; `discard-button` — step 5, asserts the draft actually reverts; `raw-key-badge-*` navigation — step 23, asserts `navigate()` fires to the owning section. |
| **F5** | Major | **Amended.** The proposed new `runResult.types.ts` is withdrawn. Steps 9a/9d instead import `getFunnelStages`/`getBiggestDrop`/`newMatchCount` from the existing `ui/src/features/runs/runResult.ts` unchanged, matching its own documented defensive-narrowing posture (quoted at point of use in step 9a's group intro and in §0's architecture list). No field was missing — every value Landing needs already exists on `FunnelStage`. |
| **F6** | Major | **Amended.** Step 9 rewritten: corrected that no daemon re-export line exists today (0 of 4 barrels was daemon) and that `app/features/daemon/index.ts` exports zero types (not "extending an existing one"). Cites the six exact identifiers blueprint-be §2/§11a now pins (`BreakerStatus`, `LinkedinSessionStatus`, `FilterPreviewResult`, `StopDaemonOutcome`, `StartDaemonOutcome`, `AutostartOutcome`, all in `src/ports/board.ts`, re-exported per-feature) and states the hard BE-side dependency plainly rather than as a "one-line addition." The BE bounce this finding required is already closed on the BE side (blueprint-be §11a) — nothing further owed there. |
| **F7** | Major | **Amended.** Empty-state done-conditions added: S2 (`WhereYouWorkSection.tsx`, step 11) and S4 (`RolesCompaniesSection.tsx`, step 13) both get "No rules — nothing is dropped for this reason" + inline `[Add]` (ux-notes §12:478,490), each with a new e2e case; S5 (`RawConfigSection.tsx`, step 23) gets "Not created yet — saving will create it" (§12:480) plus an e2e case proving the create-on-first-write path. `api-unreachable`'s first-class status is closed via F2's step-30 amendments. §8's blanket loading-state prose claim now has per-step done-conditions backing it: step 30(j) (Operate), every `DocFormGate`-wrapped section's existing `isLoading` branch, and — **corrected in round 2 (R2-F2), which caught that this citation was wrong at the time it was written** — step 9d(d)/(e), which now genuinely carry the loading- and error-independence cases (they did not when this row first cited "9d" as a whole). |
| **F8** | Minor | **Amended.** Step 35 now explicitly renders all three `health-group-{needs-action\|not-configured\|ok}` template ids (ux-notes §17:627), not just the mockup's one instantiated case, so QA pairs off the template rather than the render. |
| **F9** | Minor | **Amended, both parts.** A concrete file-split contingency is named at step 11: if `WhereYouWorkSection.tsx` exceeds ~350 lines, split into `WhereYouWorkRulesCard.tsx`/`WhereYouWorkPrefsCard.tsx` as siblings, matching this blueprint's own established sibling-file convention. Step 20 gained the unstated detail (ux-notes §7:325): the pacing ack checkbox clears on any preset switch away from Fast, with a new colocated test proving the clear, not just its absence when never checked. |
| **F10** | Cosmetic | **Amended.** `ScheduleSection.tsx`'s `-strong` citation corrected from `176,181,193,207,218` to `176,178,181,206,207,218` in §0. |

### Round 2 (2026-08-18, ruling `rulings/ui-gate-r2.md`)

Verdict: **CLEARS WITH CONDITIONS — all six round-1 conditions discharged, no further
re-gate.** Five new findings this round, folded in below; R2-F6 is a BE-side wording issue
outside this file's scope, routed to product-be and not touched here.

| Finding | Severity | Disposition |
|---|---|---|
| **R2-F1** | Load-bearing | **Amended.** Step 35 gained two clauses, (f) and (g): a stubbed `warn` finding (`'notion-db-reachable'`) is asserted to render **inside** `[data-qa="health-group-needs-action"]` (group membership, not mere presence), and clicking its destination is asserted to `navigate()` to `{name:'settings', section:'delivery'}` (the settings-link half step 28 had claimed but never asserted). |
| **R2-F2** | Load-bearing | **Amended.** Step 9d's case (b) is re-labelled as the empty-run case only — it no longer claims to close §12:477's failure-independence line, which an empty `[]` response does not test. Two new cases, (d) loading and (e) error, were added: (d) holds `GET .../runs` open and asserts `landing-caps-table` skeletons while `landing-rules-summary` renders (it depends only on already-resolved config queries); (e) fails `GET .../runs` and asserts `landing-thin-run` shows a block-scoped error+retry while `landing-caps-table` (values only, binding badges degrade to `—`) and `landing-rules-summary` still render. The F7 disposition row above is corrected to cite 9d(d)/(e) specifically rather than "9d" generally, which was true at round 1 (no loading/error case existed yet) and is no longer true now. |
| **R2-F3** | Cosmetic | **Amended.** Step 19's citation of `PacingPresetCard.tsx` as "step 21" corrected to "step 20" (step 21 is `DeliverySection`). |
| **R2-F4** | Cosmetic | **Amended.** `runResult.ts`'s line count corrected 183→109 in all three citing locations (§0's architecture list, step 9a-intro's reuse-discipline note, NOTES/DELEGATION LOG) — `wc -l` confirms 109; the 183 figure traced back to `ui-gate-r1.md` itself, which the round-2 ruling overrules on this one fact. No substantive claim about the file's exports or behaviour was affected. |
| **R2-F5** | Cosmetic | **Amended, with a call made, not just a correction.** Step 9d's "inline `ErrorRetry`" language is corrected — `ErrorRetry` is not a shared component, it is a local, unexported function defined separately in `TriagePage.tsx:37` and `RunsPage.tsx:79`. **Call: consolidate, don't triplicate**, per this blueprint's own `ChipInput` reuse-first rationale. Step 9d gained new work: extract `ui/src/features/shared/ErrorRetry.tsx` from the two existing definitions, repoint both existing call sites at it, and have `LandingSection.tsx` import the same component as its third consumer — not a third local copy. |

**R2-F6 — not amended here, by design.** `blueprint-be.md §11a`'s "`FilterPreviewResult` …
already there, unchanged" wording is misleading (the type does not exist in `ports/board.ts`
today; BE's own step 31 authors it) — but UI step 9 imports it from the `preview` feature
barrel, never from `ports/board.ts` directly, so nothing in this file is affected either way.
Per the dispatch's explicit instruction, this is routed to product-be as a wording fix, not
actioned in `blueprint.md`.

**Not mine, already closed on the other side**: F6's BE-side half (blueprint-be §2/§11a
already pins the six identifiers — confirmed by direct re-read this amendment, not assumed).

**Disputes**: none. Every finding's evidence was independently reproducible on re-read
(`grep -c "test(" ui/e2e/settings.spec.ts` → 12; `ls src/app/features/` → no `linkedin`/
`preview`; `cat ui/src/lib/api/types.ts` → 4 blocks, no daemon; `ui/src/features/runs/
runResult.ts` → the cited exports, present and unchanged; `wc -l runResult.ts` → 109;
`grep -rn "function ErrorRetry" ui/src` → two local, unexported definitions) — nothing here is
contested back to
the judge.

---

## NOTES

**Judgment calls made (local, recorded per the charter):**

- **Verified data-qa count is 89, not the 87 stated in the dispatch.** Recount via `grep -o
  'data-qa="[^"]*"' mockup.html | sort -u | wc -l`. All 89 are mapped in §1; the discrepancy is
  surfaced here rather than silently reconciled to either number.
- **`settings-shell`'s scope narrowed to the settings-specific region**, excluding the global
  app sidebar the mockup renders for visual context (that sidebar is `Sidebar.tsx`, already
  shipped, edited in step 2 only for label/icon — not re-specified as a new component).
- **File-split strategy**: sibling files at the same directory level (matching blueprint-be's
  own F8 precedent — `board_daemon.ts`/`board_linkedin.ts` as siblings of `board.ts`, not
  nested subfolders), not the `core/`-style subfolder-with-`index.ts` pattern — because the
  existing `ui/src/features/*/sections/` folders are already flat, multi-file, and have no
  `index.ts` convention today; matching the *existing UI convention* takes precedence over
  importing a `core/`-side pattern that isn't how `ui/` is actually organized.
- **The soft-severity conflict-notice copy (S2, step 11)** is new — ux-notes §6 designed only
  the hard-severity copy; blueprint-be §0(a)/F3 explicitly flagged this as a UX gap the BE
  blueprint surfaces but doesn't close. I've written a minimal, factually accurate placeholder
  copy in step 11 rather than bouncing this to UX, since the *mechanism* (branch on severity,
  render something) is unambiguous from the spec/BE contract and the exact wording is a copy
  nicety, not a design decision — but flagging here so a reviewer can swap the copy without
  re-opening the mechanism.
- **R26 (search) is not promoted.** Per ux-notes' own handoff note, promotion is conditional on
  a re-run of the §9 navigation test against the new IA scoring below 4/5 — no such test has
  been run at this pipeline stage. **Recommendation, not a build**: if/when that re-test runs
  and scores below 4/5, promote R26 to a Must-equivalent follow-up; until then it stays Could
  and is cut per spec §12's own tail-item framing.
- **`RulePreviewStrip`'s trigger event (debounce vs. blur)** is the one place a UI micro-timing
  decision is left to the implementer (§Risks) — the mockup/ux-notes specify only the strip's
  rendered states, not what fires the request.
- **GREENFIELD mode does not apply** — this is 100% an existing-repo change; reuse-first was
  never suspended.

**DELEGATION LOG:**

- executor-fast — "UI stack breadth recon: shadcn primitives + deps" (components.json,
  package.json dependency versions, a repo-wide existence scan for RadioGroup/Checkbox/Alert/
  Table/Collapsible/Tooltip/DropdownMenu/Label/chip-input candidates, the shadcn add-command
  convention, the file-size gate's exact thresholds+scope+citation, `form.tsx`/`button.tsx`/
  `badge.tsx`'s exported names/variants only) — returned a capped, table-shaped report (no file
  dumps); used verbatim for §0's component-gap table and the file-size gate citation. This is
  the one delegated dispatch; every design decision built on top of its findings (which
  primitive to add, which pattern to reuse) was made by me, not the subagent.
- **Read first-hand, not delegated** (the files this blueprint's mapping and implementation
  steps actually hinge on): `ui/src/lib/router.ts` (full), `ui/src/features/settings/
  SettingsPage.tsx` (full), `config.queries.ts`/`config.api.ts`/`useDocForm.ts`/
  `useConfigMutation.ts`/`DocFormGate.tsx`/`JsonEscapeHatch.tsx` (full, every settings shared
  seam), `sections/FiltersSection.tsx`/`ProfileSection.tsx`/`ScheduleSection.tsx`/
  `ResumeSection.tsx`/`SearchUrlsSection.tsx`/`DangerZone.tsx`/`filters.model.ts` (full, every
  existing section this blueprint redistributes), `hub/hub.model.ts`/`HubPage.tsx`/
  `hub.api.ts`/`hub.queries.ts` (full, the page this blueprint replaces), `shell/Sidebar.tsx`
  (full), `wizard/wizard.types.ts`/`wizard.api.ts`/`wizard.queries.ts` (full — `DaemonStatus`'s
  real shape, the `RunIntentOutcome` typed-outcome precedent this blueprint's R20 handling
  copies), `lib/api/client.ts`/`lib/api/types.ts` (full), `components/ui/{accordion,switch,
  select,dialog,card}.tsx` (full, prop/slot shapes), `ui/src/index.css` (full — the Design
  Scale correction in §0), `ui/e2e/settings.spec.ts` (full, **12 tests** — corrected count,
  UI-gate F2; the state-pinning idiom this blueprint's e2e steps follow verbatim),
  `ui/e2e/hub.spec.ts` (**full, all 6 tests — corrected this amendment; the original pass read
  only the first 80 lines and missed 4 tests, which is exactly how F2/F3 happened**),
  `ui/src/features/runs/runResult.ts` (full, 109 lines — corrected this pass, R2-F4; added
  this amendment, UI-gate F5: the existing module Landing's new steps reuse instead of
  duplicating), mockup.html (full,
  814 lines — every data-qa id and its exact surrounding markup), ux-notes.md (full, 651
  lines), spec.md (full, 879 lines), blueprint-be.md (full, 1229 lines, re-read this amendment
  for its §2/§11a identifier pins), personas.md (full), `.state.md` (full),
  `rulings/ui-gate-r1.md` (full, this amendment's own input).

**One thing this blueprint deliberately did not do**: invent a data need, endpoint, or
requirement not traced to blueprint-be §2 or a spec requirement. The one flagged exception
(the "resume not parsed" doctor check, §Risks) is named as a possible gap, not silently wired
against an assumed check name.
