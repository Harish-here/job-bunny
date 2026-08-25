# Spec — UI Design System & Triage Job-Details Overhaul

Slug: `ui-design-system`
Status: ready for UX
Author: product-pm · 2026-08-25
Persona: `/Users/harishamutha/job-bunny-ui-design-system/docs/product/personas.md` (v1.4 — **JTBD-5 added by this run**)
State/audit trail: `/Users/harishamutha/job-bunny-ui-design-system/docs/product/ui-design-system/.state.md`
Scope: the board SPA (`ui/`) at `127.0.0.1:1994` — all eight screens, with the triage job-details
section rebuilt as the flagship. **UI-only: no pipeline, no schema, no new backend endpoint.**

> **For the UX designer reading this cold:** Job Bunny is a personal, single-user job-search pipeline
> that runs on the user's own laptop. It scrapes job postings from LinkedIn and a few ATS APIs,
> filters and ranks them against a resume profile, and puts the survivors on a local web board. A
> "run" is one pass of a frozen 10-stage pipeline. There is one user, no login, no team, no network
> exposure. The user is also the developer of the tool. **Triage is the screen where he looks at each
> new job and decides apply / lead / pass.** This spec is about making the whole UI read as one
> product, and about rebuilding that triage screen's detail pane as the proof.

> **Read this before anything else.** A large part of a design system already ships here. Colour is
> tokenised, dual-mode and pinned by tests. Copy casing is already consistent. **Two of the ask's
> four pillars are substantially pre-satisfied**, and this spec says so rather than manufacturing
> work to fill them. The real holes are narrow and specific — see §5.

---

## 1. Problem & Goal

**The ask** was to build a design system, apply it everywhere, and rebuild triage's job-details
section with it. Treated as a solution hypothesis, not the problem. Five whys:

1. Why does the UI need a design system? → Because it does not read as one product: the same concept
   renders differently on different screens.
2. Why does it render differently? → Because the shared vocabulary lives in **prose** — the Design
   Scale tables inside `ux-notes.md` files — and in reviewers' heads. Some of it was also written as
   code. The two halves have not fared the same.
3. Why does *that* matter? → **Because drift concentrated precisely where enforcement was absent, and
   this is observable in the repo rather than asserted:**

   | Decision | Enforced as code? | Drift found |
   |---|---|---|
   | Colour (38 tokens, light + dark) | **Yes** — `ui/src/lib/tokens.test.ts:18-119` pins every value by literal hex | **None in the app** |
   | Base radius, font families, motion, reduced-motion guard | **Yes** — `tokens.test.ts:101-135` | **None** |
   | Type size / line-height / weight | **No** — zero tokens exist | 279 ad-hoc utility uses; **5 off-scale arbitrary values** (`text-[10px]` ×4, `text-[9px]` ×1) |
   | How a state is encoded | **No** — a prose rule in `run-experience-overhaul/ux-notes.md:33-36` | Runs uses shape + weight + language; **triage uses hue alone** (`JobRow.tsx:5-10,42-46`) |
   | Which word names which concept | **No** — no vocabulary module | `Skip`/`Passed` and `Save`/`Lead` (`DecideBar.tsx:23,26` vs `decide.ts:9-13`) |
   | Which icon set | **No** | lucide everywhere, except raw unicode `✓ ✗ ☆ ↑ ↓` in triage (`DecideBar.tsx:20,23,26`, `TriagePage.tsx:126,135`) |

4. Why does *that* matter to the user? → Because the drift landed hardest on **triage** — the screen
   the primary persona uses most, and the only screen the primary job runs through. Triage hand-rolls
   a card instead of using `Card` (`JobFacts.tsx:10`), renders "Why it matches" and "Review flags" in
   **identical** bullets and identical muted colour despite their being opposite signals
   (`JobFacts.tsx:25-44`), shows the score as an unlabelled badge with no scale (`JobHeader.tsx:28`),
   and dumps the full JD into an unbounded full-width `<pre>` (`JdText.tsx:10`).
5. **Root:** *design decisions hold only where they were written as code. Everything left in prose
   has drifted — and the drift concentrated in the one screen the primary job actually runs through.*

That root reshapes the deliverable. This is **not** "write a design system document." A document is
the failure mode, not the fix: the repo already has three of them (two `ux-notes.md` Design Scale
tables and a set of mockups) and **they have drifted from each other** — `run-experience-overhaul`'s
mockup names its tints `--primary-tint` / `--destructive-tint`, `settings-overhaul`'s names the same
concept `--attention-10` / `--destructive-8`, and their `--muted-foreground` values differ (`#6d6280`
vs `#6e5b87`). Two mockups, one product, three conventions.

**Goal (outcome, not output):** the UI reads as one product because its design decisions live in code
that fails the build when violated — and triage, where the persona spends his time, is the screen
that demonstrates it.

---

## 2. Persona & JTBD

Full persona: `docs/product/personas.md` — **P1, "The Operator-Owner."** Sole user, sole developer.
Three hats: **job-seeker** (wants leads, zero patience for internals), **operator** (worn under
duress), **tuner** (worn deliberately). **This spec serves the job-seeker hat**, which the two
previous epics served only indirectly — both were about the machine; this one is about the leads.

The persona doc's existing jobs stop one step short of what triage actually is. JTBD-1 covers *"did
this run produce anything worth my attention"* — a question answered on the runs page, in seconds,
about a batch. It does not cover what happens next: working through that batch job by job. **This
spec names that job and adds it to the persona doc.**

**Canonical job statement (JTBD-5, new — added to `personas.md` v1.4 by this run):**

> When a run has put new jobs on my board, I want to decide apply / lead / pass on each one in
> seconds — without reading every posting in full — so triage costs me minutes rather than an
> evening, and the good ones don't get buried under the mediocre ones.

**Persona facts that bound every decision below:**

- **Not a team.** *"Anything that assumes a second human is waste."* This is the hardest constraint in
  this spec, because virtually every published argument for a design system — designer onboarding,
  parallel teams, handoff fidelity, scale — assumes more than one person. Those arguments are
  **inadmissible here** and are not used anywhere in this document. See §7.1.
- **Not a novice.** Density and directness over hand-holding. The triage pane should get *denser* and
  better ranked, not friendlier.
- **Capability is not willingness.** He can read the JD. The cost is the seconds it takes, multiplied
  by every job in every batch.
- **Not always at the keyboard, and reads on his own schedule.** Relevant in a way nobody has noticed:
  the app follows the OS colour scheme (`ui/src/main.tsx:8-11`), so evening use renders in **dark
  mode — a live surface no mockup or design pass has ever covered.** See G8.

---

## 3. Industry Research

One pass, product and interaction patterns together. **This is the pipeline's only research pass —
product-ux reuses this section rather than commissioning a second.** URLs are canonical entry points
for each source.

### Table stakes (absence reads as a defect)

| Pattern | Source |
|---|---|
| Design tokens layer **primitive → semantic → component**; semantic names state intent (`text/subdued`), never appearance (`text/gray`) | W3C Design Tokens Community Group format, v1 (Oct 2025) — https://tr.designtokens.org/format/ |
| Tokens ship as **CSS custom properties**, not as a doc — Tailwind v4 makes `@theme` the mechanism | https://tailwindcss.com/docs/theme |
| A colour system needs **semantic roles** (surface / foreground / border / accent / danger / success / muted), not a palette; Radix's 12 steps assign 1–2 background, 3–5 component states, 6–8 borders, 11–12 text | https://www.radix-ui.com/colors |
| Type scales in shipped systems are **small and ratio-based**: Polaris and Atlassian both use **1.2**, on a 4px grid, base 16px / body 14px | https://atlassian.design/foundations/typography · https://polaris.shopify.com/design/typography |
| **45–90 characters per line** is the readable measure for continuous prose | Butterick, *Practical Typography* — https://practicaltypography.com/line-length.html |
| `font-variant-numeric: tabular-nums` for any column of numbers, so digits align and don't jitter on update | Ant Design #11567 — https://github.com/ant-design/ant-design/pull/11567 |
| Voice guidance converges on a **short rule set**: sentence case; active voice; imperative verb + object on buttons; short plain words; lead with the main point | Shopify Polaris — https://polaris.shopify.com/content/voice-and-tone · Mailchimp — https://styleguide.mailchimp.com/voice-and-tone/ · GOV.UK — https://www.gov.uk/guidance/style-guide/a-to-z-of-gov-uk-style |
| A terminology list is structured as **one reserved term per concept plus its banned synonyms** — GOV.UK's A–Z is 100+ "don't say X, say Y" entries | https://www.gov.uk/guidance/style-guide/a-to-z-of-gov-uk-style |
| **Static glossaries decay without a CI gate**; what survives is living documentation generated from code plus an automated block | Vale — https://vale.sh/ · `eslint-plugin-i18next` `no-literal-string` — https://github.com/edvardchen/eslint-plugin-i18next |
| Terminology drift has a named cost: one component called "button" / "CTA" / "action" confuses its users and erodes trust in the system | NN/g and UXPin design-system literature |
| A triage queue offers **few actions, on hotkeys, no multi-select** — Linear ships exactly four | https://linear.app/docs/triage |
| A triage card is designed to be **scannable in 3–5 seconds**; `j`/`k` list navigation is the inherited convention from vi and Gmail | GitHub issue/PR triage; Gmail keyboard shortcuts |
| **Reversible action + undo window beats a confirmation dialog** for a queue you move through quickly | Gmail undo-send; Linear archive |

### Job-posting hierarchy — what a seeker needs, in what order

Expected order in a posting: **title → location → employment type → short summary → 2–4
responsibilities → team context → benefits.** Measured behaviour: the initial scan is **6–7 seconds**
before deciding whether to read on; ~**14.6s** on requirements; ~**1 minute** on a whole posting.

**The single strongest finding, and this spec cannot act on it:** compensation is the dominant
abandonment trigger — **60% of seekers won't apply to a posting without a salary range** (Monster),
postings with a range draw **~36% more applications**, and **91% of new Indeed postings now include
one**. Job Bunny does not capture scraped compensation at any layer. See §14 and §15 weakness 6.

### Marked as transferred, NOT sourced in-domain

Flagged again in the scorecard. The research pass found **no**:

- **Design system published by any ATS or job board** — Greenhouse, Lever and Ashby publish none. The
  triage-pane hierarchy below is transferred from generic review-queue patterns (Linear, GitHub,
  Gmail) plus recruiting-side "how to write a job ad" guidance, which describes what employers are
  told to write, not what seekers are observed to read.
- **Usability study of a job board's triage flow.** None found.
- **Any design-system value literature for n=1.** Every source assumes a team. §7.1 treats this as the
  central objection rather than burying it.

### Anti-patterns explicitly rejected

A token set larger than the product needs (W3C's own guidance is that unused tiers are the common
regret); appearance-named semantic tokens; a component gallery nobody visits; adding a prose-linter
dependency to a repo that deliberately holds runtime deps at three; confirmation dialogs on
reversible triage decisions; multi-select bulk triage (Linear explicitly ships without it); and
redesigning working screens under cover of "applying the system."

---

## 4. Classification

**Change to existing.** Evidence, not assumption:

- `ui/src/index.css` already defines 38 colour tokens in `:root` **and** 38 in `.dark`, a
  calc-derived radius scale (`--radius: 1rem`, sm–4xl), four font families, motion tokens, and a
  `prefers-reduced-motion` guard.
- `ui/src/lib/tokens.test.ts:18-136` already pins all of it — **verified first-hand.**
- `ui/components.json` configures shadcn (style `radix-nova`, lucide icons); 17 base components are
  checked into `ui/src/components/ui/`.

**The stack question therefore does not arise.** It is inherited and settled: React 19, Vite,
Tailwind v4 (`@theme` in `ui/src/index.css`), shadcn over Radix primitives via the `radix-ui`
meta-package, CVA for variants, lucide icons, TanStack Query v5, a hand-rolled hash router
(`ui/src/lib/router.ts`), React Hook Form, `sonner` toasts, Vitest + jsdom + Testing Library,
Playwright e2e against the real board server over the `rajni` fixture. No CSS-in-JS, no CSS modules,
**no Storybook**. UX and UI stages design to these primitives.

---

## 5. Current State

### 5.1 What already exists — the ask is narrower than it looks

| Ask pillar | State today | What is actually missing |
|---|---|---|
| **(1) Colour scheme** | **Substantially done.** Single brand hue `#7b5ea7`; 38 semantic tokens per mode incl. `-strong` variants added specifically because plain `--attention`/`--amber` fail 4.5:1 as body text; pinned by tests. | Documentation and a **contrast guarantee in both modes**. Not a build. |
| **(2) Typography scale** | **Genuinely missing.** `index.css:7-12` defines font *families* only — **no size, line-height or weight token anywhere.** | The real hole. See §5.2. |
| **(3) Copywriting voice** | **Low defect load.** Casing is uniformly sentence case across every feature folder sampled. | A written rule set to hold the line; no cleanup campaign is warranted. |
| **(4) Vocabulary glossary** | **Missing, with live collisions.** | See §5.3. |
| **Tokens as code** | Colour/radius/motion yes; type/state-encoding/vocabulary no. | Extend the existing mechanism. |

### 5.2 The typography hole, measured

No type tokens exist. Actual usage across `ui/src/**`:

| Utility | Occurrences |
|---|---|
| `text-sm` | 184 |
| `text-xs` | 75 |
| `text-lg` | 8 |
| `text-2xl` | 7 |
| `text-base` | 5 |
| `text-[10px]` / `text-[9px]` (arbitrary, off-scale) | 5 |

**259 of 279 uses (93%) are the two smallest steps.** The scale is not so much absent as **unnamed
and unbounded** — five de-facto steps plus two escapes. That is a smaller problem than "build a type
scale" implies, and the requirement is sized accordingly.

### 5.3 The vocabulary collisions — evidence for ask-item (4)

| Collision | Evidence |
|---|---|
| **"Skip" (button) = `Passed` (stored)** | `DecideBar.tsx:23` vs `decide.ts:9-13`. Two words, one concept. |
| **"Save" (button) = `Lead` (stored)** — the worse one | `DecideBar.tsx:26`. "Save" is *also* the form-commit verb throughout Settings, so **one word means two different things in one product.** |
| Both are **documented as deliberate** | `decide.ts:3-8`: *"spec decision, not the vocab's own authority."* This will not self-correct; reversing it is a decision, which is why it went to the user (Q5a). |
| Lane names render as raw identifiers | `WhereJobsComeFromSection.tsx:233` renders `linkedin` / `greenhouse` / `keka` — internal ids used as UI labels. |
| A run-state lexicon exists but is trapped in one file | `runOutcome.ts:59-77` — "Ran clean", "Ran with warnings", "Failed at `<stage>`", "Lost contact", "Telemetry missing". Good words, no reuse path. |
| Stage names and tracking statuses are **canonical and frozen** | `runProgress.ts:4-15` (10 stages); `src/core/tracking/vocab.ts:9-18` (8 statuses). CLAUDE.md: **Notion select option strings are byte-exact.** The glossary records these; it never renames them. |
| Excitement vocabulary is idiosyncratic and deliberate | `vocab.ts:31` — `Vera level`, `Kandipa podu`, `Try panalam`. Confirmed reserved (Q5c). |

**Feasibility fact for the glossary-as-code path:** `src/core/tracking/vocab.ts` contains only
`export const` / `export type` and **imports nothing**, so it satisfies the `ui/` → `core`
dependency-free seam and is UI-importable. Confirmed by read; still **PROVISIONAL** pending
product-ui.

### 5.4 The triage job-details section — what it renders today

`TriagePage.tsx:191-217` renders, top to bottom, with no ranking beyond source order:
`JobHeader` → `DecideBar` → `JobFacts` → `JdText` → `TrackingPanel`.

| Defect | Evidence |
|---|---|
| Opposite signals render identically | `JobFacts.tsx:25-44` — "Why it matches" and "Review flags": same bullets, same `text-muted-foreground`. |
| The score is unlabelled and unscaled | `JobHeader.tsx:28`, `JobRow.tsx:48-52` — renders e.g. `74` with no label and no "out of". |
| Eligibility facts collapse into one undifferentiated muted line | `JobFacts.tsx:11-15` — location, work type, timezone, seniority. |
| The JD has no measure cap and no progressive disclosure | `JdText.tsx:10` — full-pane-width `<pre>`, pushing the tracking panel far below the fold. |
| The pane hand-rolls a card | `JobFacts.tsx:10` — `rounded-lg border border-border` vs the shipped `Card` idiom (`rounded-xl`, `ring-1`, no border). |
| Raw unicode glyphs, not lucide | `DecideBar.tsx:20,23,26`; `TriagePage.tsx:126,135`. |
| A reversible action is styled destructive | `DecideBar.tsx:22` — `variant="destructive"` on Skip, though the component's own comment says decisions stay changeable. |
| Job status is encoded by **hue alone** | `JobRow.tsx:5-10,42-46` — a 6px dot; the only non-colour cue is a `title` attribute. |
| `lane` is available and rendered **nowhere** on a job | `GET /api/profiles/:name/jobs` returns it; no job surface displays it. |

**Scope fact:** `JobHeader` and `JobFacts` live in `ui/src/features/job/` and are **shared by the
triage detail pane and the standalone `#/job/:id` page** (`JobHeader.tsx:9`). Rebuilding one changes
both — for free, but it must be stated and tested.

### 5.5 The board's job write surface — a hard bound on the flagship

The **only** write path for a job is `PATCH /api/profiles/:name/jobs/:id/tracking`. `GET .../meta`
supplies `statusOptions` and `excitementOptions`. Every field the redesign needs is already returned
by `GET .../jobs` / `.../jobs/:id`. **This spec adds no endpoint and no field.**

---

## 6. Gaps

Delta between the persona's jobs and §5.

| # | Gap | Job blocked | Evidence |
|---|---|---|---|
| G1 | No type tokens exist, so every screen re-decides size and weight ad hoc; 5 values are off any scale. | — (systemic) | Recon §5.2 |
| G2 | Opposite signals — "why it matches" and "review flags" — are visually identical, so the pane cannot be scanned for the thing that decides the job. | **JTBD-5** | `JobFacts.tsx:25-44` |
| G3 | The score, the most decision-relevant number in triage, is an unlabelled badge with no scale. | **JTBD-5** | `JobHeader.tsx:28` |
| G4 | The JD is an unbounded full-width dump with no measure cap and no disclosure, pushing everything else below the fold. | **JTBD-5** | `JdText.tsx:10`; Butterick 45–90ch |
| G5 | The job's source (`lane`) is captured, returned by the API, and displayed nowhere. | JTBD-5 | Recon §5.4 |
| G6 | Job status is encoded by hue alone, contradicting the product's own shipped rule that state is weight and shape, never colour alone. | JTBD-5 | `JobRow.tsx:5-10` vs `run-experience-overhaul/ux-notes.md:33-36` |
| G7 | One word names two concepts (`Save` = commit a form **and** mark a job a Lead); two words name one concept (`Skip`/`Passed`). | JTBD-5 | `DecideBar.tsx:23,26`; `decide.ts:9-13` |
| G8 | **Dark mode is live** — the app follows the OS colour scheme — yet no mockup or design pass has ever covered it, so evening use renders in an undesigned, contrast-unverified surface. | All | `main.tsx:8-11`; both mockups light-only |
| G9 | Design decisions kept in prose have drifted; the two mockups disagree with each other on token naming and on `--muted-foreground`. | — (systemic) | Recon §4b |
| G10 | Triage mixes icon systems (unicode glyphs vs lucide) and hand-rolls a card, so the product's most-used screen is its least systematised. | JTBD-5 | `DecideBar.tsx:20-26`; `JobFacts.tsx:10` |
| G11 | Lane identifiers are shown to the user raw (`linkedin`, `greenhouse`, `keka`). | JTBD-4 | `WhereJobsComeFromSection.tsx:233` |

---

## 7. Relevance Verdict

### 7.1 The case against building this — stated first, and it deserves to be

- **Zero leads gained.** Measured in job leads — the only currency this product has — the direct yield
  is zero. This is the third spec in a row where that is true, and the third time it is conceded.
- **Every canonical argument for a design system assumes a team, and this product has one person.**
  Designer onboarding, parallel workstreams, handoff fidelity, consistency across squads — all
  inadmissible under the persona doc's *"anything that assumes a second human is waste."* There is no
  published evidence that a design system pays for itself at n=1. **This is the strongest objection in
  this document and nothing below fully answers it.**
- **Two of the four requested pillars are largely already satisfied.** Colour is shipped, dual-mode
  and test-pinned; casing is already consistent. A spec that treated all four pillars as equal work
  would be inventing half its own scope.
- **The enforcement gates are self-imposed friction the same person can delete.** A CI check you
  wrote, that blocks only you, that you can remove in one commit, is a note to self with extra steps.
  Its survival depends entirely on it never becoming annoying — see §9's riskiest assumption.
- **There is a counter-example to this spec's central claim inside this very repo.** Colour values are
  pinned by tests and did not drift *in the app* — but the two **mockups** drifted in colour token
  naming anyway, because they live outside the test's reach. Enforcement holds exactly as far as its
  scan reaches and not one file further.
- **Touching all eight screens risks regression for a benefit no single screen shows.** Swapping type
  utilities across 281 files can break working UI and Playwright selectors. The stability principle
  applies to the board too.
- **File-size headroom is already gone.** `DaemonCard.tsx` sits at **exactly 400** lines, the cap.
  Adding a vocabulary indirection layer adds imports and lines to files with nowhere to grow.
- **The bigger fish is still swimming.** The ~67% LinkedIn empty-identity yield loss still costs real
  leads. This epic costs effort and returns consistency.

### 7.2 What survives the case against

Four things, and only the first two are strong:

1. **Triage is not polish — it is the primary job's screen, and it is measurably the product's least
   systematised.** JTBD-5 runs entirely through it. Its defects are **functional, not aesthetic**: two
   opposite signals rendered identically (G2), an unlabelled score (G3), an unbounded JD that buries
   everything else (G4), and a status encoding the product's own rule forbids (G6). Each costs
   decision time on **every job in every batch, every day.** This is the majority of the spec's value
   and it does not depend on the design-system argument at all.
2. **The vocabulary collisions are defects with a real failure mode.** "Save" meaning both *commit this
   form* and *mark this job a Lead* in one product is how a wrong click happens. It is documented as
   deliberate (`decide.ts:3-8`), so it will not self-correct.
3. **Dark mode is a live, undesigned surface — and this spec is what discovered it.** `main.tsx:8-11`
   follows the OS setting, so evening use already renders in a mode no mockup has ever shown and no
   contrast pass has ever checked. That is a real, previously-unnamed risk to a user who reads on his
   own schedule, and it is cheap to close.
4. **The drift/enforcement correlation is observable here, not theoretical** (§1 table). Even
   discounted by the mockup counter-example in §7.1, moving a decision from prose into the repo's
   *existing* zero-dependency test idiom is the cheapest available lever. It is not free, and the
   spec does not pretend it is.

### 7.3 Verdict — **BUILD, reshaped**

Derived from §7.1–7.2 and the scorecard in §15, not asserted ahead of them.

**The reshape, and it changes where the effort goes.** The ask reads as "build a design system, then
apply it, then rebuild triage" — three roughly equal parts, in that order. The evidence does not
support that shape:

- **Pillar 1 (colour) is documentation, not construction.** Adopt and guarantee; do not rebuild.
- **Pillar 3 (voice) is a short written rule set, not a copy campaign.** The defect load is low and
  the spec refuses to inflate it.
- **Pillars 2 and 4 (type scale, glossary) are the genuine holes** and are sized as real work.
- **The triage rebuild is the majority of the value, not the finale.** It is where the primary job
  lives and where the defects are functional.

So: **build the system as the thin, enforced layer it actually needs to be, and spend the effort on
triage.** If this epic must shrink, it shrinks by dropping system polish, never by dropping triage.

**One slice, not two.** Both halves stay Must in this PR, per the dispatch. "Apply everywhere" is
scoped to **token, type-scale and glossary adoption** across the eight screens — explicitly *not* a
redesign of the other seven. That scoping is what makes one slice honest rather than an epic wearing
a spec's clothes.

**This is a recommendation, not a decision.** The orchestrator decides whether to stop. If the
n=1 objection in §7.1 is judged decisive, the defensible reduced scope is **triage + the vocabulary
module only** (R11–R12, R17–R24) — which needs no design-system argument to justify it.

---

## 8. Resolved Q&A

One round, five questions, all answered on the recommended default; one carried a factual correction.

| # | Question | Resolution |
|---|---|---|
| 1 | Dark mode — keep, drop, or ship a toggle? | **(b) keep, no toggle — AMENDED with a correction that matters.** Dark mode **is reachable today**: `main.tsx:8-11` toggles `.dark` from `matchMedia('(prefers-color-scheme: dark)')`, following the OS with no in-app control. **Verified first-hand by PM.** Consequence: both modes are live user-facing surfaces; every new colour token is defined in both blocks and pinned in both test lists; **"AA in both modes" is an acceptance criterion**; no toggle ships. This correction is what promoted G8 from housekeeping to a named risk in §7.2. |
| 2 | How hard to enforce the glossary? | **(c)** — a `ui/src/lib/vocabulary/` module **plus** a Vitest source-scan that fails the build on a banned synonym. Zero new dependencies. Rider: keep the banned list **small and precise** so it never false-positives on ordinary prose. Rejected: a prose-linter dependency (Vale/textlint/eslint-plugin-i18next) — `tokens.test.ts` already proves a source-scan does the job at this scale. |
| 3 | Triage rebuild depth? | **(b)** — restyle and re-rank existing fields, surface `lane`, progressive-disclosure JD, labelled score, split match-reasons from review-flags, non-colour-only status, lucide icons. **No new backend field.** Scraped compensation → Out of Scope with citation. |
| 4 | Does a living reference surface ship? | **(b)** — a canonical reference document in `docs/product/ui-design-system/`, machine-checked by `tokens.test.ts`. **No in-app gallery**: it is a team artefact, and the persona would never visit it. |
| 5 | Voice rules and the two collisions | **5a yes** — relabel to **"Pass"** and **"Lead"**, matching the frozen data vocabulary. **5b yes** — adopt the ~6-rule minimum voice set rather than a full style guide, given the low defect load. **5c keep** — the excitement vocabulary (`Vera level`, `Kandipa podu`, `Try panalam`) is **reserved product vocabulary**, not drift; it is byte-exact to Notion and cannot change regardless. |

---

## 9. Tech Story

Written backwards from the completion moment.

> **The completion moment:** the user clears a morning's new jobs in a few minutes, and never once
> notices that there is a design system.

> It's Wednesday morning. Last night's run put eleven jobs on my board. I open triage.
>
> The first job is up. **Match 74 of 100** — it says *of 100*, so I don't have to remember the scale.
> Under it, the two things that decide this job are no longer the same shade of grey: **why it
> matches** reads as the positive it is, and the **one review flag** reads as the caution it is. I
> can see the difference without reading either.
>
> Below that, the facts I actually gate on — remote, my timezone, senior, **from Greenhouse** — are
> four distinct facts, not one grey sentence. The job description is there, in a column I can
> actually read, showing me the start; if I lean yes, I open the rest.
>
> I don't lean yes. I hit **Pass**. Not "Skip" — the board calls it Passed, so the button calls it
> Pass, and the badge that appears says the same word. Next job loads. I hit **Lead** on the third
> one, and it's the same word Settings uses, and the same word Notion will show me later.
>
> Eleven jobs, four minutes. Then I open Settings to widen a rule, and the type, the spacing and the
> words are the ones I just spent four minutes reading. Nothing announces itself. It's the same
> product, all the way down.
>
> That evening I open it again on the sofa and the room is dark, so the board is dark. It looks like
> the same board. I can still read the muted text.

Small, testable, and every clause maps to a numbered acceptance criterion in §12.

**Riskiest assumption, named:** *that a self-imposed source-scan gate survives contact with its own
author.* Everything in the glossary pillar rests on it. At n=1, the person the gate blocks is the
person who can delete it, and the failure mode is not a loud one — the list quietly empties, or the
test gets skipped, and the glossary rots exactly as the literature predicts. **Mitigation, and it is
Q2's own rider:** keep the banned list small and precise, so the gate fires rarely and is right every
time it fires. **Cheap test, available before build:** write the banned list first and dry-run it over
today's `ui/src/**`. If it produces more than a handful of hits, or any hit the author disagrees with,
the list is wrong and must shrink before the gate ships.

**Second-riskiest:** that the triage rebuild actually shortens the decide loop. It is unmeasurable at
n=1 without instrumentation this spec deliberately does not add (§14). The defence is that G2/G3/G4
are defects on their face — identical rendering of opposite signals is wrong regardless of whether we
can time the improvement — but the honest position is that the *size* of the win is unknown.

---

## 10. Content Priority

A ranking of **what matters most**, at requirement level. Screen layout and visual hierarchy belong
to product-ux — this ranks the content, not the pixels.

**The triage detail pane, ranked by the 6–7 second first scan (the flagship's core question):**
1. **Is this job worth my next 30 seconds** — title, company, and the match score *with its scale*.
2. **Why the machine thinks so, and why it hesitates** — match reasons and review flags, as visibly
   *different* kinds of thing.
3. **Am I even eligible** — location, work type, timezone, seniority, as separable facts.
4. **Where did this come from and how fresh is it** — lane, date found.
5. **What skills is it asking for** — the badge row.
6. **The excitement verdict.**
7. **The job description** — the lean-yes content. Present, readable, disclosed rather than dumped.
8. **Tracking fields** — needed only *after* a decision, never competing with it.

**The system, ranked by what the product cannot hold without it:**
9. A named, bounded type scale, in tokens.
10. One reserved word per concept, in a module the screens import.
11. A rule that state is never encoded by colour alone.
12. Colour documented and contrast-guaranteed **in both modes**.
13. The voice rules.

**Always, quietly:**
14. Nothing about the system announces itself to the user. If the persona can *tell* a design system
    shipped, on any screen other than triage, the adoption over-reached.

---

## 11. Requirements

Every requirement carries a source. An unsourced requirement is a defect.
Source keys: **Ask** = the ask or an interview answer · **JTBD** = persona job · **Industry** = §3 ·
**Recon** = an observed fact in the code · **Stability** = CLAUDE.md's stability principle.

| # | Requirement | Source | MoSCoW |
|---|---|---|---|
| **Pillar A — tokens as code** ||||
| R1 | A **named, bounded typography scale** ships as tokens in `ui/src/index.css` (size + line-height + weight), covering the five de-facto steps in use. Small by construction — no step exists that no screen uses. | Ask (2), G1, Industry (Polaris/Atlassian 1.2) | **Must** |
| R2 | Colour tokens remain the single source of truth and are **documented**, with every foreground/background pair used for text meeting **WCAG AA 4.5:1 in _both_ light and dark**. | Ask (1), Q1, G8, Industry (Radix) | **Must** |
| R3 | `ui/src/lib/tokens.test.ts` is **extended** to pin every new token — type scale in both modes where mode-dependent — using the existing source-scan idiom. No new dependency. | Ask (tokens as code), Recon §5.1 | **Must** |
| R4 | A **canonical reference document** in `docs/product/ui-design-system/` records colour, type, spacing, radii, motion, voice and glossary, and is **machine-checked** against `index.css` so it cannot drift. | Q4, G9 | **Must** |
| R5 | Numeric columns and any repeatedly-updating number use **tabular numerals**. | Industry (Ant Design #11567) | **Should** |
| **Pillar B — voice** ||||
| R6 | A **~6-rule voice guideline** is written and recorded in R4's document: short plain words · active voice · imperative verb + object on buttons · sentence case · lead with the main point · one reserved term per concept. | Q5b, Ask (3), Industry (Polaris/Mailchimp/GOV.UK) | **Must** |
| **Pillar C — glossary** ||||
| R7 | A **glossary of reserved words** covers the product's concepts: the 10 stage names, run states, lane names, profile terms, tracking statuses, excitement levels, and the three triage actions — **one word per concept**, each with its banned synonyms. | Ask (4), G7, Industry (GOV.UK A–Z) | **Must** |
| R8 | The glossary exists as **code**: `ui/src/lib/vocabulary/`, exporting canonical display labels, imported by every screen this slice touches. Frozen strings (tracking statuses, stage names, excitement levels) are **mirrored, never renamed**. | Q2, Ask, **Stability** (Notion byte-exactness) | **Must** |
| R9 | A **Vitest source-scan** fails the build when a banned synonym appears as a user-visible string in `ui/src/**`. The banned list is **small and precise**; zero new dependencies. | Q2 (c) + rider, Industry (glossaries rot without a gate) | **Must** |
| R10 | Lane identifiers render as **display labels** (LinkedIn, Greenhouse, Keka), never as raw ids. | G11, R7 | **Should** |
| R11 | The triage actions are relabelled **"Pass"** and **"Lead"** to match the stored vocabulary; the status badge shown after a decision uses the same word as the button that caused it. | Q5a, G7 | **Must** |
| R12 | Keyboard shortcut hints stay correct after R11, and the shortcut keys themselves keep working unchanged. | Recon §5.4, **Stability** | **Must** |
| **Pillar D — adopt across every screen** ||||
| R13 | All **eight** screens (triage, tracker, runs, analytics, settings, job, setup/Operate, onboarding) consume the type-scale tokens and the vocabulary module. **This is token and word adoption, not redesign — no screen's layout or IA changes.** | Ask ("one product"), Q3 scope | **Must** |
| R14 | The **five off-scale arbitrary type values** are eliminated or promoted into the scale as a named step. | G1, Recon §5.2 | **Must** |
| R15 | **State is never encoded by colour alone** anywhere in the product — a second cue (shape, weight, or text) always accompanies hue. Formalises the rule `run-experience-overhaul` established in prose. | G6, Industry, Recon | **Must** |
| R16 | **Icon usage is consistent**: lucide only; the raw unicode glyphs in triage are replaced. | G10 | **Should** |
| **Pillar E — the triage flagship** ||||
| R17 | The job-details pane is ordered by the **decision**, per §10: score and the match/flag signals first, eligibility facts next, JD later, tracking last. | **JTBD-5**, Industry (6–7s scan) | **Must** |
| R18 | The **match score is labelled and scaled** — the number never appears without saying what it is out of. | G3, **JTBD-5** | **Must** |
| R19 | **Match reasons and review flags are visually distinct** kinds of thing, distinguishable without reading the words, and not by hue alone (R15). | G2, **JTBD-5** | **Must** |
| R20 | The job's **`lane` is surfaced** as its source, using R10's display label. No new API field. | G5, Q3 | **Must** |
| R21 | The **JD is measure-capped (45–90 characters)** and progressively disclosed, so it never buries the rest of the pane. | G4, Industry (Butterick) | **Must** |
| R22 | **Job status in the list is not colour-only** — the `title`-attribute-only dot gains a second cue. Instance of R15. | G6, **JTBD-5** | **Must** |
| R23 | The detail pane uses the shared **`Card`** component rather than hand-rolled borders, and Skip/Pass drops `variant="destructive"` — the action is reversible and must not read as destructive. | G10, Industry (reversible ≠ destructive) | **Should** |
| R24 | **`#/job/:id` is verified too** — `JobHeader`/`JobFacts` are shared, so the standalone job page must render correctly after the rebuild. | Recon §5.4 | **Must** |
| **Cross-cutting** ||||
| R25 | Existing **Playwright e2e selectors keep passing**; any intentionally changed selector is updated in the same change. | **Stability** | **Must** |
| R26 | `j`/`k` list navigation in triage. | Industry (vi/Gmail/Linear) | **Could** |
| R27 | An **undo affordance** on a triage decision. | — | **Won't** *(decisions are already reversible in place — `DecideBar` keeps every button live; an undo toast would add a mechanism for a problem that does not exist)* |
| R28 | A **custom spacing scale**. | — | **Won't** *(Tailwind's 4px grid is already a scale and is already documented in prior UX notes; a bespoke one is flexibility nobody asked for)* |
| R29 | **Multi-select / bulk triage.** | — | **Won't** *(Linear explicitly ships triage without it; the queue is ~11 jobs, not 500)* |
| R30 | A **theme toggle**. | — | **Won't** *(Q1: OS-following is sufficient; a toggle is scope, not a gap)* |
| R31 | **Storybook or an in-app component gallery.** | — | **Won't** *(Q4: a team artefact; this persona would never open it)* |
| R32 | **Renaming any stage name, tracking status, or excitement level.** | — | **Won't** *(frozen — Notion select strings are byte-exact; the glossary mirrors them)* |
| R33 | **Redesigning the layout or IA of the seven non-triage screens.** | — | **Won't** *(R13 is adoption only; `settings-overhaul` shipped that IA four days ago)* |

### Blast-radius review

Per the stability principle. Nothing here touches `pipeline/`, `runner/`, `adapters/`, or `ports/`.

| Req | Touches | Blast radius | Failure mode to review |
|---|---|---|---|
| R13/R14 | all 281 `ui/src` files | **Medium — the largest risk in this spec.** A mechanical sweep across every screen. | A type-utility swap that changes layout on a screen nobody re-checked. Must be verified screen by screen against the shipped UI, not assumed from a passing typecheck. R25 is the guard. |
| R8 | `ui/src/lib/vocabulary/`, possibly importing `src/core/tracking/vocab.ts` | **Low-medium.** | The `ui/` → `core` seam admits **dependency-free modules only**. `vocab.ts` imports nothing (confirmed by read) — but if that ever changes, `ui:build` breaks rather than `npm run check`. product-ui confirms; **PROVISIONAL**. |
| R9 | a new Vitest source-scan | **Low**, but see §9. | A list that false-positives on ordinary prose gets disabled, taking the whole glossary pillar with it. Dry-run the list before shipping the gate. |
| R2/R3 | `index.css`, `tokens.test.ts` | **Low.** | A token added to `:root` but not `.dark` renders unstyled at night — the exact class of bug G8 exists to prevent. The test must pin both. |
| R17–R23 | `ui/src/features/job/`, `ui/src/features/triage/` | **Low** on the pipeline; **medium** on delivery. | `JobHeader`/`JobFacts` are shared with `#/job/:id` (R24). Files near the 400-line cap may need the two-pair split. |

**No pipeline change, no schema change, no new endpoint.** product-ui confirms feasibility; these
ratings are **provisional**.

---

## 12. Acceptance Criteria

Objectively checkable. Each maps to a requirement; the first seven are one per design-system pillar.

1. **Colour.** Every foreground/background token pair used for text meets **4.5:1 in light and in
   dark**; the check is automated and listed pair by pair. A pair that fails is a build failure, not a
   note. *(R2)*
2. **Type scale.** `ui/src/index.css` defines the scale as tokens; **no `text-[Npx]` arbitrary value
   remains anywhere in `ui/src/**`**; every type step in the token set is used by at least one screen.
   *(R1, R14)*
3. **Voice.** The reference document states the ~6 rules; every **button label** added or changed by
   this slice is an imperative verb in sentence case. *(R6)*
4. **Glossary.** For each concept in the glossary, **exactly one** user-visible word is used across
   `ui/src/**`; introducing a banned synonym into any user-visible string **fails `npm run check`**.
   Demonstrated by adding one and observing the failure. *(R7, R9)*
5. **Tokens as code.** `ui/src/lib/tokens.test.ts` pins every token in the reference document, in both
   modes; editing a token value in `index.css` without updating the document (or vice versa) fails the
   test. **No new dependency appears in `ui/package.json`.** *(R3, R4)*
6. **Every-screen adoption.** All eight screens import the type tokens and the vocabulary module.
   **Regression guard:** the full Playwright e2e suite passes, and no screen other than triage and
   `#/job/:id` changes layout — verified by inspection against the shipped UI. *(R13, R25, R33)*
7. **Triage job-details.** With a job selected, the pane presents, in order: the match score **with
   its scale stated**; match reasons and review flags as **visually distinct** kinds of thing; the
   eligibility facts as separable values; the job's **source lane** by display name; the JD
   measure-capped and progressively disclosed; the tracking fields last. *(R17–R21)*
8. The triage buttons read **"Pass"** and **"Lead"**; the status badge shown after a decision uses the
   same word as the button pressed; the `a` / `x` / `s` shortcuts still work and their hints match the
   new labels. *(R11, R12)*
9. No user-visible string anywhere renders a raw lane identifier (`linkedin`, `greenhouse`, `keka`).
   *(R10)*
10. No status, outcome, or state anywhere in the product is distinguishable **only** by hue — each has
    a second cue in shape, weight, or text. Checkable by rendering greyscale. *(R15, R22)*
11. No raw unicode glyph is used as an icon in `ui/src/**`; icons are lucide. *(R16)*
12. `#/job/:id` renders correctly after the rebuild, with the same field ordering as the triage pane.
    *(R24)*
13. The triage detail pane uses the shared `Card` component; no triage action uses
    `variant="destructive"`. *(R23)*
14. **Regression, non-negotiable:** the board still binds `127.0.0.1` only; no new API route, request
    field, or database column is introduced; the only job write remains
    `PATCH /api/profiles/:name/jobs/:id/tracking`. *(Hard constraint)*
15. `npm run check` and `npm run ui:check` pass, and no file exceeds the 400-line implementation cap.
    *(R25, Stability)*

---

## 13. Success Metrics

Observable outcomes, deliberately not counts of tokens shipped.

1. **The system is the path of least resistance.** The *next* feature built after this ships uses the
   type tokens and the vocabulary module without anyone being reminded to. Directly observable at the
   next epic. If it doesn't, the system is documentation with extra steps.
2. **The next design artefact cites rather than re-recons.** Both existing mockups re-derived tokens
   from `index.css` and drifted (§1). The next `ux-notes.md` should cite R4's reference document
   instead. This is the metric that targets G9 directly.
3. **The triage decide loop shortens in practice** — the user works through a batch without opening
   the original posting URL for jobs he passes on. The "lean-no" case should be answerable in-pane.
   *Honest caveat: n=1 and uninstrumented; this is observed, not measured.*
4. **Dark mode stops being unverified.** The user reads the board at night without reaching for the
   OS setting to make it legible.
5. **Counter-metric (guards against system bloat):** the number of tokens is **not** a success measure.
   If the type scale grows past its named steps within the next two features, the scale was wrong —
   fix the scale, don't add steps.
6. **Counter-metric (guards against adoption over-reach):** if the user *notices* that a design system
   shipped on any screen other than triage, R13 exceeded its mandate. The other seven screens should
   look like themselves.
7. **Counter-metric (the honest one):** if the banned-synonym list is ever emptied or the scan skipped,
   the glossary pillar has failed — regardless of what the document still says. Check the list's
   contents, not the test's green tick.

---

## 14. Out of Scope

| Excluded | Reason |
|---|---|
| **Scraped compensation / salary display** | Requires pipeline and schema change; not captured at any layer. **Named explicitly because research makes it the single strongest finding about job-posting decisions — 60% of seekers won't apply without a range.** This is a real product gap this spec cannot close, recorded so it is deferred by decision rather than by oversight. Candidate for its own spec. |
| **Storybook / in-app component gallery** | Q4. A team artefact; this persona would never open it. R4's document plus the token test does the same job at a fraction of the cost. |
| **A theme toggle** | Q1. The app already follows the OS colour scheme; a toggle is a new control, not a gap. |
| **A prose-linter dependency** (Vale, textlint, alex, `eslint-plugin-i18next`) | The repo deliberately holds runtime deps at three; `tokens.test.ts` proves a zero-dependency source-scan is sufficient at this scale. |
| **A custom spacing scale** | Tailwind's 4px grid is already a scale and is already documented. Bespoke spacing is flexibility nobody asked for. |
| **Renaming stage names, tracking statuses, or excitement levels** | Frozen. Notion select option strings are byte-exact (CLAUDE.md); a rename breaks sync. The glossary mirrors them. |
| **Redesigning the layout or IA of the seven non-triage screens** | R13 is token and word adoption only. The settings IA shipped four days ago; re-opening it would be churn. |
| **Multi-select / bulk triage** | Linear ships triage without it; the queue is ~11 jobs. |
| **Undo toasts on triage decisions** | Decisions are already reversible in place. |
| **Analytics or instrumentation to measure the decide loop** | Would be the only honest way to measure metric 3, but it means new storage and a new write path on a single-user tool. Not worth it; the caveat in §13 is the honest alternative. |
| **Any pipeline, schema, or new-endpoint work** | Hard constraint from the ask and from `ports/board.ts`. |
| **Multi-user concerns** — theming per user, accessibility settings UI, i18n | Single-user tool. Assuming a second human is waste. |

---

## 15. Four-Risks Scorecard

Cagan's four risks. Feasibility is **PROVISIONAL** — product-pm has no engineering tools; product-ui
confirms.

| Risk | Score | Rationale |
|---|---|---|
| **Value** — will they use it? | **Medium** | *Non-top score, and deliberately so.* Zero leads gained, and two of the four requested pillars are largely pre-satisfied — a spec treating them as equal work would be inventing scope. What holds the score at Medium rather than Weak is that the value is **not evenly distributed**: the triage half serves JTBD-5, the primary persona's most-repeated job, and its defects (identical rendering of opposite signals, an unlabelled score, a buried JD) are **functional, not cosmetic**. The design-system half is genuinely weaker and its main defence — enforcement prevents drift — has a counter-example in this repo (§7.1). Read this as *"the triage rebuild is worth doing and the system is the cheap way to keep it from rotting"*, not as *"a design system is worth building."* |
| **Usability** — can they figure it out? | **Medium — OPEN, handed to UX** | Deliberately unresolved here. Open concerns for product-ux: **(a)** how to make match reasons and review flags read as different *kinds* of thing without using hue alone (R15 forbids the obvious green/red answer, and this is the flagship's central visual problem); **(b)** how much JD to show before disclosure — too little forces a click on every job, too much reproduces today's burial (R21); **(c)** how the score's scale is stated without the label becoming noise on every row *and* in the detail pane (R18); **(d)** the second cue for job status in a 6px list dot, where shape and weight have very little room (R22); **(e)** whether the eligibility facts become a label/value list, chips, or a compact row — research offers definition lists and chips as alternatives with no clear winner at this density; **(f)** dark mode, which no mockup has ever covered — **the mockup for this spec should show it**, since it is a live surface and G8 is one of the four things that survived the case against. |
| **Feasibility** — can we build it? | **Medium-Strong — PROVISIONAL** | Most of this is mechanical and the repo hands us the pattern: `tokens.test.ts` is already a zero-dependency source-scan, so R3 and R9 extend a shipped idiom rather than invent one. `src/core/tracking/vocab.ts` imports nothing, so the glossary's import path is open. The uncertainty is concentrated in three places: **R13/R14** touch all 281 files and can break layout or Playwright selectors in ways a typecheck won't catch; **file-size headroom is gone** — `DaemonCard.tsx` is at exactly 400 lines and the vocabulary module adds imports everywhere, so the two-pair split rule may bind; and **R9's list must be dry-run first**, because a noisy gate is a deleted gate. |
| **Viability** — does it work long-term? | **Medium** | *Non-top score, and the lowest alongside Value.* No revenue or compliance surface, so viability is maintenance cost against a strict architecture. This epic **adds ongoing cost in three places**: every new colour token now costs two definitions plus two test rows (the price of Q1's keep-dark-mode ruling); the vocabulary module adds an indirection every new screen must remember; and the banned-synonym list needs curation forever. Against that, it **removes** cost: the drift that two mockups and 279 ad-hoc type utilities represent is itself unbounded maintenance. The honest read is that this trades diffuse, invisible cost for concentrated, visible cost — usually a good trade, but a trade rather than a saving, and its durability depends entirely on the §9 assumption holding. |

### Named weaknesses — this scorecard is not a clean sweep

1. **The spec's central claim has a counter-example inside the repo it describes.** "Enforcement
   prevents drift" is evidenced by the colour-vs-type contrast — but the two **mockups** drifted in
   colour token naming anyway, because they sit outside the test's reach. Enforcement holds exactly as
   far as its scan reaches. R4's machine-checked document narrows this; it does not close it, and
   nothing in this spec can enforce anything about a future mockup.
2. **Two of the four requested pillars were largely already satisfied.** Colour is shipped, dual-mode
   and test-pinned; casing is already consistent. The ask's framing overestimates the gap, and this
   spec's main act of discipline was declining to fill it with invented work. A reviewer should check
   that judgement rather than inherit it.
3. **No design-system value evidence exists for n=1.** Every source in §3 assumes a team. Every
   persona-fit judgement in the system half of this spec is reasoning from our own persona doc, not
   from literature — and the persona doc's own rule (*"anything that assumes a second human is
   waste"*) cuts against it.
4. **The triage hierarchy is transferred, not sourced in-domain.** No ATS or job board publishes a
   design system and no job-board triage usability study was found. The 6–7 second scan, the field
   ordering, and the disclosure model come from generic review queues (Linear, GitHub, Gmail) plus
   recruiting-side job-ad guidance — which describes what employers are *told to write*, not what
   seekers are *observed to read*. **product-ux inherits this flag and should treat §10's ordering as
   a hypothesis, not a finding.**
5. **The flagship's success is unmeasurable as specified.** Metric 3 is observed, not measured, and
   §14 deliberately declines the instrumentation that would fix it. If the rebuild made triage
   *slower*, this spec has no mechanism that would tell us.
6. **The single most decision-relevant field is missing and stays missing.** Research's strongest
   finding is that 60% of seekers won't apply without a salary range. Job Bunny captures none, and
   this spec cannot add it without the schema change the ask forbids. **We are optimising the
   information hierarchy of a pane whose most important field is absent** — the ordering work is still
   correct, but its ceiling is set by a gap it cannot touch.
7. **`R13` is the riskiest requirement and the least interesting one.** Sweeping 281 files for token
   adoption is where a regression will come from if one comes, and it is the part of the work with the
   least visible payoff — precisely the combination that invites a rushed job at the end of the slice.
   If the epic runs long, the correct cut is **fewer screens adopted, fully verified**, never all
   eight adopted and spot-checked.
