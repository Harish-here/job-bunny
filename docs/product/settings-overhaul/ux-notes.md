# UX Notes — Settings & Control Surface Overhaul

Slug: `settings-overhaul` · Author: product-ux · 2026-08-17
Spec: `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/spec.md` (authoritative)
Persona: `/Users/harishamutha/Job-bunny/docs/product/personas.md` v1.3 — P1 "The Operator-Owner", **tuner hat**, JTBD-4
Prior art not to contradict: `/Users/harishamutha/Job-bunny/docs/product/run-experience-overhaul/ux-notes.md`
Mockup: `/Users/harishamutha/Job-bunny/docs/product/settings-overhaul/mockup.html`

---

## 0. Design frame

Everything sits inside the existing shell: sidebar `w-56` (triage / tracker / runs / analytics /
**setup** / **settings**), Run Now block at `mt-auto`, profile switcher beneath it. Inherited and
preserved: light theme default, `--radius: 1rem`, `ring-1 ring-foreground/10` on cards,
`text-lg font-semibold font-heading` page titles, lucide at `size-4`, **urgency = visual weight, not
hue**, no charting dependency, sonner toasts.

The epic's own evidence sets the design's centre of gravity: the §9 navigation test scored **1/5**,
and the one *confidently wrong* answer was about a setting the user had named as his own friction.
That is not a "where is it" problem I can solve with better labels alone — a user who is confident
and wrong will not read the nav. **So the design's primary answer is not a better taxonomy; it is a
landing screen that shows every decisive value at once, with the taxonomy underneath it as the way
back.** The IA restructure (R1) is necessary and it is not sufficient.

---

## 1. THE DECISION FOR THE USER — the Hub-vs-Settings boundary (spec §7.5)

**My recommendation: Option C+D, executed as a rename.** `#/setup` stops being "Setup & Health" and
becomes **Operate** — machine-scoped status, machine-scoped control, and the setup-completeness
checklist. `#/settings` becomes **Settings** — per-profile configuration, organised by intent.

**The seam, in one sentence: _Operate acts on the machine; Settings authors what the machine should
do for this profile._**

Why this and not the others — and the one thing that made it work:

- **C's known flaw is dissolvable.** The spec's objection to C is that it "puts the daemon on a
  different page from the schedule that drives it." That is only true if *schedule* is one thing. It
  is two: the **times** (`profile.json.schedule`, per-profile, authored) and the **execution** (the
  daemon honouring them, machine-wide, operated). Operate shows a per-profile *Scheduled runs* list
  with `[Skip next]` and a pause toggle per row — Radarr's per-task-row idiom, the one sourced
  precedent in §3 for this exact surface. Settings owns editing the times. Nothing is duplicated and
  P-b's pain lands entirely on Operate.
- **B's sentence comes free.** "Health vs. configuration" is the sentence C produces anyway, because
  in this system the machine-scoped things *are* the health/control things and the profile-scoped
  things *are* the config things. B leaks at the seams (schedule, secrets, breaker); C decides those
  seams mechanically — the daemon is one process for all profiles → Operate; `.env` lives in the data
  home → Operate; the breaker file is scoped to the shared Chrome profile → Operate; pacing lives in
  `profile.json.settings` → Settings. **C is the rule, B is the slogan.** (Callout C1.)
- **D is absorbed, not chosen against.** The completeness checklist is a *card on Operate*, not a
  page — and it merges with the doctor card rather than sitting beside it (§6, C11).
- **R3 gets its strongest possible expression.** Scope becomes a *place*, reinforced by a label. If
  everything merged (A), R3 degrades to labels only — which is exactly usability concern (e), and
  labels are the weaker instrument for a user who just scored 1/5 on recall.

### The realistic alternatives, and what rides on each

| If the user rules… | You get | You pay |
|---|---|---|
| **C+D (recommended)** — Operate + Settings | Scope split expressed structurally (R3); `#/setup` route and its e2e survive; ops has a real home; no topic owned twice | One rename to explain; the completeness card is a deliberate scope exception (per-profile content on a machine page — labelled, §6) |
| **A — Merge into one Settings page** | Fewest nav decisions (Hick's); G14 dies outright; simplest mental model | `#/setup` and its e2e coverage die; R3 survives only as labels; the page becomes ~17 sections, past the point where one nav column is scannable; ops controls sit inside a config surface, blurring the write-surface boundary the spec is already spending |
| **B — Health vs configuration, keep both names** | Smallest diff from today; no rename | The seams the user actually cares about (schedule, secrets, breaker) leak, and the reconciling line of copy that §5.1 identifies as the current defect comes straight back |
| **C+D but keep the name "Setup & Health"** | Zero rename cost | The page's dominant content becomes daemon/session/breaker status and control, which "Setup" does not describe; the label would under-sell the epic's most-evidenced win (P-b) |

**Cost of the recommendation if the user says no:** low. The section inventory in §2 is
boundary-independent — under A it becomes one nav column with a divider instead of two routes.
Nothing below §2 changes except which page hosts §6's cards.

**Route note:** I recommend keeping the route string `#/setup` under the label "Operate" so the
existing e2e selectors survive, and letting product-ui decide whether to add an `#/operate` alias.
Route strings are not user-facing enough here to buy a breaking change.

---

## 2. Information architecture

**Operate** (`#/setup`, label "Operate") — scope badge in header: **This machine · all profiles**.
Not a nav; one scrolling column of cards, because it is glanceable status, not a place you navigate.

**Settings** (`#/settings/:section`) — scope chip in header: **Profile: harish**. Left nav column
(`w-56`, sourced: sidebar-not-tabs past many hierarchical sections), content scrolls. Twelve sections
in **four labelled groups** — Miller: no group exceeds five.

| Group | Section | Owns | Reqs |
|---|---|---|---|
| **Aim** | **What decides your board** | landing summary — every decisive value at once | R6, R14, G2 |
| | **Roles & companies** | title rules (drop) · domain keywords + seniority targets (rank) · companies avoid list | R7, R8, R15 |
| | **Where you'll work** | locations/work-types/timezones (drop) · home cities + acceptable/borderline timezones + work-type preference (rank) | **R2**, R7, R8 |
| | **Skills** | core skills, minMatch, severity | R8 |
| | **About you** | resume-derived facts: YoE, target seniority, core/secondary skills, preferred work type, location, domain experience | — |
| **Runs** | **Where jobs come from** | lanes on/off · search URLs | — |
| | **Schedule** | run times, weekdays, grace, enabled + a read-only daemon line linking to Operate | R16 (bridge) |
| | **Fetching** | caps (how much) · pacing presets (how fast) | R6, R12, R13 |
| **Output** | **Delivery** | connector read-only · Notion mirror/dryRun · Telegram notifier | R9, R11 |
| | **Housekeeping** | cleanup TTLs, routines | R10 |
| **Advanced** | **Raw config** | one consolidated editor over all four docs | R4 |
| | **Danger zone** | profile removal, type-to-confirm | R25 |

**No section is named after a file** (R1). Three deliberate renames worth naming: *Filters* →
split across **Roles & companies** / **Where you'll work** / **Skills** by intent; *Resume* →
**About you** (the concept, not the document); *Profile* → dissolved entirely, its four concerns
redistributed to **Where jobs come from** (lanes), **Housekeeping** (routines), **Delivery**
(connector, notifiers).

**The repeated internal idiom, and it is the design's spine.** Every Aim section is two cards in the
same order with the same two headings:

> **Rules — a job that fails these is dropped** (`filter.json`)
> **Preferences — these change the order, never drop anything** (`profile.json` → `settings.rank`)

Learn it once, apply it in three places (Roles, Where you'll work, Skills). This is what makes R2
answerable without either collapsing two semantics into a lie or exposing the file split. (C2.)

---

## 3. Design Scale — every value in the mockup comes from this table

Recon'd from `ui/src/index.css`, `ui/src/components/ui/*`, `ui/src/features/settings/*`, then
**verified first-hand line-by-line** by product-ux against `ui/src/index.css` (`:root` + `.dark` +
the `@theme inline` radius derivations), `ui/src/components/ui/card.tsx` and
`ui/src/components/ui/button.tsx`. Light theme is default; dark values recorded for completeness,
the mockup renders light only.

### Colour

| Token | Utility | Literal (light) | Literal (dark) | Used for |
|---|---|---|---|---|
| `--background` | `bg-background` | `#faf8fd` | `#1a1523` | page |
| `--foreground` | `text-foreground` | `#3d2c55` | `#e6ddf5` | body text |
| `--card` | `bg-card` | `#ffffff` | `#241d30` | cards |
| `--muted` | `bg-muted` | `#f1ecf8` | `#2e2540` | inputs, tab rail, skeleton |
| `--muted-foreground` | `text-muted-foreground` | `#6e5b87` | `#a695c2` | helper text, meta |
| `--accent` | `bg-accent` | `#efe8fa` | `#342a47` | selected row |
| `--border` / `--input` | `border-border` | `#e4dbf0` | `#362c4a` | 1px rules, input border |
| `--primary` | `bg-primary` | `#7b5ea7` | `#b79ce0` | primary action, focus ring |
| `--primary-foreground` | — | `#ffffff` | `#1a1523` | text on primary |
| `--success` | `text-success` | `#4caf6e` | `#6fcb8e` | signed-in, check passing |
| `--attention` | `text-attention` | `#ff8a3d` | `#ff9e5e` | breaker open, degraded daemon |
| `--amber` | `text-amber` | `#c98a2e` | `#e1a856` | secondary warning, "unknown" |
| `--destructive` | `text-destructive` | `#d64545` | `#f08a8a` | validation error, danger zone |
| `--sidebar` | `bg-sidebar` | `#f3eefb` | `#201a2c` | sidebar + Settings nav column |
| `--sidebar-accent` | — | `#e7def7` | `#2e2540` | nav hover / active |

### Spacing (Tailwind default grid, 1 = 4px — the repo declares no custom scale)

| Utility | Literal | Used for |
|---|---|---|
| `gap-1` / `p-1` | 4px | icon+text, nav item gaps |
| `gap-1.5` / `p-1.5` | 6px | button internals, field label→control |
| `gap-2` / `p-2` | 8px | chip rows, tab triggers |
| `p-2.5` | 10px | input/select/popover padding |
| `gap-3` / `p-3` | 12px | card-sm padding, sidebar padding, section separation |
| `gap-4` / `p-4` | 16px | **card default padding**, form field stacks |
| `p-5` | 20px | dialog content |
| `p-6` | 24px | page container padding |
| `gap-6` | 24px | major layout columns |

### Type

| Utility | Literal | Weight | Family | Labels |
|---|---|---|---|---|
| `text-[10px] uppercase tracking-wide` | 10px | 500 | sans | nav group labels, scope badges |
| `text-xs` | 12px | 400/500 | sans (`font-mono` for values) | helper text, meta, badges |
| `text-sm` | 14px | 400/500 | sans | body, inputs, card body |
| `text-base leading-snug font-medium font-heading` | 16px / 1.375 | 500 | **heading** | card titles (verified `card.tsx:41`) |
| `text-lg font-semibold font-heading` | 18px | 600 | heading | page title |
| `text-2xl font-heading` | 24px | 600 | heading | the one hero number per screen |

Families: `--font-sans` = "Geist Variable"; `--font-heading` = "Nunito Variable" (rounded).
**Documented mockup exception:** the mockup must make zero external requests, so it substitutes
`system-ui, -apple-system, "Segoe UI", sans-serif` for sans and `ui-rounded, system-ui, sans-serif`
for heading. Sizes, weights and every other value are unchanged.

### Radii, borders, elevation

| Token / utility | Literal | Used for |
|---|---|---|
| `--radius` | **16px** (`1rem`) | base; every other radius derives from it |
| `--radius-sm` = `calc(--radius * 0.6)` | **9.6px** | small controls |
| `--radius-md` = `calc(--radius * 0.8)` | **12.8px** | `button size=sm` |
| `--radius-lg` = `--radius` → `rounded-lg` | **16px** | button default, input, select, tabs list |
| `--radius-xl` = `calc(--radius * 1.4)` → `rounded-xl` | **22.4px** | **cards** and dialogs (verified: `card.tsx:15` uses `rounded-xl`) |
| `rounded-full` | 9999px | badges, switch, status dots |
| border / ring | 1px; `ring-1 ring-foreground/10` on cards | dividers, card edge |
| focus | `ring-3 ring-ring/50` = 3px `#7b5ea7` @ 50% | `:focus-visible` only |
| shadow | **cards carry NO shadow** — the `ring-1` is the only edge · `shadow-lg` on dialogs, popovers and the sticky save bar | elevation |

### Component idioms (reproduce these exactly)

| Component | Geometry |
|---|---|
| Button base | `rounded-lg` 16px, `1px solid transparent`, `text-sm` 14px weight 500, focus `ring-3 ring-ring/50` + `border-ring`, `active:translate-y-px`, svg `size-4` |
| Button default | `h-8` 32px, `px-2.5` 10px, `gap-1.5` 6px |
| Button sm | `h-7` 28px, `px-2.5` 10px, `gap-1` 4px, `text-[0.8rem]` 12.8px, radius `min(12.8px, 12px)` = **12px**, svg `size-3.5` 14px |
| Button xs | `h-6` 24px, `px-2` 8px, `text-xs`, radius **10px**, svg `size-3` 12px |
| Button icon / icon-sm | `size-8` 32×32 `rounded-lg` / `size-7` 28×28 radius 12px |
| Variant `default` | `bg-primary` `#7b5ea7`, `text-primary-foreground` `#fff`, hover `primary/80` |
| Variant `outline` | `border-border` `#e4dbf0`, `bg-background`, hover `bg-muted` |
| Variant `ghost` | transparent, hover `bg-muted` |
| Variant `destructive` | **tinted, not solid**: `bg-destructive/10`, `text-destructive` `#d64545`, hover `destructive/20` — use for the danger-zone action |
| Card | `bg-card`, **`rounded-xl` 22.4px**, `ring-1 rgba(61,44,85,.10)`, `text-sm`, `--card-spacing: 16px` → `py-4` + children `px-4`, `gap-4`, `overflow-hidden` |
| Card sm | same, `--card-spacing: 12px` → `py-3` / `px-3`, `gap-3`; title drops to `text-sm` |
| Card title / description | `font-heading text-base leading-snug font-medium` / `text-sm text-muted-foreground` |
| Input | `h-8` 32px, `px-2.5` 10px, `text-sm`, `rounded-lg`, `1px solid var(--input)` |
| Select trigger | `h-8`, `px-2.5`, `text-sm`, `rounded-lg` |
| Badge | `h-5` 20px, `px-2` 8px, `text-xs`, `rounded-full`, `gap-1` |
| Switch | `h-5` 20px × `w-9` 36px, thumb 16px, checked `bg-primary` |
| Tabs list / trigger | list `h-8` `bg-muted` `p-0.5` `rounded-lg` · trigger `h-7` `px-2` active `bg-card` |
| Skeleton | `bg-muted` `rounded-md` `animate-pulse` |
| Sidebar | `w-56` 224px, `p-3`, nav item `h-8`, `gap-1`; active `bg-sidebar-accent` |
| Main | `flex-1`, `p-6` 24px |

**Rule for the render: any value not in this table is a defect.** The only listed exceptions are the
two font-family substitutions above.

---

## 4. Screen inventory

| # | Screen | Serves |
|---|---|---|
| S1 | Settings — **What decides your board** (landing) | CP #1, #2; G2 |
| S2 | Settings — **Where you'll work** | **R2** acceptance case; G6 |
| S3 | Settings — **Fetching** (caps + pacing) | R6, R12, R13; P-c |
| S4 | Settings — **Roles & companies** (+ R15 preview) | R7, R8, R15 |
| S5 | Settings — **Raw config** | R4 |
| S6 | **Operate** — healthy | CP #5–#8, #12 |
| S7 | **Operate** — degraded (daemon stopped · signed out · breaker open · checks failing) | G3, G9; P-b |
| S8 | Save model — dirty bar, submit error, success | R5, R13, R14 |
| S9 | Danger zone | R25 |
| S10 | Five-state matrix | states coverage |

---

## 5. S1 — "What decides your board" (the landing)

**This screen is the design's answer to the 1/5 test.** Instead of asking the user to recall a
location, it renders every decisive value on one screen with a link beside each. Content Priority #1
and #2 are answered at **zero clicks after arriving**.

Layout, top to bottom inside `p-6`:

1. **Page header** `h-12` — `Settings` `text-lg font-semibold font-heading`, left; right: scope chip
   `Profile: harish` (`badge`, `bg-muted`) and the search field (R26, **Could** — cut cleanly, the
   header reflows).
2. **The thin-run line** — one card, and **the single visually distinct element on this screen**
   (Von Restorff). Reads: *"Your last run put **4** jobs on the board. 214 were scraped; `filter`
   dropped 189 — biggest rule: `locations`."* The `4` at `text-2xl font-heading`. Two quiet links:
   `Review that rule →` (deep-links S2's rule card) and `See the run →`. If no run exists, the card
   is replaced by a one-line muted "No run recorded yet" — never a zero.
3. **Limits in force** — a four-row table (`in → cap` idiom borrowed from the runs funnel, same
   `border-b text-xs` header, `td py-1.5`): `maxNewPerLane 40`, `maxProbesPerRun 25`,
   `maxCardsPerUrl 40`, `maxAgeDays 30`. Each row carries a **binding** marker when the last run hit
   it — *"hit this cap on 2 of 3 lanes"* — which is the literal answer to P-c. Row-level `Change →`.
4. **Rules in force** — three rows (Roles · Where you'll work · Skills), each `n active rules, m of
   them hard`, each linking to its section.
5. **Scope footer** — one muted line: *"Daemon, LinkedIn session and secrets are machine-wide —
   see Operate →."* This is R3's cross-page reinforcement and it is the only place Settings mentions
   machine scope.

**Efficiency justification for adding a screen.** It costs one click on the way to any section, and
it removes the "which section?" decision (Hick's) plus, for the dominant entry point, removes the
navigation entirely. The user who arrives thinking "why was my run thin" leaves with the answer
without choosing a section. Net negative clicks on the evidenced journey. (C3.)

---

## 6. S2 — "Where you'll work" (R2, the hero screen)

Two cards, the §2 idiom, in fixed order:

**Card A — "Rules — a job that fails these is dropped."** Subtitle `text-xs text-muted-foreground`:
*"Applied during `filter`. A dropped job never reaches your board."* Contains: cities/countries chip
input, work-types checkboxes, **timezones** chip input, severity (hard/soft) select per block.

**Connective line between the cards**, `text-sm`, full width, not a callout box:
> *"The same timezone can appear in both. As a rule it decides **whether** a job reaches you. As a
> preference it decides **where in the list** it lands."*

**Card B — "Preferences — these change the order, never drop anything."** Subtitle: *"Applied during
`rank`. Nothing here can remove a job."* Contains: home cities, **acceptable timezones**, **borderline
timezones**, work-type preference. A muted footer line: *"Point weights for these live in Raw config
→"* (R8's boundary, stated where the user would look for it rather than left silent).

**The cross-document conflict notice — the payoff, and the one thing only an intent IA can do.**
When a timezone appears in Card B's *acceptable* list but is excluded by Card A's rule, an inline
notice renders between the cards (`bg-attention/10`, `border-l-2 border-attention`, `p-3`,
`rounded-lg`, `text-sm`):

> *"`Asia/Kolkata` is ranked as acceptable, but your rule drops remote roles outside the allowed
> timezones — so no job from it can reach the board. Add it to the rule, or remove it from the
> preference."* — with `[Add to rule]` and `[Remove from preference]` as the two actions.

When the notice is present it becomes the screen's one distinct element and the save button steps
back to `outline`. **This is the requirement's real payoff:** the user got one of these two questions
right and one blank in the §9 test — the surface now holds the relationship he does not. It is also
the strongest single argument for the epic. (C4.)

> **Verification handoff:** `src/core/filter/rules/timezone.ts` gates *remote* roles specifically.
> The notice copy must be conditioned on that, not stated as a blanket drop. Flagged for BE — if the
> condition cannot be evaluated cheaply, the notice degrades to the connective line alone and
> nothing else changes.

---

## 7. S3 — "Fetching" (R6 caps, R12 pacing, R13 validation)

Two cards under one page header: **"How much each run pulls"** and **"How fast it pulls"**.

**How much (R6).** Four number fields, each with the effect stated *beside the number, not in a doc*
— the spec's tech story is explicit about this. `maxNewPerLane` → *"At most 40 new jobs from each
lane per run. Your last run hit this on linkedin and greenhouse."* Bounds are shown as helper text
(`1–500`) and enforced at save. The "hit this cap" clause is the P-c payoff and renders only when
true.

**How fast (R12, Should).** A three-card radio group, not a select — the choice needs its
consequences visible simultaneously (Hick's is served by *three* options, not by hiding them):

| Preset | Shows | Treatment |
|---|---|---|
| **Safe** | `8–18s` between pages · `35–70s` between searches · *"~40% slower runs"* | plain |
| **Normal** *(current)* | `5–12s` · `20–45s` · *"the shipped default"* | selected: `ring-2 ring-primary` |
| **Fast** | `2–5s` · `8–15s` | `border-l-2 border-attention`, and the warning lives **inside this card**: *"Faster than LinkedIn tolerates. A soft-block stops all LinkedIn scraping for 4 hours; repeat blocks risk the account."* Selecting it reveals one checkbox — *"I understand this risks a soft-block"* — inside the same card. Unchecking or switching preset clears it. |

**Concern (d) resolved:** the warning is attached to the dangerous *choice*, not to the page. A
page-level banner is seen on every visit including the 95% where nothing risky is happening, and is
therefore learned-past by exactly the third visit. A warning that appears only when the user reaches
for the dangerous option cannot be banner-blind, because it has no steady state. (C5.)
**Honest flag:** this is transferred reasoning — spec §16 weakness 4 records that no in-domain source
exists for scraper-pacing UI. Treat as hypothesis.

**Advanced disclosure** (`<button aria-expanded>`, `text-sm`, muted, collapsed by default) reveals the
four raw ms fields. Editing any of them switches the preset group to a fourth, unstyled state:
**Custom**. This is R13's demo case: entering `jitterMinMs 15000` with `jitterMaxMs 12000` and hitting
Save produces the S8 error treatment. **The save button is never disabled** (GOV.UK, sourced).

---

## 8. S4 — "Roles & companies" and the R15 preview

Three cards: **Rules** (title match/reject chips, severity) · **Preferences** (domain keywords,
seniority targets) · **Companies to avoid** (chip list, `filter.json.companies`).

**R15 preview (Should, conditional on the BE spike).** A passive strip that appears *after* an edit,
between the rule list and the save bar, `bg-muted`, `p-3`, `rounded-lg`, `text-sm`:

> *"Against your last run (214 jobs): this rule set would drop **201** — 12 more than the current one."*
> `[see which 12 →]` opens a disclosure listing titles + companies.

Three states it must have and the design degrades through all of them without a layout hole:
**(a) spike passed, data present** — as above; **(b) no recent run** — *"No recent run to preview
against."*; **(c) spike failed / R15 cut** — the strip never mounts, and because it sits between two
stacked cards, its absence collapses cleanly with no gap. Nothing else on the screen references it.
(C6.)

---

## 9. S5 — "Raw config" (R4), and how it stays reachable but not attractive

Concern (c) resolved by **making the raw editor point back at the forms.**

Two-pane, `gap-6`: left a doc list (`profile.json` · `filter.json` · `resume.json` ·
`search_urls.md`), right a plain monospace `textarea` (`font-mono text-sm`, `bg-muted`, `rounded-lg`,
`p-3`) — no syntax-highlighting dependency, consistent with the no-new-deps constraint.

Two things make it honest rather than a giveaway:

1. **A banner at the top naming exactly what has no form**: *"Only these have no form: ranking point
   weights and denominators, registry health thresholds, adapter settings. Everything else on this
   page has one."* The escape hatch declares its own legitimate scope, which is the opposite of an
   IA that gave up.
2. **Per-key routing.** Each top-level key in the doc list carries a badge: `has a form` (with a
   `→` that navigates to the owning section) or `raw only`. The user who lands here for something a
   form covers is *sent back*. (C7.)

Discoverability is deliberately asymmetric: nav group **Advanced**, muted label, no icon accent, last
but one. It is one click from anywhere and attractive from nowhere.

**One source of truth (R4):** both panes are the same `config_docs` document over the same
`PUT /api/profiles/:name/config/:doc`. Editing raw and reopening a form shows the new value with no
reload (AC 4). Save-time validation (R13) applies identically here; a JSON parse error renders in the
same S8 error summary, not as a toast.

---

## 10. S6 / S7 — Operate

Header: `Operate` `text-lg font-semibold font-heading` + scope badge **This machine · all profiles**.
No profile switcher is disabled — the sidebar switcher stays live because two cards show per-profile
rows; the machine-wide cards carry an `All profiles` badge instead. That satisfies AC 3 (switching
profile visibly changes no machine-scoped value) without creating a dead control.

Five cards, ordered by Content Priority Moment 2:

| # | Card | Contents | Reqs |
|---|---|---|---|
| 1 | **Daemon** | state (the six existing states: loading / api-unreachable / degraded `schema vN > build vM` / stopped / stale "Wedged" / running), last tick `12s ago` `font-mono`, pid, uptime. Controls: `[Stop]` / `[Start]`, `[Pause all]` / `[Resume all]`, autostart switch | R16, R19, R20 |
| 2 | **Scheduled runs** | one row per profile: profile · next run · `[Skip next]` · pause switch. Active profile row `bg-accent`. Footer link `Edit times in Settings →` | R16, R19 |
| 3 | **LinkedIn** | two rows, both badged `All profiles`: **Session** — signed in / signed out / unknown + `checked 4m ago` + `[Check now]`; **Throttle breaker** — closed / open until `21:40` + *"stops LinkedIn scraping for all profiles"*. **No reset control.** | R17, R18 |
| 4 | **Setup & health** | the doctor projection, grouped `Needs action` / `Not configured` / `OK (11)` collapsed. Each row: check · one-line detail · destination | R21, R22, R23 |
| 5 | **Secrets** | `NOTION_TOKEN` / `TELEGRAM_BOT_TOKEN` → `configured` / `not configured`, `[Set]` write-only. Badged `All profiles`. Value never rendered | R24 |

**Two merges, both Occam cuts, both worth defending:**

- **Session and breaker share one card (C8).** They are the two silent-outage gaps (G3, G9) and they
  produce the *identical* symptom — a run that comes back calm and empty, which is precisely the
  state the previous epic taught the board to render calmly. Seeing one without the other is
  misleading, so they are never separated.
- **Doctor and the completeness checklist are one card (C11).** The Hub is already mechanically a
  doctor-check projection (`hub.model.ts:85`). Shipping R21 and R22 as two cards would render the
  same 13–14 checks twice under two headings. One card, three groups, and every row carries a
  **destination**: a link into the owning Settings section where one exists, or a named CLI/slash
  command where the step is Claude-dependent (R23) — `/setup harish` for Notion adopt-or-create,
  `jobbunny setup` for the PDF resume parse, each with `[Copy]`. The board never performs them.
  When everything passes, the card collapses to one line — *"Setup complete · 14/14 checks passing"* —
  expandable. A permanent all-green checklist is an element that says nothing.

**R20's deferred mechanism, designed both ways.** The Daemon card's `[Start]` renders in two
variants and the mockup shows both: **(a) mechanism exists** — a real button, with a `Doherty` state
(`Starting…`, ≤400ms acknowledgement, then polling); **(b) BE gate ruled it out** — the button is
*replaced*, not disabled, by one line plus a copy control: *"The daemon must be started from a
terminal."* `[Copy: jobbunny serve start]`. Variant (b) is exactly today's behaviour, elevated from
hint text to a labelled control, and satisfies AC 18's second branch. Never a disabled button —
users read disabled as system status (GOV.UK). (C9.)

**S7, degraded.** Inherited rule from the previous epic, applied here: **urgency is weight, not hue.**
Healthy cards carry no border accent, no tint, no badge. A card in trouble gets a 2px left border and
a tint. On a page where three things are wrong at once, **only the worst one takes the accent** and
the rest render as plain rows with their status word — otherwise the page becomes a wall of alarm and
the ranking the operator needs is destroyed. Order of severity: daemon down > session signed out >
breaker open > check failing. (C10.)

**R17's probe never fires on page load.** The card shows the last *cached* result with its age, and
`[Check now]` is the only thing that probes. This is a design consequence of the spec's own blast-radius
note — a probe drives a browser and must not perturb the one-Chrome invariant on a route change. A
probe timeout renders **unknown** (amber), never *signed out*: a false "signed out" trains the user
to ignore the one signal that most silently invalidates everything. (C12.)

---

## 11. S8 — the save model (R5, R13, R14)

One model, identical in all eleven editable sections. Memorability over local optimisation.

- **Dirty state.** The moment any field changes, a **sticky save bar** appears pinned to the bottom of
  the content column (`bg-card`, `ring-1`, `p-3`, `rounded-xl`, `shadow-lg`): left *"3 unsaved
  changes"*, right `[Discard]` `[Save changes]`. Fitts: the primary action is large and travels with
  the user down a long form instead of sitting at a bottom they must scroll to.
- **Navigation guard (R5).** Switching section or profile while dirty opens a small dialog —
  `Save and continue` / `Discard changes` / `Stay here`. A dialog is proportionate here because the
  loss is *irreversible* (R25's blast-radius principle), which is also why the previous epic's
  no-confirm-on-reversible rule is not contradicted.
- **Submit-time validation (R13).** On Save: validate, and on failure render an **error summary card
  at the top of the content column** (`role="alert"`, `border-l-2 border-destructive`,
  `bg-destructive/8`) listing each problem as a link that focuses its field, **plus** inline
  `aria-invalid` + `text-destructive text-xs` under each field. Focus moves to the summary. Named
  case: *"Minimum jitter (15000 ms) is above maximum jitter (12000 ms). The run would fail to start."*
  — it names both fields and the *consequence*, because the consequence is what happens at 07:00 while
  the user is asleep. **The save button is never disabled.**
- **Success (R14).** An inline confirmation replaces the save bar and *persists* until navigation
  (`bg-success/10`, `border-l-2 border-success`): *"Saved. Takes effect from your next run — nothing
  is running right now."* Variant when a run is in flight: *"Saved. A run is in progress; this applies
  to the next run, not that one."* A sonner toast fires too, but the toast is not the carrier —
  the persona is explicitly *not always at the keyboard*, and a change discovered by absence hours
  later is the failure mode G15 names. (C13.)
- **Optimistic acknowledgement (Doherty).** The button flips to `Saving…` inside 400ms regardless of
  round-trip.

---

## 12. Five states, every screen

| Screen | Default | Empty | Loading | Error | Success |
|---|---|---|---|---|---|
| **S1 landing** | thin-run line + caps + rules | no run yet → thin-run card replaced by one muted line; caps still render | 1 card skeleton + 4 skeleton rows at exact row height | inline `ErrorRetry` per block — caps can fail while rules load | values render; the last-run number is the one accented element |
| **S2 / S4 rule sections** | two cards, idiom order | a rule list with no entries → *"No rules — nothing is dropped for this reason"* + `[Add]` inline (Fitts: action where the eye is) | field-shaped skeletons, **never a skeleton of the conflict notice** | submit summary at top + inline per field | sticky bar → persistent success line |
| **S3 Fetching** | 4 caps + 3 presets | n/a (values always exist — defaults) | skeleton inputs, preset cards render as outlines | cross-field error names both fields + consequence | preset ring moves; success line states next-run effect |
| **S5 Raw config** | doc list + editor | a doc that does not exist → *"Not created yet — saving will create it"* | textarea skeleton at same height (no layout shift) | parse error in the same summary card, with line number | success line + the form-badge list refreshes |
| **S6/S7 Operate** | 5 cards, calm | new profile with nothing configured → the health card is the only expanded one | per-card skeleton; **the daemon card does not skeleton its state word** | `api-unreachable` state is a *first-class* daemon state, not an error banner; per-card `[Retry]` | state words + `[Skip next]` → *"Next run skipped"* chip on the row |
| **S9 Danger zone** | type-to-confirm input | n/a | — | 409 `run_in_progress` / `intent_pending` rendered as a sentence, not raw JSON | profile removed → redirect + toast |

**Two state rules carried forward from the previous epic, and one added:**
- **Never skeleton a state whose shape implies severity** — no red/amber-shaped placeholder ever
  flashes. The conflict notice (S2), the error summary (S8) and the daemon's degraded treatment
  mount only once data has arrived.
- **A probe timeout reads *unknown*, never the bad state** — R17, and the daemon's own
  `api-unreachable`.
- **Added:** *an empty rule list says what its emptiness means* — "No rules — nothing is dropped for
  this reason" — because on a config surface an empty list and a permissive list look identical and
  mean opposite things.

---

## 13. Efficiency pass — clicks counted, elements killed

| Job | Today | This design |
|---|---|---|
| "why was my run thin" (P-c, JTBD-4) | read source, or guess | **1 click** — sidebar → Settings; the answer is on the landing screen with no section choice |
| "change the timezone I'll accept" (R2, the 1/5 case) | know two files, edit JSON in both | **2 clicks**, one screen, both halves visible, conflicts named |
| "is Chrome still signed in" (P-b, G3) | **impossible at any layer** | **1 click** — sidebar → Operate |
| "is the breaker open" (G9) | impossible | **0 further clicks** — same card as the session |
| "start the daemon" (P-b, G4) | leave the board, open a terminal | **1 click** (or 1 click + paste, under variant b) |
| "what isn't set up" (R22) | two pages, 13–14 checks | **1 click**, one card, each row carrying its destination |

**Killed, each with a reason (Occam's razor):**
- **Six per-section JSON hatches** → one Advanced area (R4). Six controls become one, and the one
  that remains routes users *back* to the forms.
- **The connector dropdown** → read-only display (R11). It was the highest-blast-radius control on
  the page and it had no confirm; deleting it as a control removes the risk entirely rather than
  wrapping it in a dialog.
- **A separate Doctor card beside a Completeness card** → one card (C11). Would have rendered the
  same checks twice.
- **A page-level pacing warning banner** → moved inside the Fast preset (C5). A banner on every visit
  is a banner nobody reads.
- **The always-visible completeness checklist** → collapses to one line when all green.
- **A manual breaker reset** (R29, Won't) and **an autosave** (R32, Won't) — both confirmed absent.
- **`PLACEHOLDER_COPY`** (`SettingsPage.tsx:30-34`) — dead code naming three implemented sections as
  "coming soon". Flagged for deletion.
- **Confirmation dialogs on reversible edits** (R25) — none anywhere except the dirty-nav guard,
  where the loss is real, and the danger zone, where it is permanent.

---

## 14. Accessibility

- **Keyboard path.** Sidebar → (Settings) nav column, roving tabindex, ↑/↓ move, Enter opens → content
  column, whose first focusable is the first editable field → sticky save bar last. On Operate, tab
  order is card order, i.e. severity order. The dirty-nav dialog traps focus and returns it to the
  triggering nav item on cancel.
- **Focus.** `ring-3 ring-ring/50` (3px `#7b5ea7` @50%) at `:focus-visible` only, never removed. The
  error summary's links move focus *into* the offending field; the disclosure toggles move focus into
  the revealed region and return it to the trigger on collapse.
- **Contrast.** `--muted-foreground #6e5b87` on `#faf8fd` and on `#ffffff` clears 4.5:1 for body text.
  `--attention #ff8a3d` and `--amber #c98a2e` are used for **icons, 1–2px borders and tints only**,
  never as text colour on background at body size — they do not clear 4.5:1 and this is a hard rule
  for the render. `--destructive #d64545` itself fails 4.5:1 as text (4.38:1 on `#ffffff`) — B13
  (QA settings-overhaul, round 2) found this pairing internally non-conformant and ruled it out;
  `--destructive-strong #c62c2c` (5.53:1 on `#ffffff`) is the sanctioned pairing for destructive
  TEXT at `text-xs`+ weight 500, and `--destructive` stays reserved for borders/tints only.
- **Never colour alone.** Every status carries a word: `Running`, `Stopped`, `Signed in`, `Unknown`,
  `Open until 21:40`, `Closed`. The whole design is legible in greyscale — that is the acceptance
  test.
- **Labelled controls.** Every field has a `<label for>`; chip inputs are `role="listbox"` with
  removable chips as buttons carrying `aria-label="Remove Asia/Kolkata"`; the preset group is a
  `radiogroup` with `aria-describedby` pointing at each preset's consequence text; icon-only controls
  (`[Copy]`, `[Check now]`) carry `aria-label`. Secrets fields are `type="password"` with
  `autocomplete="off"` and are never populated from the server.
- **Live regions.** Save results announce `polite`; the validation summary announces `assertive`
  because it invalidates the submit the user just made. Daemon state changes announce `polite`.
- **Reduced motion.** `prefers-reduced-motion` flattens the skeleton shimmer and the `hop` transition;
  nothing conveys state by motion alone.
- **User control, no dead ends.** Every destructive or lossy path has a back: `Discard`/`Stay` on the
  nav guard, `[Cancel]` on the removal dialog, and every error state carries a `[Retry]` that leaves
  the rest of the page usable.

---

## 15. Numbered callouts (mapped to mockup badges)

| # | Screen | Rationale |
|---|---|---|
| **C1** | S1/S6 headers | **The boundary is C, not B.** Machine-vs-profile is a mechanical property of the data (one daemon, one `.env`, one Chrome-profile breaker file); health-vs-config is the sentence it happens to produce. Deciding the seams by the rule rather than the slogan is what stops the leakage §7.5 predicts for B. |
| **C2** | S2, S4 | **One repeated idiom — "Rules drop / Preferences reorder" — in three sections.** Learn once, apply three times (Miller/consistency). It is what lets R2 join two documents without either lying about their semantics or exposing the file split. |
| **C3** | S1 | **The landing screen is the answer to the 1/5 navigation test.** A confidently-wrong user does not read nav labels. Showing every decisive value at once removes recall from the critical path; the taxonomy becomes the way *back*, not the way in. |
| **C4** | S2 | **The cross-document conflict notice** — an acceptable-but-dropped timezone is stated, with two one-click fixes. **Jakob does not apply here: no tool the persona uses does this.** It is the one capability the file-shaped IA is structurally incapable of, and therefore the epic's clearest payoff. |
| **C5** | S3 | **The pacing consequence lives inside the Fast card, not on the page.** A page-level warning is present on the 95% of visits where nothing risky happens, and is learned past by the third visit. A warning with no steady state cannot go banner-blind. Resolves concern (d). *Transferred reasoning — flagged.* |
| **C6** | S4 | **R15's preview is designed to be absent.** It mounts between two stacked cards, so a failed spike collapses it with no layout hole and nothing else references it. Designing the cut is what makes the Should genuinely cuttable. |
| **C7** | S5 | **The escape hatch routes back to the forms.** Per-key `has a form →` badges plus a banner naming exactly what is raw-only. Resolves concern (c): reachable in one click, attractive from nowhere, and honest about its own scope. |
| **C8** | S6 c3 | **Session and breaker share one card** — the two silent-outage gaps produce the identical symptom (a calm empty run). Seeing one without the other is misleading. |
| **C9** | S6 c1 | **R20 is designed in both variants**, and the fallback *replaces* the button with copy + `[Copy: jobbunny serve start]` rather than disabling it. GOV.UK: users read a disabled control as system status. |
| **C10** | S7 | **Urgency = weight, not hue** (inherited), plus: **only the worst problem takes the accent.** Three simultaneous alarms with equal weight destroy the ranking the operator came for. |
| **C11** | S6 c4 | **Doctor and the completeness checklist merge.** The Hub is already a doctor projection; two cards would render the same 13–14 checks twice. Every row carries a destination — a Settings link, or a named CLI/slash command (R23), never a board reimplementation. |
| **C12** | S6 c3 | **No probe on page load; a timeout reads *unknown*.** Tesler's Law inverted correctly: the *system* owns the one-Chrome invariant, so it never probes on a route change — and a false "signed out" would train the user to ignore the one signal that silently invalidates everything. |
| **C13** | S8 | **"Takes effect from your next run" is an inline line that persists, not a toast.** The persona is not always at the keyboard; a transient confirmation for a change that lands at 07:00 is a confirmation nobody reads. Doherty is served separately by the `Saving…` flip. |
| **C14** | S8 | **Save is never disabled; validation fires at submit with a summary + inline pair.** Sourced GOV.UK, and it is the mechanism that stops G10 — a config that saves at 22:00 and kills the 07:00 run. |
| **C15** | S1 footer / S6 header | **Scope is a place first, a label second.** Two routes carry R3 structurally; the badges (`Profile: harish` / `This machine · all profiles`) reinforce. Resolves concern (e) — both, with place doing the work. |

---

## 16. Charter scorecard

| Pillar | Score | Rationale |
|---|---|---|
| **Learnability** | **Strong** | One repeated idiom ("Rules drop / Preferences reorder") covers three sections; one save model covers eleven; the landing screen means the user never has to *learn* the taxonomy to use it. Not top-of-scale: the machine-vs-profile boundary is a genuine new concept, and the user must learn *which page* before the labels help him. |
| **Efficiency** | **Strong** | Every evidenced journey lands at 1–2 clicks, three of them from a starting point of *impossible*. Six escape hatches collapse to one; the highest-risk control is deleted rather than guarded. This is the pillar the design optimises hardest and it is aligned with the spec's counter-metric (time in Settings should *fall*). |
| **Memorability** | **Medium** | *Non-top score, named.* Twelve sections in four groups is a lot for a surface visited a few times a month, and two names are genuinely guessable-wrong: **"Where jobs come from"** (lanes + search URLs) and **"Housekeeping"** (cleanup TTLs + routines) are my coinages, not the user's vocabulary, and neither was tested. The mitigation is real but partial — the landing screen and R26 search both route around recall — which is precisely an admission that the taxonomy alone will not be remembered. If a later test shows the same 1/5 failure against *these* names, promote R26 from Could to Must rather than renaming again. |
| **Error prevention** | **Medium-Strong** | R13 closes the design's worst failure mode (a config saved at 22:00 that kills the 07:00 run) at the commit point, with the consequence named in the error; the connector control is deleted rather than confirmed; the dirty guard makes edit loss impossible; the breaker has no reset. **But** it cannot prevent the errors that matter most and it should not claim to: a *valid* config that is simply wrong for the user's intent is unpreventable, R15 — the only mechanism that would show it before commit — is a conditional Should, and R13's validator carries its own named risk of being *stricter* than wire time and locking the user out of states the pipeline accepts. |
| **Satisfaction** | **Medium-Strong** | The wins are relief, not delight: an answer to "why was my run thin" that used to require a source read, and two silent outages that were previously invisible at any layer. That is genuinely satisfying for this persona. It is capped honestly — the spec's own counter-metric says a settings page that becomes engaging has failed, so the ceiling here is *low friction*, not enjoyment, and aiming higher would be the wrong instinct. |

### Named weaknesses — this scorecard is not a clean sweep

1. **My two weakest section names are unvalidated** — see Memorability. "Where jobs come from" and
   "Housekeeping" are the two most likely to reproduce the §9 failure. Cheaply testable: re-run the
   five-minute unprimed navigation test against this IA before build, and if it scores below 4/5,
   promote R26 (search) rather than iterating on names.
2. **Two headline design moves are transferred reasoning, not sourced practice.** The pacing-consequence
   placement (C5) and the breaker presentation (S6 c3) inherit spec §16 weakness 4 — no in-domain
   source exists for either. I have not removed that flag and cannot.
3. **The conflict notice (C4) — the epic's clearest payoff — rests on a semantic I have not verified
   first-hand.** `filter.json.timezones` gates *remote* roles specifically; if the board cannot
   cheaply evaluate that condition, the notice must degrade to the connective line, and R2 then ships
   as good adjacency rather than an actual join. That would be a materially weaker requirement than
   the spec's best-evidenced one, and it is a BE dependency, not a design choice.
4. **The landing screen is scope I added.** It is not a numbered requirement — it is my reading of
   Content Priority #1–#2 plus the §9 evidence. It is defensible and it is the design's strongest
   element, but a reviewer is entitled to call it invention, and it should be the first thing cut if
   Phase 1 runs long. Its loss costs one click and the thin-run answer, not the IA.
5. **The scope split's cost is a second navigation decision, every time.** "Is this a machine thing or
   a profile thing?" is a question the current single-page Settings never asks. I judge it worth
   paying because R3 is a Must and place is its strongest expression — but if the user rules Option A
   at the gate, that judgement is reversed at low cost and I do not consider the reversal a defeat.

---

## 17. Render contract — `data-qa` map

Every region below carries `data-qa="<kebab-id>"` so QA can pair mockup regions to shipped elements
mechanically. Ids are stable and downstream stages must not rename them.

`settings-shell` · `settings-nav` · `settings-nav-group-aim|runs|output|advanced` · `settings-search`
· `scope-chip-profile` · `scope-chip-machine`
S1: `landing-thin-run` · `landing-caps-table` · `landing-cap-row-{max-new-per-lane|max-probes-per-run|max-cards-per-url|max-age-days}` · `landing-rules-summary` · `landing-scope-footer`
S2: `geo-rules-card` · `geo-prefs-card` · `geo-connective-line` · `geo-conflict-notice` · `geo-timezones-rule` · `geo-timezones-acceptable` · `geo-timezones-borderline`
S3: `fetch-caps-card` · `fetch-cap-{name}` · `pacing-presets` · `pacing-preset-{safe|normal|fast}` · `pacing-fast-warning` · `pacing-fast-ack` · `pacing-advanced-disclosure` · `pacing-raw-{jitter-min|jitter-max|inter-url-min|inter-url-max}`
S4: `roles-rules-card` · `roles-prefs-card` · `companies-avoid-card` · `rule-preview-strip`
S5: `raw-doc-list` · `raw-doc-{name}` · `raw-editor` · `raw-scope-banner` · `raw-key-badge-{key}`
S6/S7: `operate-shell` · `card-daemon` · `daemon-state` · `daemon-start-stop` · `daemon-start-fallback` · `daemon-pause-all` · `daemon-autostart` · `card-scheduled-runs` · `schedule-row-{profile}` · `schedule-skip-next` · `card-linkedin` · `linkedin-session` · `linkedin-session-check` · `linkedin-breaker` · `card-setup-health` · `health-group-{needs-action|not-configured|ok}` · `health-row-{check}` · `health-destination-{check}` · `card-secrets` · `secret-row-{key}`
S8: `save-bar` · `save-button` · `discard-button` · `validation-summary` · `validation-item-{field}` · `save-success-line` · `dirty-nav-dialog`
S9: `danger-zone` · `danger-confirm-input` · `danger-remove-button`

---

## NOTES

- **Spec deviations: none.** Two additions beyond the numbered requirements, both recorded above
  rather than applied silently: the **S1 landing screen** (weakness 4) and the **merge of R21+R22
  into one card** (C11). Neither contradicts a requirement; both are Content-Priority translations,
  which §10 assigns to product-ux.
- **Open for the user at the mockup gate:** the §1 boundary ruling. Everything below §2 is
  boundary-independent.
- **Open for BE:** (a) can the board evaluate the filter-timezone *remote-only* condition cheaply
  enough for C4's notice; (b) R15 spike; (c) R20 mechanism; (d) `userDataDir` resolution for R18;
  (e) whether "pause the schedule" is a per-profile field or a machine-wide one — I have designed
  **per-profile rows plus a machine-wide master**, which is the superset and degrades to either.
- **Recommend to product-ui:** promote **R26 (search)** from Could if the §16.1 re-test scores below
  4/5. Delete `PLACEHOLDER_COPY` (`SettingsPage.tsx:30-34`), dead code naming three shipped sections
  "coming soon".
- **Not designed, by scope:** new-profile creation (R28, Won't), breaker reset (R29), login
  implementation (R30), Telegram digest shape (R31), autosave (R32).
- **Assumption:** the existing six daemon states in `ScheduleSection.tsx` move to Operate unchanged.
  They are already good; re-designing them would be churn.
